import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { employeeOf, MANAGERS, minutes } from './common';
import { SchedulesService } from './schedules.service';

// A19 open shifts and A20 no-show detection and coverage.
@Injectable()
export class CoverageService {
  private readonly log = new Logger(CoverageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly rules: PayrollRulesService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- open shifts

  async publish(input: { branchId: string; date: string; templateId?: string; startAt?: string; endAt?: string; notes?: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const { startAt, endAt } = await this.schedules.bounds(input);
    const row = await this.prisma.db.openShift.create({ data: { tenantId: '', branchId: input.branchId, date: new Date(`${input.date.slice(0, 10)}T00:00:00.000Z`), startAt, endAt, templateId: input.templateId ?? null, notes: input.notes ?? null, createdBy: user.id } });
    await this.audit.record({ action: 'open_shift.published', entityType: 'OpenShift', entityId: row.id, after: { branchId: input.branchId, date: input.date } });
    return row;
  }

  // Branch-scoped managers see only their own branches; an HQ-wide role (branchId null) sees all.
  list(f: { branchId?: string; status?: string }, user: RequestUser) {
    let branchId: string | { in: string[] } | undefined = f.branchId;
    if (f.branchId) assertBranchAccess(user, f.branchId, MANAGERS);
    else {
      const roles = [...user.roles.filter((r) => MANAGERS.includes(r.key as any)).map((r) => r.branchId), ...user.delegations.filter((d) => MANAGERS.includes(d.roleKey as any)).map((d) => d.branchId)];
      if (!roles.includes(null)) branchId = { in: roles as string[] };
    }
    return this.prisma.db.openShift.findMany({ where: { branchId, status: f.status ?? 'OPEN' }, include: { requests: true }, orderBy: { startAt: 'asc' }, take: 200 });
  }

  async cancel(id: string, user: RequestUser) {
    const o = await this.getOpen(id);
    assertBranchAccess(user, o.branchId, MANAGERS);
    await this.prisma.db.openShift.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CANCELLED' } });
    return { cancelled: true };
  }

  private async getOpen(id: string) {
    const o = await this.prisma.db.openShift.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Open shift not found');
    return o;
  }

  // Role, branch, leave, overlap, rest and weekly-hours checks are the schedule's own `validate`.
  private async eligible(o: { branchId: string; date: Date; startAt: Date; endAt: Date }, employeeId: string) {
    try { await this.schedules.validate(employeeId, o.branchId, o.date, o.startAt, o.endAt); return null; } catch (e: any) { return e.message as string; }
  }

  async mine(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const branches = (await this.prisma.db.employeeAssignment.findMany({ where: { employeeId: me.id, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.branchId);
    const open = await this.prisma.db.openShift.findMany({ where: { status: 'OPEN', branchId: { in: branches }, startAt: { gt: new Date() } }, orderBy: { startAt: 'asc' } });
    const out = [];
    for (const o of open) if (!(await this.eligible(o, me.id))) out.push(o);
    return out;
  }

  async request(id: string, user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const o = await this.getOpen(id);
    if (o.status !== 'OPEN') throw new ConflictException(`Open shift is ${o.status}`);
    const why = await this.eligible(o, me.id);
    if (why) throw new ConflictException(why);
    try {
      return await this.prisma.db.openShiftRequest.create({ data: { tenantId: '', openShiftId: id, employeeId: me.id } });
    } catch {
      throw new ConflictException('You already requested this shift');
    }
  }

  async assign(id: string, employeeId: string, user: RequestUser) {
    const o = await this.getOpen(id);
    assertBranchAccess(user, o.branchId, MANAGERS);
    if (o.status !== 'OPEN') throw new ConflictException(`Open shift is ${o.status}`);
    const sched = await this.schedules.create({ employeeId, branchId: o.branchId, date: o.date.toISOString(), startAt: o.startAt.toISOString(), endAt: o.endAt.toISOString(), notes: o.notes ?? undefined }, user, { skipApproval: true });
    await this.prisma.db.openShift.updateMany({ where: { id }, data: { status: 'FILLED', scheduleId: sched.id } });
    await this.prisma.db.openShiftRequest.updateMany({ where: { openShiftId: id, employeeId }, data: { status: 'ASSIGNED' } });
    await this.prisma.db.openShiftRequest.updateMany({ where: { openShiftId: id, employeeId: { not: employeeId }, status: 'PENDING' }, data: { status: 'REJECTED' } });
    await this.audit.record({ action: 'open_shift.assigned', entityType: 'OpenShift', entityId: id, after: { employeeId, scheduleId: sched.id } });
    return sched;
  }

  // ---------------------------------------------------------------- no-show

  // A flag, never a disciplinary finding: it raises an exception for the manager and stops there.
  async flagNoShows(now: Date = new Date()) {
    const { rules } = await this.rules.activeFor(now);
    const grace = rules.lateness.graceMinutes;
    const cutoff = new Date(now.getTime() - grace * 60_000);
    const due = await this.prisma.db.shiftSchedule.findMany({ where: { status: 'PUBLISHED', noShowAt: null, startAt: { lte: cutoff, gte: new Date(now.getTime() - 24 * 3_600_000) } } });
    let n = 0;
    for (const s of due) {
      if (await this.prisma.db.timeEntry.findFirst({ where: { employeeId: s.employeeId, OR: [{ scheduleId: s.id }, { clockIn: { gte: new Date(s.startAt.getTime() - 3 * 3_600_000), lte: s.endAt } }] } })) continue;
      if (await this.prisma.db.leaveRequest.findFirst({ where: { employeeId: s.employeeId, status: 'APPROVED', startDate: { lte: s.date }, endDate: { gte: s.date } } })) continue;
      const { count } = await this.prisma.db.shiftSchedule.updateMany({ where: { id: s.id, noShowAt: null }, data: { noShowAt: now } });
      if (!count) continue; // exactly one exception per shift
      const emp = await this.prisma.db.employee.findFirst({ where: { id: s.employeeId } });
      await this.exceptions.raise({ code: 'ATT_NO_SHOW', reason: `${emp?.name ?? 'An employee'} has not clocked in for the shift starting ${s.startAt.toISOString()}`, evidence: { scheduleId: s.id, employeeId: s.employeeId }, impact: 'The shift is uncovered. This is a flag, not a disciplinary finding.', branchId: s.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW', availableActions: ['resolve'] });
      n++;
    }
    return n;
  }

  @Cron('*/10 * * * *')
  async sweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.flagNoShows()).catch((err) => this.log.error(`no-show sweep failed for ${t.id}: ${err.message}`));
  }

  // Active employees of the branch who could take this shift now, least-loaded first.
  async candidates(scheduleId: string, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id: scheduleId } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    const ids = (await this.prisma.db.employeeAssignment.findMany({ where: { branchId: s.branchId, validFrom: { lte: s.date }, OR: [{ validTo: null }, { validTo: { gte: s.date } }] } })).map((a) => a.employeeId).filter((i) => i !== s.employeeId);
    const out = [];
    for (const id of [...new Set(ids)]) {
      if (await this.eligible(s, id)) continue;
      const e = await this.prisma.db.employee.findFirst({ where: { id } });
      out.push({ employeeId: id, name: e?.name });
    }
    return out;
  }

  async cover(scheduleId: string, employeeId: string, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id: scheduleId } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    if (!s.noShowAt || s.status !== 'PUBLISHED') throw new ConflictException('Only a flagged no-show shift can be covered');
    if (employeeId === s.employeeId) throw new BadRequestException('Choose a replacement');
    // The original stays on record, cancelled, so the no-show history is kept.
    const from = new Date(Math.max(Date.now(), s.startAt.getTime()));
    const sched = await this.schedules.create({ employeeId, branchId: s.branchId, date: s.date.toISOString(), startAt: from.toISOString(), endAt: s.endAt.toISOString(), notes: `Coverage for no-show ${s.id}` }, user, { skipApproval: true });
    await this.prisma.db.shiftSchedule.updateMany({ where: { id: s.id }, data: { status: 'CANCELLED', notes: `No-show, covered by ${employeeId}` } });
    await this.audit.record({ action: 'schedule.coverage_authorized', entityType: 'ShiftSchedule', entityId: s.id, after: { replacement: employeeId, newShift: sched.id, minutes: minutes(from, s.endAt) } });
    return sched;
  }

  // Colleagues sharing a branch, for swap requests (id and name only).
  async colleagues(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const branches = (await this.prisma.db.employeeAssignment.findMany({ where: { employeeId: me.id, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.branchId);
    const ids = (await this.prisma.db.employeeAssignment.findMany({ where: { branchId: { in: branches }, employeeId: { not: me.id }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.employeeId);
    return this.prisma.db.employee.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
}
