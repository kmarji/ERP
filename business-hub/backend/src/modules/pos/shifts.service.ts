import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { d, money } from '../../common/money';
import { PrismaService, ScopedTx } from '../../common/prisma/prisma.service';
import { ammanToday } from '../../common/time';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { FinancePostingService } from '../finance/finance-posting.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ExceptionService } from '../workflow-engine/exception.service';

export const POS_ROLES = ['OWNER', 'BRANCH_MANAGER', 'CASHIER'] as const;

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: FinancePostingService,
    private readonly policy: PolicyService,
    private readonly exceptions: ExceptionService,
  ) {}

  async open(input: { branchId: string; openingFloat?: number; deviceId?: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, POS_ROLES);
    const branch = await this.prisma.db.branch.findFirst({ where: { id: input.branchId, active: true } });
    if (!branch) throw new BadRequestException('Unknown or inactive branch');
    const existing = await this.prisma.db.shift.findFirst({ where: { branchId: input.branchId, cashierId: user.id, status: 'OPEN' } });
    if (existing) throw new ConflictException('You already have an open shift at this branch');
    const float = money(input.openingFloat ?? 0);
    return this.prisma.db.$transaction(async (tx) => {
      const shift = await tx.shift.create({ data: { tenantId: '', branchId: input.branchId, cashierId: user.id, deviceId: input.deviceId ?? null, openingFloat: float } });
      if (!float.isZero()) await tx.shiftCashEntry.create({ data: { tenantId: '', shiftId: shift.id, kind: 'FLOAT', amount: float, createdBy: user.id } });
      await this.audit.record({ action: 'shift.opened', entityType: 'Shift', entityId: shift.id, after: { branch: branch.code, float: float.toString() } }, tx);
      return shift;
    });
  }

  currentFor(user: RequestUser, branchId: string) {
    return this.prisma.db.shift.findFirst({ where: { branchId, cashierId: user.id, status: 'OPEN' } });
  }

  async get(id: string) {
    const s = await this.prisma.db.shift.findFirst({ where: { id }, include: { entries: { orderBy: { createdAt: 'asc' } } } });
    if (!s) throw new NotFoundException('Shift not found');
    return s;
  }

  list(filter: { branchId?: string; status?: 'OPEN' | 'CLOSED' }) {
    return this.prisma.db.shift.findMany({ where: filter, orderBy: { openedAt: 'desc' }, take: 100 });
  }

  async drawerCash(shiftId: string, db: Pick<ScopedTx, 'shiftCashEntry'> = this.prisma.db) {
    const agg = await db.shiftCashEntry.aggregate({ where: { shiftId }, _sum: { amount: true } });
    return money(agg._sum.amount ?? 0);
  }

  // A cash drop moves cash from the till to the safe. It stays inside the CASH ledger account, so no journal is needed.
  async drop(shiftId: string, input: { amount: number; reason?: string }, user: RequestUser) {
    const shift = await this.get(shiftId);
    assertBranchAccess(user, shift.branchId, POS_ROLES);
    if (shift.status !== 'OPEN') throw new ConflictException('Shift is closed');
    const amount = money(input.amount);
    if (!amount.gt(0)) throw new BadRequestException('Amount must be positive');
    if ((await this.drawerCash(shiftId)).lt(amount)) throw new BadRequestException('Drop is larger than the cash in the drawer');
    await this.prisma.db.shiftCashEntry.create({ data: { tenantId: '', shiftId, kind: 'DROP', amount: amount.negated(), refType: 'CashDrop', refId: shiftId, createdBy: user.id } });
    await this.audit.record({ action: 'shift.cash_drop', entityType: 'Shift', entityId: shiftId, after: { amount: amount.toString(), reason: input.reason } });
    return this.get(shiftId);
  }

  async close(shiftId: string, input: { countedCash: number }, user: RequestUser) {
    const shift = await this.get(shiftId);
    assertBranchAccess(user, shift.branchId, POS_ROLES);
    if (shift.status !== 'OPEN') throw new ConflictException('Shift is already closed');
    const open = await this.prisma.db.order.count({ where: { shiftId, status: { in: ['OPEN', 'SENT'] } } });
    if (open) throw new ConflictException(`${open} order(s) are still open on this shift; complete or void them first`);

    const expected = await this.drawerCash(shiftId);
    const counted = money(input.countedCash);
    const variance = counted.minus(expected);
    const branch = await this.prisma.db.branch.findFirstOrThrow({ where: { id: shift.branchId } });

    const closed = await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.shift.updateMany({ where: { id: shiftId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: user.id, expectedCash: expected, countedCash: counted, variance } });
      if (res.count !== 1) throw new ConflictException('Shift is already closed');
      let journalId: string | null = null;
      if (!variance.isZero()) {
        // Cash over/short is a fact: it is booked immediately, and unusual amounts are reviewed afterwards.
        const j = await this.posting.post(
          {
            sourceType: 'Shift',
            sourceId: shiftId,
            idempotencyKey: `shift:${shiftId}`,
            postingDate: ammanToday(),
            memo: `Cash ${variance.isNegative() ? 'shortage' : 'overage'} on shift close`,
            legalEntityId: branch.legalEntityId,
            branchId: branch.id,
            lines: variance.isNegative() ? [{ account: 'CASH_VARIANCE', debit: variance.abs() }, { account: 'CASH', credit: variance.abs() }] : [{ account: 'CASH', debit: variance }, { account: 'CASH_VARIANCE', credit: variance }],
          },
          tx,
        );
        journalId = j.id;
        await tx.shift.updateMany({ where: { id: shiftId }, data: { journalId } });
      }
      await this.audit.record({ action: 'shift.closed', entityType: 'Shift', entityId: shiftId, after: { expected: expected.toString(), counted: counted.toString(), variance: variance.toString() } }, tx);
      return tx.shift.findFirstOrThrow({ where: { id: shiftId } });
    });

    if (!variance.isZero()) {
      const decision = await this.policy.evaluate('pos.cash_variance', { amount: Number(variance.abs()), branchId: branch.id });
      if (decision.decision !== 'AUTO') {
        await this.exceptions.raise({
          code: 'POS_CASH_VARIANCE',
          reason: `Shift cash ${variance.isNegative() ? 'short' : 'over'} by ${variance.abs()} JOD at ${branch.name}`,
          evidence: { shiftId, expected: expected.toString(), counted: counted.toString(), variance: variance.toString(), cashierId: shift.cashierId },
          impact: 'Already booked to cash over/short; review the shift for causes',
          amount: Number(variance.abs()),
          branchId: branch.id,
          policyKey: 'pos.cash_variance',
          riskTier: 'MEDIUM',
          availableActions: ['resolve'],
        });
      }
    }
    return closed;
  }

  // Shift summary: what was sold, how it was paid, and what is expected in the drawer.
  async report(shiftId: string) {
    const shift = await this.get(shiftId);
    const [orders, tenders, refunds, entries] = await Promise.all([
      this.prisma.db.order.findMany({ where: { shiftId, status: 'COMPLETED' } }),
      this.prisma.db.tender.groupBy({ by: ['method'], where: { shiftId, status: 'CAPTURED' }, _sum: { amount: true }, _count: true }),
      this.prisma.db.refund.findMany({ where: { order: { shiftId } } }),
      this.prisma.db.shiftCashEntry.groupBy({ by: ['kind'], where: { shiftId }, _sum: { amount: true } }),
    ]);
    return {
      shift,
      orders: orders.length,
      gross: money(orders.reduce((s, o) => s.plus(o.subtotal), d(0))).toString(),
      discounts: money(orders.reduce((s, o) => s.plus(o.discountTotal), d(0))).toString(),
      total: money(orders.reduce((s, o) => s.plus(o.total), d(0))).toString(),
      tax: money(orders.reduce((s, o) => s.plus(o.taxTotal), d(0))).toString(),
      byTender: tenders.map((t) => ({ method: t.method, count: t._count, amount: money(t._sum.amount ?? 0).toString() })),
      refunds: { count: refunds.length, total: money(refunds.reduce((s, r) => s.plus(r.total), d(0))).toString() },
      cash: Object.fromEntries(entries.map((e) => [e.kind, money(e._sum.amount ?? 0).toString()])),
      expectedCash: (await this.drawerCash(shiftId)).toString(),
    };
  }
}
