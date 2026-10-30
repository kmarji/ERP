import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { d } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PayrollRulesService } from '../payroll/payroll-rules.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { DAY, employeeOf, MANAGERS, primaryBranch } from './common';

const ACTION = 'leave.approve';
const iso = (x: Date) => x.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class LeaveService {
  private readonly log = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  // PLACEHOLDER defaults until HR sets the real entitlements (see payroll rules, which need legal verification).
  async types() {
    if (!(await this.prisma.db.leaveType.count())) {
      const { rules } = await this.rules.activeFor(new Date());
      await this.prisma.db.leaveType.createMany({
        data: [
          { tenantId: '', key: 'ANNUAL', name: 'Annual leave (placeholder)', nameAr: 'إجازة سنوية', paid: true, annualDays: rules.leave.annualDays, statutory: true },
          { tenantId: '', key: 'SICK', name: 'Sick leave (placeholder)', nameAr: 'إجازة مرضية', paid: true, annualDays: rules.leave.sickDays, accrualMonthly: false, requiresCertificateAfterDays: 2, statutory: true },
          { tenantId: '', key: 'UNPAID', name: 'Unpaid leave', nameAr: 'إجازة بدون راتب', paid: false, annualDays: 0, accrualMonthly: false },
        ],
        skipDuplicates: true,
      });
    }
    return this.prisma.db.leaveType.findMany({ orderBy: { key: 'asc' } });
  }

  // Idempotent: accrued is set to the absolute year-to-date entitlement, never incremented.
  async accrue(on: Date = new Date()) {
    const types = (await this.types()).filter((t) => t.annualDays.gt(0));
    const year = on.getUTCFullYear();
    const month = on.getUTCMonth() + 1;
    const emps = await this.prisma.db.employee.findMany({ where: { status: 'ACTIVE' } });
    let n = 0;
    for (const e of emps) for (const t of types) {
      const accrued = t.accrualMonthly ? d(t.annualDays).times(month).div(12).toDecimalPlaces(2) : d(t.annualDays);
      await this.prisma.db.leaveBalance.upsert({
        where: { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: t.id, year } },
        update: { accrued },
        create: { tenantId: '', employeeId: e.id, leaveTypeId: t.id, year, accrued },
      });
      n++;
    }
    return { balances: n };
  }

  @Cron('0 3 1 * *')
  async monthly() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.accrue()).catch((err) => this.log.error(`accrual failed for ${t.id}: ${err.message}`));
  }

  async balances(employeeId: string, year = new Date().getUTCFullYear()) {
    const types = await this.types();
    const rows = await this.prisma.db.leaveBalance.findMany({ where: { employeeId, year } });
    return types.map((t) => {
      const b = rows.find((r) => r.leaveTypeId === t.id);
      const accrued = d(b?.accrued ?? 0), carried = d(b?.carried ?? 0), used = d(b?.used ?? 0);
      return { leaveTypeId: t.id, key: t.key, name: t.name, paid: t.paid, accrued, carried, used, available: accrued.plus(carried).minus(used) };
    });
  }

  // Working days = calendar days minus Fridays (Jordan's weekend is Fri-Sat; Saturday is a working day for most F&B, so only Friday is excluded).
  // ponytail: no public-holiday calendar; add when HR supplies one.
  private countDays(from: Date, to: Date) {
    let n = 0;
    for (let t = +from; t <= +to; t += DAY) if (new Date(t).getUTCDay() !== 5) n++;
    return n;
  }

  async request(user: RequestUser, input: { employeeId?: string; leaveTypeId: string; startDate: string; endDate: string; reason?: string; certificateDocId?: string }) {
    const me = input.employeeId ? await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } }) : await employeeOf(this.prisma, user);
    if (!me) throw new NotFoundException('Employee not found');
    if (input.employeeId && me.userId !== user.id) assertBranchAccess(user, (await primaryBranch(this.prisma, me.id, new Date())) ?? '', MANAGERS);
    const type = (await this.types()).find((t) => t.id === input.leaveTypeId);
    if (!type) throw new NotFoundException('Leave type not found');
    const start = utc(input.startDate), end = utc(input.endDate);
    if (end < start) throw new BadRequestException('endDate is before startDate');
    if (start.getUTCFullYear() !== end.getUTCFullYear()) throw new BadRequestException('Split requests that cross a year');
    const days = this.countDays(start, end);
    if (days <= 0) throw new BadRequestException('The request has no working days');
    const overlap = await this.prisma.db.leaveRequest.findFirst({ where: { employeeId: me.id, status: { in: ['PENDING', 'APPROVED'] }, startDate: { lte: end }, endDate: { gte: start } } });
    if (overlap) throw new ConflictException('Overlaps another leave request');
    if (type.requiresCertificateAfterDays != null && days > type.requiresCertificateAfterDays && !input.certificateDocId) throw new BadRequestException(`A medical certificate is required for more than ${type.requiresCertificateAfterDays} days`);
    if (type.paid) {
      const bal = (await this.balances(me.id, start.getUTCFullYear())).find((b) => b.leaveTypeId === type.id)!;
      const pending = await this.prisma.db.leaveRequest.aggregate({ where: { employeeId: me.id, leaveTypeId: type.id, status: 'PENDING', startDate: { gte: utc(`${start.getUTCFullYear()}-01-01`) } }, _sum: { days: true } });
      if (bal.available.minus(pending._sum.days ?? 0).lt(days)) throw new ConflictException(`Insufficient ${type.key} balance (${bal.available} available)`);
    }
    const branchId = (await primaryBranch(this.prisma, me.id, start)) ?? undefined;
    const row = await this.prisma.db.leaveRequest.create({ data: { tenantId: '', employeeId: me.id, leaveTypeId: type.id, startDate: start, endDate: end, days, reason: input.reason ?? null, certificateDocId: input.certificateDocId ?? null } });
    await this.audit.record({ action: 'leave.requested', entityType: 'LeaveRequest', entityId: row.id, after: { days, type: type.key } });
    const decision = await this.policy.evaluate(ACTION, { amount: days, branchId });
    if (decision.decision === 'BLOCKED') {
      await this.prisma.db.leaveRequest.updateMany({ where: { id: row.id }, data: { status: 'REJECTED', decisionNote: 'Blocked by policy' } });
      throw new BadRequestException('Leave is blocked by policy');
    }
    if (decision.decision === 'AUTO') return this.decide(row.id, true, 'Auto-approved by policy', 'system');
    await this.approvals.request({ subjectType: 'LeaveRequest', subjectId: row.id, action: ACTION, approverRole: decision.approverRole!, amount: days, branchId });
    return row;
  }

  list(f: { employeeId?: string; status?: string; from?: string; to?: string }) {
    return this.prisma.db.leaveRequest.findMany({ where: { employeeId: f.employeeId, status: f.status as any, startDate: f.to ? { lte: utc(f.to) } : undefined, endDate: f.from ? { gte: utc(f.from) } : undefined }, orderBy: { startDate: 'desc' }, take: 300 });
  }

  // Shared by the approval handler and AUTO routing. Idempotent: only a PENDING request can be decided.
  async decide(id: string, approved: boolean, note: string, by: string) {
    const r = await this.prisma.db.leaveRequest.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('Leave request not found');
    if (r.status !== 'PENDING') return r;
    const type = await this.prisma.db.leaveType.findFirstOrThrow({ where: { id: r.leaveTypeId } });
    await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.leaveRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: approved ? 'APPROVED' : 'REJECTED', decidedBy: by, decidedAt: new Date(), decisionNote: note } });
      if (res.count !== 1) return;
      if (approved && type.paid) await tx.leaveBalance.upsert({ where: { employeeId_leaveTypeId_year: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.startDate.getUTCFullYear() } }, update: { used: { increment: r.days } }, create: { tenantId: '', employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.startDate.getUTCFullYear(), used: r.days } });
      await this.audit.record({ action: approved ? 'leave.approved' : 'leave.rejected', entityType: 'LeaveRequest', entityId: id, after: { note } }, tx);
    });
    if (approved) await this.flagScheduleConflicts(r.employeeId, r.startDate, r.endDate, id);
    return this.prisma.db.leaveRequest.findFirstOrThrow({ where: { id } });
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApproval(e: ApprovalDecidedEvent) {
    if (e.action !== ACTION) return;
    await runWithTenant(e.tenantId, () => this.decide(e.subjectId, e.approved, e.approved ? 'Approved' : 'Rejected', e.decidedBy));
  }

  // Shifts that fall inside newly approved leave are marked, and ONE exception is raised per leave request.
  private async flagScheduleConflicts(employeeId: string, start: Date, end: Date, leaveId: string) {
    const res = await this.prisma.db.shiftSchedule.updateMany({ where: { employeeId, status: 'PUBLISHED', date: { gte: start, lte: end } }, data: { status: 'LEAVE_CONFLICT' } });
    if (!res.count) return;
    const emp = await this.prisma.db.employee.findFirst({ where: { id: employeeId } });
    await this.exceptions.raise({ code: 'LEAVE_SCHEDULE_CONFLICT', reason: `${emp?.name ?? 'An employee'} has ${res.count} scheduled shift(s) during approved leave ${iso(start)} to ${iso(end)}`, evidence: { leaveRequestId: leaveId, employeeId, shifts: res.count }, impact: 'Shifts need reassigning or cancelling', branchId: (await primaryBranch(this.prisma, employeeId, start)) ?? undefined, ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW', availableActions: ['resolve'] });
  }

  async cancel(id: string, user: RequestUser) {
    const r = await this.prisma.db.leaveRequest.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('Leave request not found');
    const mine = await this.prisma.db.employee.findFirst({ where: { userId: user.id } });
    if (mine?.id !== r.employeeId) assertBranchAccess(user, (await primaryBranch(this.prisma, r.employeeId, r.startDate)) ?? '', MANAGERS);
    if (!['PENDING', 'APPROVED'].includes(r.status)) throw new ConflictException(`Request is ${r.status}`);
    if (r.status === 'APPROVED' && r.endDate < utc(iso(new Date()))) throw new ConflictException('Past leave cannot be cancelled');
    await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.leaveRequest.updateMany({ where: { id, status: r.status }, data: { status: 'CANCELLED' } });
      if (res.count !== 1) throw new ConflictException('The request changed; reload it');
      const type = await tx.leaveType.findFirstOrThrow({ where: { id: r.leaveTypeId } });
      if (r.status === 'APPROVED' && type.paid) await tx.leaveBalance.updateMany({ where: { employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.startDate.getUTCFullYear() }, data: { used: { decrement: r.days } } });
      await this.audit.record({ action: 'leave.cancelled', entityType: 'LeaveRequest', entityId: id }, tx);
    });
    return this.prisma.db.leaveRequest.findFirstOrThrow({ where: { id } });
  }
}
