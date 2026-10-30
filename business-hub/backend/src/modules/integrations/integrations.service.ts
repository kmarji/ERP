import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentContext, currentTenantId } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';

export type IntegrationHandler = (payload: any) => Promise<unknown>;

// Domain modules register their adapter operations here (e.g. 'einvoice' / 'submit').
@Injectable()
export class IntegrationHandlers {
  private readonly map = new Map<string, IntegrationHandler>();

  register(adapter: string, operation: string, fn: IntegrationHandler) {
    this.map.set(`${adapter}:${operation}`, fn);
  }

  get(adapter: string, operation: string) {
    const h = this.map.get(`${adapter}:${operation}`);
    if (!h) throw new Error(`No handler registered for ${adapter}:${operation}`);
    return h;
  }
}

export const INTEGRATION_QUEUE = 'integration';

@Injectable()
export class IntegrationsService {
  private readonly log = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handlers: IntegrationHandlers,
    private readonly audit: AuditService,
    @InjectQueue(INTEGRATION_QUEUE) private readonly queue: Queue,
  ) {}

  // Idempotent: the same (tenant, idempotencyKey) never creates or runs a second job.
  async enqueue(input: { adapter: string; operation: string; payload: unknown; idempotencyKey: string; maxAttempts?: number }) {
    const tenantId = currentTenantId();
    let job;
    try {
      job = await this.prisma.db.integrationJob.create({
        data: {
          tenantId,
          adapter: input.adapter,
          operation: input.operation,
          payload: input.payload as any,
          idempotencyKey: input.idempotencyKey,
          correlationId: currentContext()?.correlationId ?? input.idempotencyKey,
          maxAttempts: input.maxAttempts ?? 5,
          createdBy: currentContext()?.user?.id ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.db.integrationJob.findFirstOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
      }
      throw e;
    }
    await this.dispatch(job.id, tenantId, job.maxAttempts, 0);
    return job;
  }

  private dispatch(id: string, tenantId: string, attempts: number, generation: number) {
    // BullMQ custom ids may not contain ':'; generation lets a re-dispatch bypass the dedupe of the earlier run.
    return this.queue.add(
      'run',
      { jobId: id, tenantId },
      { jobId: `ij-${id}-${generation}`, attempts, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 1000 },
    );
  }

  async execute(id: string) {
    const job = await this.prisma.db.integrationJob.findFirst({ where: { id } });
    if (!job || job.status === 'SUCCEEDED') return job?.result ?? null;
    await this.prisma.db.integrationJob.updateMany({ where: { id }, data: { status: 'RUNNING', attempts: { increment: 1 } } });
    try {
      const result = await this.handlers.get(job.adapter, job.operation)(job.payload);
      await this.prisma.db.integrationJob.updateMany({ where: { id }, data: { status: 'SUCCEEDED', result: (result ?? null) as any, lastError: null } });
      await this.audit.record({ action: 'integration.succeeded', entityType: 'IntegrationJob', entityId: id, actorType: 'SYSTEM', externalResponse: result });
      return result;
    } catch (e: any) {
      await this.prisma.db.integrationJob.updateMany({ where: { id }, data: { status: 'FAILED', lastError: String(e?.message ?? e).slice(0, 1000) } });
      throw e;
    }
  }

  async markDead(id: string, error: string) {
    await this.prisma.db.integrationJob.updateMany({ where: { id }, data: { status: 'DEAD', lastError: error.slice(0, 1000) } });
    await this.audit.record({ action: 'integration.dead_lettered', entityType: 'IntegrationJob', entityId: id, actorType: 'SYSTEM', outcome: 'FAILURE', externalResponse: { error } });
  }

  list(status?: string) {
    return this.prisma.db.integrationJob.findMany({
      where: { status: status as any },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // Manual retry of a dead-lettered job from the error dashboard.
  async retry(id: string) {
    const job = await this.prisma.db.integrationJob.findFirst({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    await this.prisma.db.integrationJob.updateMany({ where: { id }, data: { status: 'PENDING', attempts: 0, lastError: null } });
    await this.dispatch(id, job.tenantId, job.maxAttempts, Date.now());
    await this.audit.record({ action: 'integration.retried', entityType: 'IntegrationJob', entityId: id });
    return { requeued: true };
  }

  // Reconciliation sweep: jobs stuck PENDING/FAILED/RUNNING (e.g. lost on a restart) are re-dispatched.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile() {
    const cutoff = new Date(Date.now() - 10 * 60_000);
    const stuck = await this.prisma.raw.integrationJob.findMany({
      where: { status: { in: ['PENDING', 'FAILED', 'RUNNING'] }, updatedAt: { lt: cutoff } },
      take: 500,
    });
    for (const j of stuck) {
      if (j.attempts >= j.maxAttempts) {
        await this.prisma.raw.integrationJob.update({ where: { id: j.id }, data: { status: 'DEAD' } });
        continue;
      }
      await this.dispatch(j.id, j.tenantId, j.maxAttempts - j.attempts, Date.now());
    }
    if (stuck.length) this.log.warn(`reconciled ${stuck.length} stuck integration job(s)`);
    return stuck.length;
  }
}
