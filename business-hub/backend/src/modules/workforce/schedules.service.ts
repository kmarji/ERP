import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { atLocal, employeeOf, MANAGERS, minutes, weekBounds } from './common';

export interface ShiftInput {
  employeeId: string;
  branchId: string;
  date: string;
  templateId?: string;
  startAt?: string;
  endAt?: string;
  notes?: string;
}

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- templates

  listTemplates(branchId?: string) {
    return this.prisma.db.shiftTemplate.findMany({ where: { branchId, active: true }, orderBy: { name: 'asc' } });
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

  private async bounds(input: ShiftInput) {
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
  async validate(employeeId: string, branchId: string, date: Date, startAt: Date, endAt: Date, ignoreId?: string) {
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
    if (await this.prisma.db.shiftSchedule.findFirst({ where: { ...others, OR: [{ endAt: { gt: new Date(startAt.getTime() - rest), lte: startAt } }, { startAt: { gte: endAt, lt: new Date(endAt.getTime() + rest) } }] } })) {
      throw new ConflictException(`Less than ${rules.scheduling.minRestHours} hours of rest between shifts`);
    }
    const wk = weekBounds(date);
    const week = await this.prisma.db.shiftSchedule.findMany({ where: { ...others, date: { gte: wk.start, lte: wk.end } } });
    const total = week.reduce((s, w) => s + minutes(w.startAt, w.endAt), 0) + minutes(startAt, endAt);
    if (total > rules.scheduling.maxWeeklyMinutes) throw new ConflictException(`Exceeds the weekly maximum of ${rules.scheduling.maxWeeklyMinutes / 60} hours`);
  }

  async create(input: ShiftInput, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const { startAt, endAt } = await this.bounds(input);
    const date = new Date(`${input.date.slice(0, 10)}T00:00:00.000Z`);
    await this.validate(input.employeeId, input.branchId, date, startAt, endAt);
    const row = await this.prisma.db.shiftSchedule.create({ data: { tenantId: '', employeeId: input.employeeId, branchId: input.branchId, date, startAt, endAt, templateId: input.templateId ?? null, notes: input.notes ?? null, createdBy: user.id } });
    await this.audit.record({ action: 'schedule.published', entityType: 'ShiftSchedule', entityId: row.id, after: { employeeId: row.employeeId, date: input.date } });
    return row;
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
    return this.prisma.db.shiftSchedule.findMany({ where: { branchId: f.branchId, employeeId: f.employeeId, date: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } }, orderBy: { startAt: 'asc' }, take: 500 });
  }

  async cancel(id: string, user: RequestUser) {
    const s = await this.prisma.db.shiftSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Shift not found');
    assertBranchAccess(user, s.branchId, MANAGERS);
    await this.prisma.db.shiftSchedule.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.record({ action: 'schedule.cancelled', entityType: 'ShiftSchedule', entityId: id });
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
    if (mine && (mine.id === sw.fromEmployeeId || mine.id === sw.toEmployeeId)) throw new ForbiddenException('You cannot decide your own swap');
    if (approve) {
      if (s.employeeId !== sw.fromEmployeeId || s.status !== 'PUBLISHED') throw new ConflictException('The shift changed since the request');
      await this.validate(sw.toEmployeeId, s.branchId, s.date, s.startAt, s.endAt, s.id);
      await this.prisma.db.shiftSchedule.updateMany({ where: { id: s.id }, data: { employeeId: sw.toEmployeeId } });
    }
    await this.prisma.db.shiftSwapRequest.updateMany({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedBy: user.id, decidedAt: new Date() } });
    await this.audit.record({ action: approve ? 'swap.approved' : 'swap.rejected', entityType: 'ShiftSwapRequest', entityId: id });
    return this.prisma.db.shiftSwapRequest.findFirstOrThrow({ where: { id } });
  }
}

