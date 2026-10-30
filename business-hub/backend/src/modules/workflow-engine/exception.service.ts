import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExceptionStatus, RiskTier } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentContext, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { roleVisibility } from '../../common/tenancy/visibility';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { PolicyService } from '../policy-engine/policy.service';

// Brief 12.1 lifecycle. Detected > classified > assigned > notified > decision > executed/retried > verified > archived.
const NEXT: Record<ExceptionStatus, ExceptionStatus[]> = {
  DETECTED: ['CLASSIFIED'],
  CLASSIFIED: ['ASSIGNED'],
  ASSIGNED: ['NOTIFIED'],
  NOTIFIED: ['RESOLVED', 'APPROVED', 'REJECTED'],
  RESOLVED: ['EXECUTED', 'VERIFIED'],
  APPROVED: ['EXECUTED'],
  REJECTED: ['VERIFIED', 'ARCHIVED'],
  EXECUTED: ['RETRIED', 'VERIFIED'],
  RETRIED: ['EXECUTED', 'VERIFIED'],
  VERIFIED: ['ARCHIVED'],
  ARCHIVED: [],
};

const SLA_HOURS: Record<RiskTier, number> = { LOW: 72, MEDIUM: 24, HIGH: 8, REGULATED: 8 };

export interface RaiseExceptionInput {
  workflowId?: string;
  code: string;
  reason: string;
  evidence?: Record<string, unknown>;
  impact?: string;
  amount?: number;
  riskTier?: RiskTier;
  branchId?: string;
  // Route by explicit role, or let a policy pick the lowest authorized role.
  ownerRole?: string;
  policyKey?: string;
  availableActions?: string[];
}

@Injectable()
export class ExceptionService {
  private readonly log = new Logger(ExceptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async raise(input: RaiseExceptionInput) {
    let ownerRole = input.ownerRole;
    let route: string[] = [];
    let ownerEscalated = false;
    let tier = input.riskTier ?? 'MEDIUM';
    if (!ownerRole) {
      if (!input.policyKey) throw new BadRequestException('Exception needs ownerRole or policyKey for routing');
      const d = await this.policy.evaluate(input.policyKey, { amount: input.amount, branchId: input.branchId });
      ownerRole = d.approverRole ?? 'OWNER';
      route = d.escalationRoute;
      ownerEscalated = d.ownerEscalated;
      tier = input.riskTier ?? d.tier;
    } else {
      route = [ownerRole, ...(ownerRole === 'OWNER' ? [] : ['OWNER'])];
      ownerEscalated = ownerRole === 'OWNER';
    }
    const now = new Date();
    const hist = (s: ExceptionStatus) => ({ status: s, at: now.toISOString() });

    return this.prisma.db.$transaction(async (tx) => {
      const ex = await tx.exception.create({
        data: {
          tenantId: '',
          workflowId: input.workflowId ?? null,
          code: input.code,
          reason: input.reason,
          evidence: (input.evidence ?? {}) as any,
          impact: input.impact ?? null,
          amount: input.amount ?? null,
          riskTier: tier,
          // Detected, classified, assigned and notified happen atomically for system-raised exceptions.
          status: 'NOTIFIED',
          ownerRole,
          branchId: input.branchId ?? null,
          deadline: new Date(now.getTime() + SLA_HOURS[tier] * 3_600_000),
          availableActions: (input.availableActions ?? ['resolve', 'approve', 'reject']) as any,
          escalationRoute: route as any,
          ownerEscalated,
          history: (['DETECTED', 'CLASSIFIED', 'ASSIGNED', 'NOTIFIED'] as ExceptionStatus[]).map(hist) as any,
        },
      });
      await tx.task.create({
        data: { tenantId: '', workflowId: input.workflowId ?? null, title: `${input.code}: ${input.reason}`, assigneeRole: ownerRole, branchId: input.branchId ?? null, dueAt: ex.deadline },
      });
      await this.notifications.notify({ roleKey: ownerRole, title: `Exception ${input.code}`, body: input.reason }, tx);
      await this.audit.record({ action: 'exception.raised', entityType: 'Exception', entityId: ex.id, after: ex }, tx);
      return ex;
    });
  }

  async transition(id: string, to: ExceptionStatus, comment?: string, actor?: RequestUser) {
    const ex = await this.prisma.db.exception.findFirst({ where: { id } });
    if (!ex) throw new NotFoundException('Exception not found');
    if (!NEXT[ex.status].includes(to)) throw new BadRequestException(`Cannot move exception from ${ex.status} to ${to}`);
    return this.prisma.db.$transaction(async (tx) => {
      const res = await tx.exception.updateMany({
        where: { id, status: ex.status },
        data: {
          status: to,
          resolution: comment ?? ex.resolution,
          history: [...(ex.history as any[]), { status: to, at: new Date().toISOString(), by: actor?.id ?? currentContext()?.user?.id ?? 'system', comment }],
        },
      });
      if (res.count !== 1) throw new BadRequestException('Exception changed concurrently');
      await this.audit.record(
        { action: 'exception.transition', entityType: 'Exception', entityId: id, before: { status: ex.status }, after: { status: to, comment } },
        tx,
      );
      return tx.exception.findFirstOrThrow({ where: { id } });
    });
  }

  async assertVisible(user: RequestUser, id: string) {
    const ex = await this.prisma.db.exception.findFirst({ where: { id, OR: roleVisibility(user, 'ownerRole') } });
    if (!ex) throw new NotFoundException('Exception not found');
    return ex;
  }

  async get(id: string) {
    const ex = await this.prisma.db.exception.findFirst({ where: { id }, include: { approvals: true } });
    if (!ex) throw new NotFoundException('Exception not found');
    return ex;
  }

  list(user: RequestUser, filter: { status?: ExceptionStatus; open?: boolean }) {
    const open: ExceptionStatus[] = ['DETECTED', 'CLASSIFIED', 'ASSIGNED', 'NOTIFIED'];
    return this.prisma.db.exception.findMany({
      where: {
        OR: roleVisibility(user, 'ownerRole'),
        status: filter.status ?? (filter.open ? { in: open } : undefined),
      },
      orderBy: [{ riskTier: 'desc' }, { deadline: 'asc' }],
      take: 200,
    });
  }

  // SLA escalation: an overdue exception moves up its route; only the final step reaches the owner.
  async escalateOverdue() {
    const now = new Date();
    const overdue = await this.prisma.db.exception.findMany({ where: { status: 'NOTIFIED', deadline: { lt: now } } });
    let n = 0;
    for (const ex of overdue) {
      const route = ex.escalationRoute as string[];
      const idx = route.indexOf(ex.ownerRole ?? '');
      const next = route[idx + 1];
      if (!next) continue;
      await this.prisma.db.exception.updateMany({
        where: { id: ex.id, ownerRole: ex.ownerRole },
        data: {
          ownerRole: next,
          ownerEscalated: next === 'OWNER',
          deadline: new Date(now.getTime() + SLA_HOURS[ex.riskTier] * 3_600_000),
          history: [...(ex.history as any[]), { status: ex.status, at: now.toISOString(), escalatedTo: next }],
        },
      });
      await this.notifications.notify({ roleKey: next, title: `Escalated: ${ex.code}`, body: ex.reason });
      await this.audit.record({ action: 'exception.escalated', entityType: 'Exception', entityId: ex.id, after: { ownerRole: next } });
      n++;
    }
    return n;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async escalationSweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) {
      await runWithTenant(t.id, () => this.escalateOverdue()).catch((e) => this.log.error(`escalation failed for ${t.id}: ${e.message}`));
    }
  }
}
