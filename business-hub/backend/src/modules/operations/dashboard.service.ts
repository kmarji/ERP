import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { branchFilter } from './scope';

const DAY = 86_400_000;
const OPEN_ACTION = ['OPEN', 'IN_PROGRESS'];

// A47: one row per branch the caller may see. Counts only; the detail screens own the detail.
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async branches(user: RequestUser, branchId?: string) {
    const scope = branchFilter(user, branchId);
    return this.prisma.db.branch.findMany({ where: { active: true, ...(scope.branchId ? { id: scope.branchId as any } : {}) }, orderBy: { name: 'asc' } });
  }

  async dashboard(user: RequestUser, branchId?: string) {
    const branches = await this.branches(user, branchId);
    const ids = branches.map((b) => b.id);
    const now = new Date();
    const week = new Date(now.getTime() - 7 * DAY);
    const month = new Date(now.getTime() - 30 * DAY);
    const [runs, actions, breaches, audits, assignments] = await Promise.all([
      this.prisma.db.checklistRun.findMany({ where: { branchId: { in: ids }, dueAt: { gte: week } }, select: { branchId: true, status: true, completedLate: true, criticalFailures: true } }),
      this.prisma.db.correctiveAction.findMany({ where: { branchId: { in: ids }, status: { in: [...OPEN_ACTION, 'PENDING_VERIFICATION'] } }, select: { branchId: true, status: true, dueAt: true, severity: true } }),
      this.prisma.db.foodSafetyReading.findMany({ where: { branchId: { in: ids }, inRange: false, takenAt: { gte: week } }, select: { branchId: true } }),
      this.prisma.db.auditRecord.findMany({ where: { branchId: { in: ids }, status: 'COMPLETED', completedAt: { gte: month } }, orderBy: { completedAt: 'desc' }, select: { branchId: true, scorePct: true, passed: true, completedAt: true } }),
      this.prisma.db.employeeAssignment.findMany({ where: { branchId: { in: ids }, OR: [{ validTo: null }, { validTo: { gte: now } }] }, select: { branchId: true, employeeId: true } }),
    ]);
    const empBranch = new Map<string, string>();
    for (const a of assignments) if (!empBranch.has(a.employeeId)) empBranch.set(a.employeeId, a.branchId);
    const training = await this.prisma.db.trainingAssignment.findMany({ where: { itemCode: { not: null }, employeeId: { in: [...empBranch.keys()] } }, select: { employeeId: true, status: true, dueDate: true } });

    const rows = branches.map((b) => {
      const r = runs.filter((x) => x.branchId === b.id);
      const done = r.filter((x) => ['COMPLETED', 'REVIEWED'].includes(x.status));
      const a = actions.filter((x) => x.branchId === b.id);
      const t = training.filter((x) => empBranch.get(x.employeeId) === b.id);
      const openT = t.filter((x) => ['ASSIGNED', 'IN_PROGRESS', 'EXAM_PENDING'].includes(x.status));
      const lastAudit = audits.find((x) => x.branchId === b.id);
      return {
        branchId: b.id, name: b.name,
        checklists: { total: r.length, overdue: r.filter((x) => x.status === 'OVERDUE').length, criticalFailures: r.reduce((s, x) => s + x.criticalFailures, 0), compliancePct: r.length ? Math.round((done.filter((x) => !x.completedLate && !x.criticalFailures).length / r.length) * 100) : null },
        actions: { open: a.filter((x) => OPEN_ACTION.includes(x.status)).length, overdue: a.filter((x) => OPEN_ACTION.includes(x.status) && x.dueAt && x.dueAt < now).length, pendingVerification: a.filter((x) => x.status === 'PENDING_VERIFICATION').length, critical: a.filter((x) => x.severity === 'CRITICAL').length },
        foodSafety: { breaches7d: breaches.filter((x) => x.branchId === b.id).length },
        audits: { last: lastAudit ? { scorePct: lastAudit.scorePct, passed: lastAudit.passed, at: lastAudit.completedAt } : null, failed30d: audits.filter((x) => x.branchId === b.id && !x.passed).length },
        training: { open: openT.length, overdue: openT.filter((x) => x.dueDate && x.dueDate < now).length, failed: t.filter((x) => x.status === 'FAILED').length, passed: t.filter((x) => x.status === 'PASSED').length },
      };
    });
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    return {
      generatedAt: now.toISOString(),
      totals: { overdueChecklists: sum((r) => r.checklists.overdue), criticalFailures: sum((r) => r.checklists.criticalFailures), openActions: sum((r) => r.actions.open), overdueActions: sum((r) => r.actions.overdue), pendingVerification: sum((r) => r.actions.pendingVerification), breaches7d: sum((r) => r.foodSafety.breaches7d), failedAudits30d: sum((r) => r.audits.failed30d), overdueTraining: sum((r) => r.training.overdue) },
      branches: rows,
    };
  }
}
