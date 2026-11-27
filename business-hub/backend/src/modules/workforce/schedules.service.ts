import { ownDutyRule } from '../audit/owner-override';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { COUNTED_SHIFTS, OverHoursService } from './over-hours.service';
import { breakOf, overtimeMinutes } from './overtime';
import { WeekService } from './week.service';
import { atLocal, employeeOf, MANAGERS, minutes, weekBounds } from './common';

export interface ShiftInput {
  employeeId: string;
  branchId: string;
  date: string;
  templateId?: string;
  startAt?: string;
  endAt?: string;
  notes?: string;
  overrideRestReason?: string; // a manager knowingly schedules with less than the minimum rest
  overLimitReason?: string; // ... or past the weekly maximum, which escalates to HR and the owner
}

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly audit: AuditService,
    private readonly weeks: WeekService,
    private readonly overHours: OverHoursService,
  ) {}

  // ---------------------------------------------------------------- templates

  listTemplates(branchId?: string) {
    // For one branch: its own templates plus the company-wide ones (branchId null).
    return this.prisma.db.shiftTemplate.findMany({ where: { active: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, orderBy: { name: 'asc' } });
  }

  async createTemplate(input: { branchId?: string; name: string; startTime: string; endTime: string; breakMinutes?: number }, user: RequestUser) {
    if (input.branchId) assertBranchAccess(user, input.branchId, MANAGERS);
    const row = await this.prisma.db.shiftTemplate.create({ data: { tenantId: '', branchId: input.branchId ?? null, name: input.name, startTime: input.startTime, endTime: input.endTime, breakMinutes: input.breakMinutes ?? 30 } });
    await this.audit.record({ action: 'shift_template.created', entityType: 'ShiftTemplate', entityId: row.id, after: row });
    return row;
  }

  async patchTemplate(id: string, input: { name?: string; startTime?: string; endTime?: string; breakMinutes?: number; active?: boolean }, user: RequestUser) {
    const t = await this.prisma.db.shiftTemplate.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    if (t.branchId) assertBranchAccess(user, t.branchId, MANAGERS);
    await this.prisma.db.shiftTemplate.updateMany({ where: { id }, data: input });
    return this.prisma.db.shiftTemplate.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- schedules

  async bounds(input: Omit<ShiftInput, "employeeId">) {
    if (input.templateId) {
      const t = await this.prisma.db.shiftTemplate.findFirst({ where: { id: input.templateId, active: true } });
      if (!t) throw new BadRequestException('Unknown template');
      const startAt = atLocal(input.date, t.startTime);
      const overnight = t.endTime <= t.startTime;
      return { startAt, endAt: atLocal(input.date, t.endTime, overnight ? 1 : 0) };
    }
    if (!input.startAt || !input.endAt) throw new BadRequestException('Provide templateId or startAt and endAt');
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (!(endAt > startAt)) throw new BadRequestException('endAt must be after startAt');
    return { startAt, endAt };
  }

  // The checks every schedule change goes through, including swaps.
  async validate(employeeId: string, branchId: string, date: Date, startAt: Date, endAt: Date, ignoreId?: string, opts: { skipRest?: boolean; allowOver?: boolean } = {}) {
    const emp = await this.prisma.db.employee.findFirst({ where: { id: employeeId } });
    if (!emp || !['ACTIVE', 'ONBOARDING'].includes(emp.status)) throw new ConflictException('Employee is not active');
    const assigned = await this.prisma.db.employeeAssignment.findFirst({ where: { employeeId, branchId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] } });
    if (!assigned) throw new ConflictException('Employee is not assigned to this branch on that date');
    const leave = await this.prisma.db.leaveRequest.findFirst({ where: { employeeId, status: 'APPROVED', startDate: { lte: date }, endDate: { gte: date } } });
    if (leave) throw new ConflictException('Employee is on approved leave on that date');
    const { rules } = await this.rules.activeFor(date);
    const others = { employeeId, status: 'PUBLISHED', ...(ignoreId ? { id: { not: ignoreId } } : {}) };
    if (await this.prisma.db.shiftSchedule.findFirst({ where: { ...others, startAt: { lt: endAt }, endAt: { gt: startAt } } })) throw new ConflictException('Overlaps another shift of this employee');
    const rest = rules.scheduling.minRestHours * 3_600_000;
    if (!opts.skipRest && await this.prisma.db.shiftSchedule.findFirst({ where: { ...others, OR: [{ endAt: { gt: new Date(startAt.getTime() - rest), lte: startAt } }, { startAt: { gte: endAt, lt: new Date(endAt.getTime() + rest) } }] } })) {
      throw new ConflictException(`Less than ${rules.scheduling.minRestHours} hours of rest between shifts`);
    }
    await this.overHours.check(employeeId, date, minutes(startAt, endAt), ignoreId, !!opts.allowOver);
  }

  // A16/A17: companies switch approval on in the 'schedule.approval' policy; shifts then wait as PENDING_APPROVAL.
  private async approvalRequired() {
    const p = await this.prisma.db.policy.findFirst({ where: { key: 'schedule.approval', active: true } });
    return (p?.rules as any)?.required === true;
  }

  // skipApproval: the caller is a manager already deciding (open-shift assignment, no-show cover).
  async create(input: ShiftInput, user: RequestUser, opts: { skipApproval?: boolean } = {}) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const { startAt, endAt } = await this.bounds(input);
    const date = new Date(`${input.date.slice(0, 10)}T00:00:00.000Z`);
    const override = input.overrideRestReason?.trim() || null;
    const over = input.overLimitReason?.trim() || null;
    await this.validate(input.employeeId, input.branchId, date, startAt, endAt, undefined, { skipRest: !!override, allowOver: !!over });
    const pending = !opts.skipApproval && (await this.approvalRequired());
    const row = await this.prisma.db.shiftSchedule.create({ data: { tenantId: '', employeeId: input.employeeId, branchId: input.branchId, date, startAt, endAt, templateId: input.templateId ?? null, notes: input.notes ?? null, status: pending ? 'PENDING_APPROVAL' : 'PUBLISHED', restOverrideReason: override, overLimitReason: over, createdBy: user.id } });
    await this.audit.record({ action: pending ? 'schedule.submitted' : 'schedule.published', entityType: 'ShiftSchedule', entityId: row.id, after: { employeeId: row.employeeId, date: input.date, ...(override && { restOverrideReason: override }) } });
    await this.overHours.sync(row.employeeId, row.date, over ? { userId: user.id, reason: over } : undefined);
    return row;
  }

  async update(id: string, input: Omit<ShiftInput, 'employeeId' | 'branchId'>, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    if (!COUNTED_SHIFTS.includes(s.status)) throw new ConflictException(`Shift is ${s.status}`);
    const { startAt, endAt } = await this.bounds({ ...input, branchId: s.branchId });
    const date = new Date(`${input.date.slice(0, 10)}T00:00:00.000Z`);
    const override = input.overrideRestReason?.trim() || null;
    const over = input.overLimitReason?.trim() || null;
    await this.validate(s.employeeId, s.branchId, date, startAt, endAt, s.id, { skipRest: !!override, allowOver: !!over });
    const status = (await this.approvalRequired()) ? 'PENDING_APPROVAL' : 'PUBLISHED';
    await this.prisma.db.shiftSchedule.updateMany({ where: { id }, data: { date, startAt, endAt, templateId: input.templateId ?? null, status, restOverrideReason: override, overLimitReason: over, createdBy: user.id, noShowAt: null } });
    await this.audit.record({ action: 'schedule.changed', entityType: 'ShiftSchedule', entityId: id, before: { date: s.date, startAt: s.startAt, endAt: s.endAt }, after: { date, startAt, endAt, status, ...(override && { restOverrideReason: override }), ...(over && { overLimitReason: over }) } });
    await this.overHours.sync(s.employeeId, date, over ? { userId: user.id, reason: over } : undefined);
    await this.overHours.sync(s.employeeId, s.date); // the week it moved out of
    return this.prisma.db.shiftSchedule.findFirstOrThrow({ where: { id } });
  }

  // Decision history is the audit trail (who, when, outcome). The author cannot approve their own shift unless OWNER or HR.
  async decide(id: string, approve: boolean, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    if (s.status !== 'PENDING_APPROVAL') throw new ConflictException(`Shift is ${s.status}`);
    if (s.createdBy === user.id && !user.roles.some((r) => ['OWNER', 'HR'].includes(r.key))) throw new ForbiddenException('Another manager must approve your shift');
    if (approve) await this.validate(s.employeeId, s.branchId, s.date, s.startAt, s.endAt, s.id, { skipRest: !!s.restOverrideReason, allowOver: true }); // the limit was enforced when it was saved
    await this.prisma.db.shiftSchedule.updateMany({ where: { id, status: 'PENDING_APPROVAL' }, data: { status: approve ? 'PUBLISHED' : 'CANCELLED' } });
    await this.audit.record({ action: approve ? 'schedule.approved' : 'schedule.rejected', entityType: 'ShiftSchedule', entityId: id, after: { by: user.id } });
    if (!approve) await this.overHours.sync(s.employeeId, s.date);
    return this.prisma.db.shiftSchedule.findFirstOrThrow({ where: { id } });
  }

  // Partial success on purpose: one bad shift in a week plan must not block the other six.
  async bulk(shifts: ShiftInput[], user: RequestUser) {
    const created: unknown[] = [];
    const errors: { index: number; message: string }[] = [];
    for (const [i, s] of shifts.entries()) {
      try {
        created.push(await this.create(s, user));
      } catch (e: any) {
        errors.push({ index: i, message: e.message });
      }
    }
    return { created, errors };
  }

  list(f: { branchId?: string; employeeId?: string; from?: string; to?: string }) {
    return this.prisma.db.shiftSchedule.findMany({ where: { branchId: f.branchId, employeeId: f.employeeId, date: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } }, orderBy: { startAt: 'asc' }, take: 5000 });
  }

  // Per employee and week: planned hours and the overtime those shifts would produce. Whole weeks touching the range.
  async summary(from: string, to: string) {
    const startsOn = await this.weeks.startsOn();
    const first = weekBounds(new Date(from), startsOn).start;
    const last = weekBounds(new Date(to), startsOn).end;
    if (last.getTime() - first.getTime() > 100 * 86_400_000 || last < first) throw new BadRequestException('Choose a range of up to 62 days');
    const { rules } = await this.rules.activeFor(new Date(from));
    const shifts = await this.prisma.db.shiftSchedule.findMany({ where: { status: { in: COUNTED_SHIFTS }, date: { gte: first, lte: last } }, orderBy: { startAt: 'asc' } });
    const templates = await this.prisma.db.shiftTemplate.findMany();
    const weeks = new Map<string, { employeeId: string; weekStart: string; gross: number[]; worked: number[] }>();
    for (const s of shifts) {
      const weekStart = weekBounds(s.date, startsOn).start.toISOString().slice(0, 10);
      const key = `${s.employeeId}:${weekStart}`;
      const w = weeks.get(key) ?? { employeeId: s.employeeId, weekStart, gross: [], worked: [] };
      const gross = minutes(s.startAt, s.endAt);
      w.gross.push(gross);
      w.worked.push(Math.max(0, gross - breakOf(gross, templates.find((t) => t.id === s.templateId)?.breakMinutes)));
      weeks.set(key, w);
    }
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    return [...weeks.values()].map((w) => ({ employeeId: w.employeeId, weekStart: w.weekStart, minutes: sum(w.gross), overLimit: sum(w.gross) > rules.scheduling.maxWeeklyMinutes, expectedOvertimeMinutes: sum(overtimeMinutes(w.worked, rules.overtime)) }));
  }

  async cancel(id: string, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    await this.prisma.db.shiftSchedule.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.record({ action: 'schedule.cancelled', entityType: 'ShiftSchedule', entityId: id });
    await this.overHours.sync(s.employeeId, s.date);
    return { cancelled: true };
  }

  // ---------------------------------------------------------------- swaps

  async requestSwap(input: { scheduleId: string; toEmployeeId: string; reason?: string }, user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id: input.scheduleId, employeeId: me.id, status: 'PUBLISHED' } });
    if (!s) throw new NotFoundException('That shift is not yours or is not published');
    if (input.toEmployeeId === me.id) throw new BadRequestException('Choose a colleague');
    if (!(await this.prisma.db.employee.findFirst({ where: { id: input.toEmployeeId } }))) throw new BadRequestException('Unknown colleague');
    return this.prisma.db.shiftSwapRequest.create({ data: { tenantId: '', scheduleId: s.id, fromEmployeeId: me.id, toEmployeeId: input.toEmployeeId, reason: input.reason ?? null } });
  }

  mySwaps(employeeId: string) {
    return this.prisma.db.shiftSwapRequest.findMany({ where: { OR: [{ fromEmployeeId: employeeId }, { toEmployeeId: employeeId }] }, orderBy: { createdAt: 'desc' } });
  }

  listSwaps(status?: string) {
    return this.prisma.db.shiftSwapRequest.findMany({ where: { status: status as any }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async decideSwap(id: string, approve: boolean, user: RequestUser) {
    const sw = await this.prisma.db.shiftSwapRequest.findFirst({ where: { id } });
    if (!sw) throw new NotFoundException('Swap not found');
    if (sw.status !== 'PENDING') throw new ConflictException(`Swap is ${sw.status}`);
    const s = await this.prisma.db.shiftSchedule.findFirstOrThrow({ where: { id: sw.scheduleId } });
    assertBranchAccess(user, s.branchId, MANAGERS);
    const mine = await this.prisma.db.employee.findFirst({ where: { userId: user.id } });
    await ownDutyRule(!!mine && (mine.id === sw.fromEmployeeId || mine.id === sw.toEmployeeId), user, this.audit, 'ShiftSwapRequest', id, 'You cannot decide your own swap');
    if (approve) {
      if (s.employeeId !== sw.fromEmployeeId || s.status !== 'PUBLISHED') throw new ConflictException('The shift changed since the request');
      await this.validate(sw.toEmployeeId, s.branchId, s.date, s.startAt, s.endAt, s.id);
      await this.prisma.db.shiftSchedule.updateMany({ where: { id: s.id }, data: { employeeId: sw.toEmployeeId } });
      for (const employeeId of [sw.fromEmployeeId, sw.toEmployeeId]) await this.overHours.sync(employeeId, s.date);
    }
    await this.prisma.db.shiftSwapRequest.updateMany({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedBy: user.id, decidedAt: new Date() } });
    await this.audit.record({ action: approve ? 'swap.approved' : 'swap.rejected', entityType: 'ShiftSwapRequest', entityId: id });
    return this.prisma.db.shiftSwapRequest.findFirstOrThrow({ where: { id } });
  }
}

