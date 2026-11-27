import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { minutes, weekBounds } from './common';
import { WeekService } from './week.service';

const CODE = 'SCHEDULE_OVER_HOURS';
const REVIEWERS = ['OWNER', 'HR'] as const;
export const COUNTED_SHIFTS = ['PUBLISHED', 'PENDING_APPROVAL'];

// One escalation per employee per week while that week is scheduled over the limit and nobody has approved it.
@Injectable()
export class OverHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly weeks: WeekService,
    private readonly exceptions: ExceptionService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // Scheduled minutes of one employee's week, across all branches.
  private async week(employeeId: string, date: Date, ignoreId?: string) {
    const wk = weekBounds(date, await this.weeks.startsOn());
    const shifts = await this.prisma.db.shiftSchedule.findMany({ where: { employeeId, status: { in: COUNTED_SHIFTS }, date: { gte: wk.start, lte: wk.end }, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });
    const { rules } = await this.rules.activeFor(date);
    const weekStart = wk.start.toISOString().slice(0, 10);
    return { weekStart, key: `${employeeId}:${weekStart}`, minutes: shifts.reduce((s, x) => s + minutes(x.startAt, x.endAt), 0), limit: rules.scheduling.maxWeeklyMinutes };
  }

  private rows(key: string, status: 'NOTIFIED' | 'APPROVED') {
    return this.prisma.db.exception.findMany({ where: { code: CODE, status, evidence: { path: ['key'], equals: key } }, orderBy: { createdAt: 'desc' } });
  }

  private async approvedMinutes(key: string): Promise<number> {
    return ((await this.rows(key, 'APPROVED'))[0]?.evidence as any)?.approvedMinutes ?? 0;
  }

  // Refuses a shift that takes the week past the limit, unless a reason is given or that many hours are approved.
  async check(employeeId: string, date: Date, addedMinutes: number, ignoreId: string | undefined, hasReason: boolean) {
    const w = await this.week(employeeId, date, ignoreId);
    const total = w.minutes + addedMinutes;
    if (total <= w.limit || hasReason || total <= (await this.approvedMinutes(w.key))) return;
    throw new ConflictException(`Exceeds the weekly maximum of ${w.limit / 60} hours (this week would be ${+(total / 60).toFixed(2)} h). Give a reason to save anyway.`);
  }

  // Brings the escalation in line with the schedule; call after any change to an employee's shifts.
  async sync(employeeId: string, date: Date, by?: { userId: string; reason: string }) {
    const w = await this.week(employeeId, date);
    const open = (await this.rows(w.key, 'NOTIFIED'))[0];
    if (w.minutes <= w.limit || w.minutes <= (await this.approvedMinutes(w.key))) {
      if (open) await this.exceptions.transition(open.id, 'RESOLVED', 'The week is back within the allowed hours');
      return;
    }
    if (!open && !by) return;
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: employeeId } });
    const reason = `${emp.name}: ${+(w.minutes / 60).toFixed(2)} h scheduled in the week of ${w.weekStart}, above the ${w.limit / 60} h limit`;
    const before = (open?.evidence ?? {}) as { reasons?: string[]; scheduledBy?: string[] };
    const evidence = {
      key: w.key, employeeId, employeeName: emp.name, weekStart: w.weekStart, minutes: w.minutes, limitMinutes: w.limit,
      reasons: [...(before.reasons ?? []), ...(by ? [by.reason] : [])],
      scheduledBy: [...new Set([...(before.scheduledBy ?? []), ...(by ? [by.userId] : [])])],
    };
    if (open) {
      await this.prisma.db.exception.updateMany({ where: { id: open.id }, data: { reason, evidence } });
      return;
    }
    const branch = await this.prisma.db.employeeAssignment.findFirst({ where: { employeeId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] }, orderBy: { isPrimary: 'desc' } });
    await this.exceptions.raise({ code: CODE, reason, evidence, impact: 'Hours above the limit are paid as overtime', branchId: branch?.branchId, ownerRole: 'HR', riskTier: 'MEDIUM', availableActions: [] });
    await this.notifications.notify({ roleKey: 'OWNER', title: `Exception ${CODE}`, body: reason });
  }

  // Open escalations. The generic exception list shows a role only its own, so the owner reads them here.
  async list(user: RequestUser) {
    const rows = await this.prisma.db.exception.findMany({ where: { code: CODE, status: 'NOTIFIED' }, orderBy: { createdAt: 'asc' }, take: 200 });
    return rows.filter((r) => {
      try { assertBranchAccess(user, r.branchId ?? '', REVIEWERS); return true; } catch { return false; }
    });
  }

  async decide(id: string, input: { action: 'approve' | 'instruct'; comment?: string; minutes?: number }, user: RequestUser) {
    const row = await this.prisma.db.exception.findFirst({ where: { id, code: CODE } });
    if (!row) throw new NotFoundException('Escalation not found');
    assertBranchAccess(user, row.branchId ?? '', REVIEWERS);
    if (row.status !== 'NOTIFIED') throw new ConflictException('This escalation is already closed');
    const evidence = row.evidence as any;
    const comment = input.comment?.trim();
    if (input.action === 'approve') {
      if (input.minutes !== undefined && input.minutes !== evidence.minutes) throw new ConflictException('The scheduled hours changed. Check the new total and approve again.');
      await this.prisma.db.exception.updateMany({ where: { id }, data: { evidence: { ...evidence, approvedMinutes: evidence.minutes } } });
      await this.exceptions.transition(id, 'APPROVED', comment, user);
    } else {
      if (!comment) throw new BadRequestException('Write the instruction');
      for (const userId of evidence.scheduledBy as string[]) await this.notifications.notify({ userId, title: 'Change requested to the schedule', body: `${row.reason}. ${comment}` });
      await this.prisma.db.exception.updateMany({ where: { id }, data: { history: [...(row.history as any[]), { status: row.status, at: new Date().toISOString(), by: user.id, instruction: comment }] } });
      await this.audit.record({ action: 'schedule.over_hours_instructed', entityType: 'Exception', entityId: id, after: { by: user.id, comment } });
    }
    return this.prisma.db.exception.findFirstOrThrow({ where: { id } });
  }
}
