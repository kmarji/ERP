import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentContext, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { breakOf, entryOvertime } from './overtime';
import { WeekService } from './week.service';
import { employeeOf, MANAGERS, minutes, primaryBranch, weekBounds } from './common';

const CORRECTION = 'time.correction';
const COUNTED = ['COMPLETE', 'APPROVED'] as const;

@Injectable()
export class TimeService {
  private readonly log = new Logger(TimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly weeks: WeekService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  // Own employee by login, or any employee when a branch manager works a kiosk.
  private async actor(user: RequestUser, employeeId?: string, branchId?: string) {
    if (!employeeId) return { employee: await employeeOf(this.prisma, user), kiosk: false };
    const employee = await this.prisma.db.employee.findFirst({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException('Employee not found');
    assertBranchAccess(user, branchId ?? (await primaryBranch(this.prisma, employee.id, new Date())) ?? '', MANAGERS);
    return { employee, kiosk: true };
  }

  private day = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

  async clockIn(user: RequestUser, input: { employeeId?: string; branchId?: string; at?: string; lat?: number; lng?: number; accuracy?: number }) {
    const { employee, kiosk } = await this.actor(user, input.employeeId, input.branchId);
    if (input.at && !kiosk) throw new ForbiddenException('Only a manager can set the time');
    const at = input.at ? new Date(input.at) : new Date();
    const branchId = input.branchId ?? (await primaryBranch(this.prisma, employee.id, this.day(at)));
    if (!branchId) throw new ConflictException('Employee has no branch assignment');
    if (!(await this.prisma.db.employeeAssignment.findFirst({ where: { employeeId: employee.id, branchId, validFrom: { lte: this.day(at) }, OR: [{ validTo: null }, { validTo: { gte: this.day(at) } }] } }))) throw new ConflictException('You are not assigned to this branch');
    if (await this.prisma.db.timeEntry.findFirst({ where: { employeeId: employee.id, status: 'OPEN' } })) throw new ConflictException('You are already clocked in');
    // A21: a self punch must be inside the branch geofence (when one is set) and against an effective shift. Kiosk punches are a manager's call.
    if (!kiosk) await this.assertGeofence(branchId, input.lat, input.lng, input.accuracy);
    const { rules } = await this.rules.activeFor(this.day(at));
    // Nearest published shift within +-3h of the punch.
    const near = await this.prisma.db.shiftSchedule.findMany({ where: { employeeId: employee.id, status: 'PUBLISHED', startAt: { gte: new Date(at.getTime() - 3 * 3_600_000), lte: new Date(at.getTime() + 3 * 3_600_000) } } });
    const sch = near.sort((a, b) => Math.abs(+a.startAt - +at) - Math.abs(+b.startAt - +at))[0];
    if (!kiosk && !sch) throw new ConflictException('You have no scheduled shift around this time');
    const late = sch ? Math.max(0, minutes(sch.startAt, at) - rules.lateness.graceMinutes) : 0;
    const row = await this.prisma.db.timeEntry.create({ data: { tenantId: '', employeeId: employee.id, branchId, scheduleId: sch?.id ?? null, clockIn: at, source: kiosk ? 'KIOSK' : 'MOBILE', lateMinutes: late, createdBy: user.id } });
    await this.audit.record({ action: kiosk ? 'time.kiosk_clock_in' : 'time.clock_in', entityType: 'TimeEntry', entityId: row.id, after: { employeeId: employee.id, late } });
    return row;
  }

  // Distance to the branch in metres, or null when the branch has no geofence. GPS is only good to `accuracy` metres, so that much is forgiven (capped).
  private async fenceDistance(branchId: string, lat: number, lng: number, accuracy = 0) {
    const b = await this.prisma.db.branch.findFirst({ where: { id: branchId } });
    if (!b?.geofenceM || b.latitude == null || b.longitude == null) return null;
    const rad = (x: number) => (x * Math.PI) / 180;
    const [la, lo] = [Number(b.latitude), Number(b.longitude)];
    const h = Math.sin(rad(lat - la) / 2) ** 2 + Math.cos(rad(la)) * Math.cos(rad(lat)) * Math.sin(rad(lng - lo) / 2) ** 2;
    const meters = Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
    return { meters, limit: b.geofenceM, outside: meters - Math.min(Math.max(accuracy, 0), 150) > b.geofenceM };
  }

  private async assertGeofence(branchId: string, lat?: number, lng?: number, accuracy?: number) {
    const b = await this.prisma.db.branch.findFirst({ where: { id: branchId } });
    if (!b?.geofenceM || b.latitude == null || b.longitude == null) return;
    if (lat == null || lng == null) throw new BadRequestException('Location is required to clock in at this branch');
    const f = await this.fenceDistance(branchId, lat, lng, accuracy);
    if (f?.outside) throw new ForbiddenException(`You are ${f.meters} m from the branch (limit ${f.limit} m, GPS accuracy ${Math.round(accuracy ?? 0)} m)`);
  }

  // The portal reports the phone's position while the employee is clocked in; leaving the geofence clocks them out.
  async presence(user: RequestUser, input: { lat: number; lng: number; accuracy?: number }) {
    const { employee } = await this.actor(user);
    const entry = await this.prisma.db.timeEntry.findFirst({ where: { employeeId: employee.id, status: 'OPEN', clockOut: null } });
    if (!entry) return { clockedOut: false };
    const f = await this.fenceDistance(entry.branchId, input.lat, input.lng, input.accuracy);
    // A clearly-outside reading only: 30 m beyond the limit, so one noisy fix cannot end a shift.
    if (!f || f.meters - Math.min(Math.max(input.accuracy ?? 0, 0), 150) <= f.limit + 30) return { clockedOut: false, meters: f?.meters };
    await this.clockOut(user, {});
    await this.prisma.db.timeEntry.updateMany({ where: { id: entry.id }, data: { note: `Clocked out automatically: ${f.meters} m from the branch (limit ${f.limit} m)` } });
    await this.audit.record({ action: 'time.auto_clock_out', entityType: 'TimeEntry', entityId: entry.id, after: { meters: f.meters, limit: f.limit } });
    return { clockedOut: true, meters: f.meters, limit: f.limit };
  }

  async clockOut(user: RequestUser, input: { employeeId?: string; at?: string }) {
    const { employee, kiosk } = await this.actor(user, input.employeeId);
    if (input.at && !kiosk) throw new ForbiddenException('Only a manager can set the time');
    const entry = await this.prisma.db.timeEntry.findFirst({ where: { employeeId: employee.id, status: { in: ['OPEN', 'NEEDS_FIX'] }, clockOut: null }, orderBy: { clockIn: 'desc' } });
    if (!entry) throw new ConflictException('You are not clocked in');
    const out = input.at ? new Date(input.at) : new Date();
    if (out <= entry.clockIn) throw new BadRequestException('Clock-out must be after clock-in');
    const calc = await this.compute(employee.id, entry.id, entry.clockIn, out, entry.scheduleId);
    await this.prisma.db.timeEntry.updateMany({ where: { id: entry.id }, data: { clockOut: out, status: 'COMPLETE', ...calc } });
    // A23: actual hours are kept; excess goes to the manager as an exception and payroll pays it as overtime only once the entry is approved.
    if (calc.overtimeMinutes > 0) {
      await this.exceptions.raise({ code: 'ATT_OVERTIME', reason: `${employee.name} worked ${calc.overtimeMinutes} min of overtime`, evidence: { timeEntryId: entry.id, employeeId: employee.id }, impact: 'Overtime is paid only after the entry is approved', branchId: entry.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW', availableActions: ['resolve'] });
    }
    await this.audit.record({ action: kiosk ? 'time.kiosk_clock_out' : 'time.clock_out', entityType: 'TimeEntry', entityId: entry.id, after: calc });
    return this.prisma.db.timeEntry.findFirstOrThrow({ where: { id: entry.id } });
  }

  // Worked time net of break, early leave, and overtime from the rules in force.
  private async compute(employeeId: string, entryId: string, inAt: Date, outAt: Date, scheduleId: string | null) {
    const { rules } = await this.rules.activeFor(this.day(inAt));
    const sch = scheduleId ? await this.prisma.db.shiftSchedule.findFirst({ where: { id: scheduleId } }) : null;
    const tpl = sch?.templateId ? await this.prisma.db.shiftTemplate.findFirst({ where: { id: sch.templateId } }) : null;
    const gross = minutes(inAt, outAt);
    const breakMinutes = breakOf(gross, tpl?.breakMinutes);
    const worked = Math.max(0, gross - breakMinutes);
    const early = sch ? Math.max(0, minutes(outAt, sch.endAt)) : 0;
    const wk = weekBounds(this.day(inAt), await this.weeks.startsOn());
    const week = await this.prisma.db.timeEntry.findMany({ where: { employeeId, id: { not: entryId }, status: { in: [...COUNTED] }, clockIn: { gte: wk.start, lt: new Date(wk.end.getTime() + 86_400_000) } } });
    const prevWorked = week.reduce((s, e) => s + (e.workedMinutes ?? 0), 0);
    const prevOt = week.reduce((s, e) => s + (e.overtimeMinutes ?? 0), 0);
    return { breakMinutes, workedMinutes: worked, earlyLeaveMinutes: early, overtimeMinutes: entryOvertime(prevWorked, prevOt, worked, rules.overtime) };
  }

  list(f: { employeeId?: string; branchId?: string; from?: string; to?: string; status?: string }) {
    return this.prisma.db.timeEntry.findMany({ where: { employeeId: f.employeeId, branchId: f.branchId, status: f.status as any, clockIn: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lt: new Date(new Date(f.to).getTime() + 86_400_000) } : {}) } }, orderBy: { clockIn: 'asc' }, take: 500 });
  }

  async manual(input: { employeeId: string; branchId: string; clockIn: string; clockOut: string; note?: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const inAt = new Date(input.clockIn);
    const outAt = new Date(input.clockOut);
    if (!(outAt > inAt)) throw new BadRequestException('clockOut must be after clockIn');
    const calc = await this.compute(input.employeeId, '', inAt, outAt, null);
    const row = await this.prisma.db.timeEntry.create({ data: { tenantId: '', employeeId: input.employeeId, branchId: input.branchId, clockIn: inAt, clockOut: outAt, source: 'MANUAL', status: 'COMPLETE', note: input.note ?? null, createdBy: user.id, ...calc } });
    await this.audit.record({ action: 'time.manual_entry', entityType: 'TimeEntry', entityId: row.id, after: { employeeId: input.employeeId, note: input.note } });
    return row;
  }

  async approve(id: string, user: RequestUser) {
    const e = await this.prisma.db.timeEntry.findFirst({ where: { id } });
    if (!e) throw new NotFoundException('Entry not found');
    assertBranchAccess(user, e.branchId, MANAGERS);
    if (e.status !== 'COMPLETE') throw new ConflictException(`Entry is ${e.status}`);
    await this.prisma.db.timeEntry.updateMany({ where: { id }, data: { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() } });
    await this.audit.record({ action: 'time.approved', entityType: 'TimeEntry', entityId: id });
    return this.prisma.db.timeEntry.findFirstOrThrow({ where: { id } });
  }

  async approvePeriod(input: { branchId: string; from: string; to: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const r = await this.prisma.db.timeEntry.updateMany({ where: { branchId: input.branchId, status: 'COMPLETE', clockIn: { gte: new Date(input.from), lt: new Date(new Date(input.to).getTime() + 86_400_000) } }, data: { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() } });
    await this.audit.record({ action: 'time.period_approved', entityType: 'Branch', entityId: input.branchId, after: { ...input, entries: r.count } });
    return { approved: r.count };
  }

  // ---------------------------------------------------------------- corrections

  async correct(id: string, input: { clockIn: string; clockOut: string; note: string }, user: RequestUser) {
    const e = await this.prisma.db.timeEntry.findFirst({ where: { id } });
    if (!e || !e.clockOut) throw new NotFoundException('Entry not found or still open');
    const mine = await this.prisma.db.employee.findFirst({ where: { userId: user.id } });
    if (mine?.id !== e.employeeId) assertBranchAccess(user, e.branchId, MANAGERS);
    if (e.status === 'APPROVED') throw new ConflictException('An approved entry can only be corrected by a manager entry');
    const inAt = new Date(input.clockIn);
    const outAt = new Date(input.clockOut);
    if (!(outAt > inAt)) throw new BadRequestException('clockOut must be after clockIn');
    const changed = Math.abs(minutes(inAt, outAt) - minutes(e.clockIn, e.clockOut));
    const decision = await this.policy.evaluate(CORRECTION, { amount: changed, branchId: e.branchId });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Corrections are blocked by policy');
    if (decision.decision === 'AUTO') return this.applyCorrection(e.id, inAt, outAt, input.note, user.id);
    const flags = [...((e.flags as any[]) ?? []).filter((f) => f.code !== 'CORRECTION_PENDING'), { code: 'CORRECTION_PENDING', clockIn: input.clockIn, clockOut: input.clockOut, note: input.note, by: user.id }];
    await this.prisma.db.timeEntry.updateMany({ where: { id }, data: { flags: flags as any } });
    await this.approvals.request({ subjectType: 'TimeEntry', subjectId: id, action: CORRECTION, approverRole: decision.approverRole!, amount: changed, branchId: e.branchId });
    await this.audit.record({ action: 'time.correction_requested', entityType: 'TimeEntry', entityId: id, after: { changed } });
    return { pending: true, minutesChanged: changed, approverRole: decision.approverRole };
  }

  // The original is kept for the record, zeroed and flagged so it never counts twice.
  private async applyCorrection(id: string, inAt: Date, outAt: Date, note: string, by: string) {
    const e = await this.prisma.db.timeEntry.findFirstOrThrow({ where: { id } });
    const calc = await this.compute(e.employeeId, id, inAt, outAt, e.scheduleId);
    const created = await this.prisma.db.$transaction(async (tx) => {
      await tx.timeEntry.updateMany({ where: { id }, data: { status: 'APPROVED', workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, flags: [{ code: 'SUPERSEDED', note }] as any } });
      const row = await tx.timeEntry.create({ data: { tenantId: '', employeeId: e.employeeId, branchId: e.branchId, scheduleId: e.scheduleId, clockIn: inAt, clockOut: outAt, source: 'MANUAL', status: 'COMPLETE', correctionOf: id, note, createdBy: by, lateMinutes: e.lateMinutes, ...calc } });
      await this.audit.record({ action: 'time.corrected', entityType: 'TimeEntry', entityId: id, after: { replacedBy: row.id, note } }, tx);
      return row;
    });
    return created;
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApproval(e: ApprovalDecidedEvent) {
    if (e.action !== CORRECTION) return;
    await runWithTenant(e.tenantId, async () => {
      const entry = await this.prisma.db.timeEntry.findFirst({ where: { id: e.subjectId } });
      const pending = ((entry?.flags as any[]) ?? []).find((f) => f.code === 'CORRECTION_PENDING');
      if (!entry || !pending) return;
      if (e.approved) await this.applyCorrection(entry.id, new Date(pending.clockIn), new Date(pending.clockOut), pending.note, e.decidedBy);
      else await this.prisma.db.timeEntry.updateMany({ where: { id: entry.id }, data: { flags: ((entry.flags as any[]) ?? []).filter((f) => f.code !== 'CORRECTION_PENDING') as any } });
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ---------------------------------------------------------------- missing punches

  async flagMissingPunches(now: Date = new Date()) {
    const open = await this.prisma.db.timeEntry.findMany({ where: { status: 'OPEN', clockOut: null } });
    let n = 0;
    for (const e of open) {
      const sch = e.scheduleId ? await this.prisma.db.shiftSchedule.findFirst({ where: { id: e.scheduleId } }) : null;
      const deadline = sch ? sch.endAt.getTime() + 2 * 3_600_000 : e.clockIn.getTime() + 16 * 3_600_000;
      if (deadline > now.getTime()) continue;
      const res = await this.prisma.db.timeEntry.updateMany({ where: { id: e.id, status: 'OPEN' }, data: { status: 'NEEDS_FIX', flags: [{ code: 'MISSING_PUNCH', message: 'No clock-out recorded' }] as any } });
      if (res.count !== 1) continue; // already flagged: exactly one exception per entry
      const emp = await this.prisma.db.employee.findFirst({ where: { id: e.employeeId } });
      await this.exceptions.raise({ code: 'ATT_MISSING_PUNCH', reason: `${emp?.name ?? 'An employee'} has no clock-out for the shift starting ${e.clockIn.toISOString()}`, evidence: { timeEntryId: e.id, employeeId: e.employeeId }, impact: 'The entry is excluded from payroll until it is fixed', branchId: e.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW', availableActions: ['resolve'] });
      n++;
    }
    return n;
  }

  @Cron('*/30 * * * *')
  async sweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.flagMissingPunches()).catch((err) => this.log.error(`punch sweep failed for ${t.id}: ${err.message}`));
  }
}
