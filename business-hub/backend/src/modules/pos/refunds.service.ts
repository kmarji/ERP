import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { actorHasRole, currentContext, currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { GiftCardService, LoyaltyService } from '../customers/customers.contracts';
import { PolicyService } from '../policy-engine/policy.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { ManagerOverride, OverrideService } from './override.service';
import { PosTerminalAdapter } from './pos.adapters';
import { proportion } from './pos-math';
import { SalesPostingService } from './sales-posting.service';
import { POS_ROLES, ShiftsService } from './shifts.service';

export const SALE_REFUNDED = 'sale.refunded';

export interface RefundInput {
  idempotencyKey: string;
  full?: boolean;
  lines?: { orderLineId: string; qty: number }[];
  reason: string;
  restock?: boolean;
  method?: 'CASH' | 'CARD' | 'DIGITAL' | 'GIFT_CARD' | 'MARKETPLACE';
  override?: ManagerOverride;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly shifts: ShiftsService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly sales: SalesPostingService,
    private readonly gifts: GiftCardService,
    private readonly loyalty: LoyaltyService,
    private readonly terminal: PosTerminalAdapter,
    private readonly exceptions: ExceptionService,
    private readonly events: EventEmitter2,
    private readonly overrides: OverrideService,
  ) {}

  // A refund is a credit note: it adds reversing records and never edits the original order, invoice or journals.
  async refund(orderId: string, input: RefundInput, user: RequestUser, opts: { system?: boolean } = {}) {
    const replay = await this.prisma.db.refund.findFirst({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } });
    if (replay) return replay;
    const order = await this.prisma.db.order.findFirst({ where: { id: orderId }, include: { lines: true, tenders: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (!opts.system) assertBranchAccess(user, order.branchId, [...POS_ROLES, 'FINANCE']);
    if (order.status !== 'COMPLETED') throw new ConflictException(`Only completed orders can be refunded (order is ${order.status})`);

    const prior = await this.prisma.db.refundLine.groupBy({ by: ['orderLineId'], where: { refund: { orderId } }, _sum: { total: true, tax: true } });
    const priorBy = new Map(prior.map((p) => [p.orderLineId, p._sum]));
    const wanted = input.full
      ? order.lines.filter((l) => !l.voided && l.qty - l.refundedQty > 0).map((l) => ({ orderLineId: l.id, qty: l.qty - l.refundedQty }))
      : input.lines ?? [];
    if (!wanted.length) throw new BadRequestException('Nothing to refund');

    const lines: { line: (typeof order.lines)[number]; qty: number; total: Prisma.Decimal; tax: Prisma.Decimal }[] = [];
    for (const w of wanted) {
      const line = order.lines.find((l) => l.id === w.orderLineId && !l.voided);
      if (!line) throw new BadRequestException(`Line ${w.orderLineId} is not refundable`);
      const remainingQty = line.qty - line.refundedQty;
      if (w.qty < 1 || w.qty > remainingQty) throw new BadRequestException(`Only ${remainingQty} of '${line.name}' can still be refunded`);
      const p = priorBy.get(line.id);
      const part = proportion(d(line.total).minus(d(p?.total)), d(line.tax).minus(d(p?.tax)), remainingQty, w.qty);
      lines.push({ line, qty: w.qty, total: part.total, tax: part.tax });
    }
    const total = lines.reduce((s, l) => s.plus(l.total), d(0));
    const tax = lines.reduce((s, l) => s.plus(l.tax), d(0));

    const captured = order.tenders.filter((t) => t.status === 'CAPTURED');
    const present = new Set(captured.map((t) => t.method as string));
    const dominant = [...captured].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    const method = input.method ?? ((dominant?.method as string) || 'CASH');
    if (!present.has(method) && !(method === 'CASH')) throw new BadRequestException(`The order was not paid by ${method}`);

    // Policy: small refunds go through; larger ones need a manager (explicit designated approval, recorded).
    // A refund decided by the marketplace itself is not ours to approve; it is recorded as system-approved.
    const decision = await this.policy.evaluate('pos.refund', { amount: Number(total), branchId: order.branchId });
    const approvedBy = opts.system ? 'system:marketplace' : await this.overrides.elevate(user, decision, order.branchId, `A refund of ${total} JOD`, input.override);

    const shift = await this.shifts.currentFor(user, order.branchId);
    if (method === 'CASH') {
      if (!shift) throw new ConflictException('Open a shift to pay out a cash refund');
      if ((await this.shifts.drawerCash(shift.id)).lt(total)) throw new BadRequestException('Not enough cash in the drawer for this refund');
    }
    const giftCode = method === 'GIFT_CARD' ? captured.find((t) => t.method === 'GIFT_CARD')?.reference : null;
    if (method === 'GIFT_CARD' && !giftCode) throw new BadRequestException('No gift card on this order to refund to');

    let refundId: string;
    try {
      refundId = await this.prisma.db.$transaction(async (tx) => {
        const number = await this.sequences.next('CN', 'CN', tx);
        const refund = await tx.refund.create({
          data: {
            tenantId: '',
            orderId,
            number,
            reason: input.reason,
            method,
            total,
            tax,
            net: total.minus(tax),
            restock: !!input.restock,
            approvedBy,
            idempotencyKey: input.idempotencyKey,
            correlationId: currentContext()?.correlationId ?? input.idempotencyKey,
            createdBy: user.id,
            lines: { create: lines.map((l) => ({ tenantId: currentTenantId(), orderLineId: l.line.id, qty: l.qty, total: l.total, tax: l.tax, net: l.total.minus(l.tax) })) },
          },
        });
        for (const l of lines) await tx.orderLine.updateMany({ where: { id: l.line.id }, data: { refundedQty: { increment: l.qty } } });
        const refundedTotal = d(order.refundedTotal).plus(total);
        await tx.order.updateMany({ where: { id: orderId }, data: { refundedTotal, refundStatus: refundedTotal.gte(order.total) ? 'FULL' : 'PARTIAL' } });
        if (method === 'CASH') await tx.shiftCashEntry.create({ data: { tenantId: '', shiftId: shift!.id, kind: 'REFUND', amount: total.negated(), refType: 'Refund', refId: refund.id, createdBy: user.id } });
        if (giftCode) await this.gifts.restore(tx, giftCode, total);
        if (order.customerId) {
          const points = Math.floor(Number(total));
          if (points > 0) await this.loyalty.clawback(tx, order.customerId, orderId, points);
        }
        await this.audit.record({ action: 'refund.created', entityType: 'Refund', entityId: refund.id, after: { number, order: order.number, total: total.toString(), method, approvedBy, restock: !!input.restock, reason: input.reason } }, tx);
        return refund.id;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.prisma.db.refund.findFirstOrThrow({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } });
      throw e;
    }

    // Card refunds go back through the terminal after the record exists; a failed payout becomes a visible exception.
    if (method === 'CARD' || method === 'DIGITAL') {
      const ref = captured.find((t) => t.method === method)?.reference ?? '';
      const res = await this.terminal.refund(ref, total.toString()).catch(() => ({ status: 'FAILED' as const, reference: ref }));
      if (res.status === 'FAILED') {
        await this.exceptions.raise({ code: 'POS_REFUND_PAYOUT_FAILED', reason: `Card refund of ${total} JOD for ${order.number} was recorded but the terminal refund failed`, evidence: { refundId, orderId }, amount: Number(total), branchId: order.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'MEDIUM', availableActions: ['resolve'] });
      }
    }
    await this.sales.postRefund(refundId);
    await this.events.emitAsync(SALE_REFUNDED, { tenantId: currentTenantId(), orderId, refundId });
    return this.prisma.db.refund.findFirstOrThrow({ where: { id: refundId }, include: { lines: true } });
  }

  list(orderId: string) {
    return this.prisma.db.refund.findMany({ where: { orderId }, include: { lines: true }, orderBy: { createdAt: 'asc' } });
  }
}
