import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ammanToday, dateOnly } from '../../common/time';
import { RequestUser, currentTenantId, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';

const ACTION = 'offboarding.settlement';
const CHECKLIST = [
  ['RETURN_ASSETS', 'Uniform, keys and equipment returned'],
  ['REVOKE_ACCESS', 'System and POS access revoked'],
  ['EXIT_INTERVIEW', 'Exit interview held'],
  ['HANDOVER', 'Duties handed over'],
];
type Item = { label: string; kind: 'EARNING' | 'DEDUCTION'; amount: string };

@Injectable()
export class OffboardingService {
  constructor(private readonly prisma: PrismaService, private readonly policy: PolicyService, private readonly approvals: ApprovalService, private readonly audit: AuditService) {}

  list() { return this.prisma.db.offboarding.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }); }

  async get(id: string) {
    const o = await this.prisma.db.offboarding.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Offboarding not found');
    return o;
  }

  async initiate(input: { employeeId: string; reason: string; noticeDate: string; lastWorkingDay: string }, user: RequestUser) {
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } });
    if (!emp || emp.status === 'TERMINATED') throw new BadRequestException('Unknown or already terminated employee');
    const notice = dateOnly(input.noticeDate), last = dateOnly(input.lastWorkingDay);
    if (last < notice) throw new BadRequestException('Last working day is before the notice date');
    if (await this.prisma.db.offboarding.findFirst({ where: { employeeId: emp.id, status: { not: 'CANCELLED' } } })) throw new ConflictException('Offboarding already exists for this employee');
    const row = await this.prisma.db.offboarding.create({ data: { tenantId: '', employeeId: emp.id, reason: input.reason, noticeDate: notice, lastWorkingDay: last, initiatedBy: user.id, checklist: CHECKLIST.map(([key, label]) => ({ key, label, done: false })) } });
    await this.audit.record({ action: 'offboarding.initiated', entityType: 'Offboarding', entityId: row.id, after: { employee: emp.number, reason: input.reason, last: input.lastWorkingDay } });
    return row;
  }

  async tick(id: string, key: string, user: RequestUser) {
    const o = await this.get(id);
    if (!['INITIATED', 'SETTLEMENT_REVIEW'].includes(o.status)) throw new ConflictException(`Offboarding is ${o.status}`);
    const list = o.checklist as { key: string; done: boolean; doneBy?: string; doneAt?: string }[];
    const item = list.find((c) => c.key === key);
    if (!item) throw new BadRequestException('Unknown checklist item');
    item.done = true; item.doneBy = user.id; item.doneAt = new Date().toISOString();
    await this.prisma.db.offboarding.updateMany({ where: { id }, data: { checklist: list as any } });
    return this.get(id);
  }

  // Final salary and advance recovery come from the final payroll run (termination date prorates it); this covers what payroll does not.
  // ponytail: leave payout at basic/30 per day and no end-of-service gratuity; both are rules to confirm with legal.
  async calculateSettlement(id: string, extra: { label: string; kind: "EARNING" | "DEDUCTION"; amount: number }[] = []) {
    const o = await this.get(id);
    if (!['INITIATED', 'SETTLEMENT_REVIEW'].includes(o.status)) throw new ConflictException(`Offboarding is ${o.status}`);
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: o.employeeId }, include: { contracts: true } });
    const contract = emp.contracts.filter((c) => c.status !== 'ENDED').sort((a, b) => b.version - a.version)[0];
    const items: Item[] = [];
    if (contract) {
      const year = o.lastWorkingDay.getUTCFullYear();
      const types = await this.prisma.db.leaveType.findMany({ where: { paid: true, annualDays: { gt: 0 } } });
      const balances = await this.prisma.db.leaveBalance.findMany({ where: { employeeId: emp.id, year, leaveTypeId: { in: types.map((t) => t.id) } } });
      const remaining = balances.reduce((s, b) => s.plus(b.accrued).plus(b.carried).minus(b.used), d(0));
      if (remaining.gt(0)) items.push({ label: `Unused leave payout (${remaining} days)`, kind: 'EARNING', amount: money(remaining.times(contract.salaryBasic).div(30)).toString() });
    }
    items.push(...extra.map((e) => ({ ...e, amount: money(e.amount).toString() })));
    const total = items.reduce((s, i) => (i.kind === 'EARNING' ? s.plus(i.amount) : s.minus(i.amount)), d(0));
    await this.prisma.db.offboarding.updateMany({ where: { id }, data: { status: 'SETTLEMENT_REVIEW', settlement: { items, total: money(total).toString() } as any, settlementApprovedBy: null } });
    await this.audit.record({ action: 'offboarding.settlement_calculated', entityType: 'Offboarding', entityId: id, after: { items, total: total.toString() } });
    return this.get(id);
  }

  async requestApproval(id: string) {
    const o = await this.get(id);
    if (o.status !== 'SETTLEMENT_REVIEW' || !o.settlement) throw new ConflictException('Calculate the settlement first');
    const pending = await this.prisma.db.approval.findFirst({ where: { subjectType: 'Offboarding', subjectId: id, action: ACTION, status: 'PENDING' } });
    if (pending) return pending;
    const amount = Math.abs(Number((o.settlement as any).total));
    const decision = await this.policy.evaluate(ACTION, { amount });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Settlement is blocked by policy');
    return this.approvals.request({ subjectType: 'Offboarding', subjectId: id, action: ACTION, approverRole: decision.approverRole ?? 'OWNER', amount });
  }

  @OnEvent(APPROVAL_DECIDED)
  async onDecided(e: ApprovalDecidedEvent) {
    if (e.action !== ACTION || !e.approved) return;
    await runWithTenant(e.tenantId, async () => {
      await this.prisma.db.offboarding.updateMany({ where: { id: e.subjectId, status: 'SETTLEMENT_REVIEW' }, data: { settlementApprovedBy: e.decidedBy } });
    });
  }

  async complete(id: string, user: RequestUser) {
    const o = await this.get(id);
    if (o.status === 'COMPLETED') return o;
    if (o.status !== 'SETTLEMENT_REVIEW') throw new ConflictException('Calculate and approve the settlement first');
    if (!o.settlementApprovedBy) throw new ConflictException('Settlement is not approved');
    const open = (o.checklist as { done: boolean; label: string }[]).filter((c) => !c.done);
    if (open.length) throw new ConflictException(`Checklist incomplete: ${open.map((c) => c.label).join('; ')}`);
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: o.employeeId } });
    const items = ((o.settlement as any).items ?? []) as Item[];
    await this.prisma.db.$transaction(async (tx) => {
      await tx.employee.updateMany({ where: { id: emp.id }, data: { status: 'TERMINATED', terminationDate: o.lastWorkingDay } });
      if (emp.userId) await tx.user.updateMany({ where: { id: emp.userId }, data: { active: false } });
      await tx.shiftSchedule.updateMany({ where: { employeeId: emp.id, date: { gt: o.lastWorkingDay }, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
      await tx.leaveRequest.updateMany({ where: { employeeId: emp.id, startDate: { gt: o.lastWorkingDay }, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
      await tx.employeeAssignment.updateMany({ where: { employeeId: emp.id, OR: [{ validTo: null }, { validTo: { gt: o.lastWorkingDay } }] }, data: { validTo: o.lastWorkingDay } });
      await tx.employmentContract.updateMany({ where: { employeeId: emp.id, status: { not: 'ENDED' } }, data: { status: 'ENDED', endDate: o.lastWorkingDay } });
      await tx.sscAction.create({ data: { tenantId: currentTenantId(), employeeId: emp.id, kind: 'TERMINATION', payload: { lastWorkingDay: o.lastWorkingDay.toISOString().slice(0, 10), reason: o.reason } } });
      for (const [i, it] of items.entries()) {
        await tx.payrollAdjustment.create({ data: { tenantId: currentTenantId(), employeeId: emp.id, kind: it.kind, label: `Settlement: ${it.label}`, amount: it.amount, sourceRef: `offboarding:${id}:${i}`, createdBy: user.id } });
      }
      await tx.offboarding.updateMany({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await this.audit.record({ action: 'offboarding.completed', entityType: 'Offboarding', entityId: id, after: { employee: emp.number, by: user.id, settlementItems: items.length } }, tx);
    });
    return this.get(id);
  }

  async cancel(id: string) {
    const o = await this.get(id);
    if (!['INITIATED', 'SETTLEMENT_REVIEW'].includes(o.status)) throw new ConflictException(`Offboarding is ${o.status}`);
    await this.prisma.db.offboarding.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
    return this.get(id);
  }
}
