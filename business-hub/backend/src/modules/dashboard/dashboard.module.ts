import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Roles } from '../auth/auth.decorators';

const TIER_WEIGHT = { REGULATED: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  // Brief 12.2: completed outcomes on top, health indicators in the middle, and only decisions that
  // need owner authority as the action list. Routine completions are never listed as interruptions.
  @Roles('OWNER')
  @Get('owner')
  async owner() {
    const db = this.prisma.db;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [closed, systemActions, openByTier, overdue, deadJobs, pendingApprovals, ownerExceptions, ownerApprovals] = await Promise.all([
      db.workflowInstance.groupBy({ by: ['definitionKey'], where: { closed: true, updatedAt: { gte: since } }, _count: true }),
      db.auditEvent.groupBy({ by: ['action'], where: { actorType: 'SYSTEM', createdAt: { gte: since }, outcome: 'SUCCESS', entityType: { not: 'http' } }, _count: true }),
      db.exception.groupBy({ by: ['riskTier'], where: { status: { in: ['NOTIFIED', 'ASSIGNED'] } }, _count: true }),
      db.exception.count({ where: { status: 'NOTIFIED', deadline: { lt: new Date() } } }),
      db.integrationJob.count({ where: { status: 'DEAD' } }),
      db.approval.count({ where: { status: 'PENDING' } }),
      db.exception.findMany({ where: { ownerRole: 'OWNER', status: 'NOTIFIED' }, take: 50 }),
      db.approval.findMany({ where: { approverRole: 'OWNER', status: 'PENDING' }, take: 50 }),
    ]);

    const decisions = [
      ...ownerExceptions.map((e) => ({
        type: 'exception' as const,
        id: e.id,
        title: e.code,
        reason: e.reason,
        impact: e.impact,
        amount: e.amount ? Number(e.amount) : null,
        riskTier: e.riskTier,
        deadline: e.deadline,
        actions: e.availableActions,
      })),
      ...ownerApprovals.map((a) => ({
        type: 'approval' as const,
        id: a.id,
        title: a.action,
        reason: `${a.subjectType} ${a.subjectId}`,
        impact: null,
        amount: a.amount ? Number(a.amount) : null,
        riskTier: 'HIGH' as const,
        deadline: null,
        actions: ['approve', 'reject'],
      })),
    ]
      .sort((x, y) => TIER_WEIGHT[y.riskTier] - TIER_WEIGHT[x.riskTier] || (y.amount ?? 0) - (x.amount ?? 0))
      .slice(0, 10);

    return {
      since,
      outcomes: {
        workflowsCompleted: closed.map((c) => ({ workflow: c.definitionKey, count: c._count })),
        automatedActions: systemActions.map((s) => ({ action: s.action, count: s._count })),
      },
      health: {
        openExceptionsByTier: Object.fromEntries(openByTier.map((o) => [o.riskTier, o._count])),
        overdueExceptions: overdue,
        pendingApprovals,
        deadLetterJobs: deadJobs,
      },
      decisions,
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
