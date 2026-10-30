import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RiskTier } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentContext } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { WorkflowRegistry } from './workflow.types';

@Injectable()
export class WorkflowEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: WorkflowRegistry,
    private readonly audit: AuditService,
  ) {}

  // Idempotent: starting the same subject twice returns the existing instance.
  async start(definitionKey: string, subjectType: string, subjectId: string, riskTier: RiskTier = 'LOW') {
    const def = this.registry.get(definitionKey);
    const existing = await this.prisma.db.workflowInstance.findFirst({ where: { definitionKey, subjectType, subjectId } });
    if (existing) return existing;
    return this.prisma.db.$transaction(async (tx) => {
      const wf = await tx.workflowInstance.create({
        data: {
          tenantId: '',
          definitionKey,
          state: def.initial,
          subjectType,
          subjectId,
          riskTier,
          correlationId: currentContext()?.correlationId ?? subjectId,
          history: [{ from: null, to: def.initial, event: 'start', at: new Date().toISOString() }],
        },
      });
      await this.audit.record({ action: 'workflow.started', entityType: 'WorkflowInstance', entityId: wf.id, after: wf }, tx);
      return wf;
    });
  }

  async get(id: string) {
    const wf = await this.prisma.db.workflowInstance.findFirst({ where: { id }, include: { tasks: true, exceptions: true } });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }

  async findBySubject(definitionKey: string, subjectType: string, subjectId: string) {
    return this.prisma.db.workflowInstance.findFirst({ where: { definitionKey, subjectType, subjectId } });
  }

  // Compare-and-set on state, so two concurrent fires cannot both succeed.
  async fire(id: string, event: string, data?: unknown) {
    const wf = await this.prisma.db.workflowInstance.findFirst({ where: { id } });
    if (!wf) throw new NotFoundException('Workflow not found');
    const def = this.registry.get(wf.definitionKey);
    if (wf.closed) throw new ConflictException(`Workflow already closed in state ${wf.state}`);
    const next = def.transitions[wf.state]?.[event];
    if (!next) throw new BadRequestException(`Event '${event}' not allowed in state '${wf.state}'`);
    const guard = def.guards?.[`${wf.state}:${event}`];
    if (guard && !(await guard(data))) throw new BadRequestException(`Guard rejected '${event}' in state '${wf.state}'`);

    const entry = { from: wf.state, to: next, event, at: new Date().toISOString(), actor: currentContext()?.user?.id ?? 'system' };
    return this.prisma.db.$transaction(async (tx) => {
      const res = await tx.workflowInstance.updateMany({
        where: { id, state: wf.state },
        data: { state: next, closed: def.terminal.includes(next), history: [...(wf.history as any[]), entry] },
      });
      if (res.count !== 1) throw new ConflictException('Workflow state changed concurrently');
      await this.audit.record(
        { action: 'workflow.transition', entityType: 'WorkflowInstance', entityId: id, before: { state: wf.state }, after: { state: next, event } },
        tx,
      );
      return tx.workflowInstance.findFirstOrThrow({ where: { id } });
    });
  }
}
