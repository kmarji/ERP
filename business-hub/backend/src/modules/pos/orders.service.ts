import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Decimal, d, money } from '../../common/money';
import { PrismaService, ScopedTx } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { actorHasRole, currentContext, currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { GiftCardService, LoyaltyService, VoucherService } from '../customers/customers.contracts';
import { KdsService } from '../kds/kds.service';
import { MenuService } from '../menu/menu.service';
import { EvalResult } from '../policy-engine/policy-decision';
import { PolicyService } from '../policy-engine/policy.service';
import { ManagerOverride, OverrideService } from './override.service';
import { PosTerminalAdapter } from './pos.adapters';
import { allocateDiscount, DiscountSpec, lineAmounts, resolveDiscounts } from './pos-math';
import { SalesPostingService } from './sales-posting.service';
import { POS_ROLES, ShiftsService } from './shifts.service';

export interface LineInput {
  menuItemId: string;
  variantId?: string;
  modifierIds?: string[];
  qty: number;
  notes?: string;
  // A service charge (e.g. delivery fee) is billed like an item but never goes to the kitchen.
  service?: boolean;
  // Offline devices charge the price they had cached; the server keeps it and flags large differences.
  unitPriceOverride?: number;
}

export interface CreateOrderInput {
  idempotencyKey: string;
  branchId: string;
  channel?: 'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY';
  tableId?: string;
  customerId?: string;
  guestCount?: number;
  notes?: string;
  lines: LineInput[];
}

export const SALE_FINALIZED = 'sale.finalized';
export interface SaleFinalizedEvent {
  tenantId: string;
  orderId: string;
}

const EDITABLE = ['OPEN', 'SENT'];

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuService,
    private readonly kds: KdsService,
    private readonly vouchers: VoucherService,
    private readonly gifts: GiftCardService,
    private readonly loyalty: LoyaltyService,
    private readonly terminal: PosTerminalAdapter,
    private readonly policy: PolicyService,
    private readonly shifts: ShiftsService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly sales: SalesPostingService,
    private readonly events: EventEmitter2,
    private readonly overrides: OverrideService,
  ) {}

  // ---------------------------------------------------------------- reads

  async detail(id: string) {
    const o = await this.prisma.db.order.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } }, tenders: true, invoice: true, refunds: { include: { lines: true } }, tickets: true } });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  list(filter: { branchId?: string; status?: string; from?: Date; to?: Date; take?: number }) {
    return this.prisma.db.order.findMany({
      where: { branchId: filter.branchId, status: filter.status as any, ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}) },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.take ?? 50, 200),
    });
  }

  async forUser(id: string, user: RequestUser) {
    const o = await this.prisma.db.order.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Order not found');
    assertBranchAccess(user, o.branchId, [...POS_ROLES, 'FINANCE']);
    return o;
  }

  private async editable(id: string, user: RequestUser) {
    const o = await this.forUser(id, user);
    if (!EDITABLE.includes(o.status)) throw new ConflictException(`Order is ${o.status}`);
    return o;
  }

  // ---------------------------------------------------------------- create and edit

  async create(input: CreateOrderInput, user: RequestUser, opts: { source?: string; externalRef?: string; skipShift?: boolean; createdAt?: Date; shiftId?: string; system?: boolean; fulfilmentStatus?: string; trackingCode?: string; promisedAt?: Date; contact?: object; discounts?: DiscountSpec[]; channel?: CreateOrderInput['channel'] | 'ONLINE' | 'AGGREGATOR' } = {}) {
    if (!opts.system) assertBranchAccess(user, input.branchId, POS_ROLES);
    const replay = await this.prisma.db.order.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return this.detail(replay.id);

    const branch = await this.prisma.db.branch.findFirst({ where: { id: input.branchId, active: true } });
    if (!branch) throw new BadRequestException('Unknown or inactive branch');
    const shift = opts.system ? null : opts.shiftId ? await this.prisma.db.shift.findFirst({ where: { id: opts.shiftId, branchId: input.branchId, status: 'OPEN' } }) : await this.shifts.currentFor(user, input.branchId);
    if (!shift && !opts.skipShift && !opts.system) throw new ConflictException(opts.shiftId ? 'The shift is closed or not at this branch' : 'Open a shift before taking orders');
    if (input.tableId) await this.assertTableFree(input.tableId, input.branchId);
    if (input.customerId && !(await this.prisma.db.customer.findFirst({ where: { id: input.customerId } }))) throw new BadRequestException('Unknown customer');
    const rows = await this.buildLines(input.branchId, input.lines, opts.createdAt);

    try {
      const id = await this.prisma.db.$transaction(async (tx) => {
        const number = await this.sequences.next(`ORD:${branch.id}`, branch.code, tx);
        const order = await tx.order.create({
          data: {
            tenantId: '',
            number,
            branchId: branch.id,
            shiftId: shift?.id ?? null,
            tableId: input.tableId ?? null,
            channel: (opts.channel ?? input.channel ?? 'DINE_IN') as any,
            customerId: input.customerId ?? null,
            fulfilmentStatus: opts.fulfilmentStatus ?? null,
            trackingCode: opts.trackingCode ?? null,
            promisedAt: opts.promisedAt ?? null,
            contact: (opts.contact ?? undefined) as any,
            discounts: (opts.discounts ?? []) as any,
            guestCount: input.guestCount ?? null,
            notes: input.notes ?? null,
            source: opts.source ?? 'POS',
            externalRef: opts.externalRef ?? null,
            idempotencyKey: input.idempotencyKey,
            correlationId: currentContext()?.correlationId ?? input.idempotencyKey,
            createdBy: user.id,
            ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
            lines: { create: rows.map((r) => ({ tenantId: currentTenantId(), ...r })) },
          },
        });
        await this.recompute(tx, order.id);
        await this.audit.record({ action: 'order.created', entityType: 'Order', entityId: order.id, after: { number, channel: input.channel ?? 'DINE_IN', lines: rows.length } }, tx);
        return order.id;
      });
      return this.detail(id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.db.order.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
        if (again) return this.detail(again.id);
      }
      throw e;
    }
  }

  private async assertTableFree(tableId: string, branchId: string) {
    const table = await this.prisma.db.diningTable.findFirst({ where: { id: tableId, branchId } });
    if (!table) throw new BadRequestException('Table does not belong to this branch');
    const busy = await this.prisma.db.order.findFirst({ where: { tableId, status: { in: ['OPEN', 'SENT'] } } });
    if (busy) throw new ConflictException(`Table ${table.name} already has open order ${busy.number}`);
  }

  private async buildLines(branchId: string, inputs: LineInput[], at?: Date) {
    const rows = [];
    for (const l of inputs) {
      const r = await this.menu.resolveLine({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: l.modifierIds, branchId, at });
      const unitPrice = l.unitPriceOverride !== undefined ? money(l.unitPriceOverride) : r.unitPrice;
      const a = lineAmounts(l.qty, unitPrice, r.taxRate);
      rows.push({ menuItemId: r.menuItemId, variantId: r.variantId, name: r.name, nameAr: r.nameAr, qty: l.qty, unitPrice, modifiers: r.modifiers as any, gross: a.gross, discount: a.discount, total: a.total, taxRate: r.taxRate, tax: a.tax, net: a.net, stationKey: l.service ? null : r.stationKey, notes: l.notes ?? null, sentAt: l.service ? new Date() : null });
    }
    return rows;
  }

  async addLines(orderId: string, lines: LineInput[], user: RequestUser) {
    const order = await this.editable(orderId, user);
    const rows = await this.buildLines(order.branchId, lines);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.orderLine.createMany({ data: rows.map((r) => ({ tenantId: currentTenantId(), orderId, ...r })) });
      await this.recompute(tx, orderId);
      await this.audit.record({ action: 'order.lines_added', entityType: 'Order', entityId: orderId, after: { lines: rows.length } }, tx);
    });
    return this.detail(orderId);
  }

  // Unsent lines can be removed freely; a line the kitchen already has needs a manager (policy pos.void_sent_line).
  async voidLine(orderId: string, lineId: string, reason: string, user: RequestUser, override?: ManagerOverride) {
    const order = await this.editable(orderId, user);
    const line = await this.prisma.db.orderLine.findFirst({ where: { id: lineId, orderId } });
    if (!line) throw new NotFoundException('Line not found');
    if (line.voided) throw new ConflictException('Line already voided');
    let approvedBy: string | null = null;
    if (line.sentAt) {
      const decision = await this.policy.evaluate('pos.void_sent_line', { amount: Number(line.total), branchId: order.branchId });
      approvedBy = await this.overrides.elevate(user, decision, order.branchId, 'Voiding a line already sent to the kitchen', override);
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.orderLine.updateMany({ where: { id: lineId }, data: { voided: true, voidReason: reason } });
      if (line.sentAt) await this.kds.cancelLines(tx, orderId, [lineId]);
      await this.recompute(tx, orderId);
      await this.audit.record({ action: 'order.line_voided', entityType: 'Order', entityId: orderId, after: { lineId, reason, approvedBy, sent: !!line.sentAt } }, tx);
    });
    return this.detail(orderId);
  }

  // Header details that may change while the order is still open.
  async patchOrder(orderId: string, input: { customerId?: string; notes?: string; guestCount?: number }, user: RequestUser) {
    await this.editable(orderId, user);
    if (input.customerId && !(await this.prisma.db.customer.findFirst({ where: { id: input.customerId } }))) throw new BadRequestException('Unknown customer');
    await this.prisma.db.order.updateMany({ where: { id: orderId }, data: input });
    await this.audit.record({ action: 'order.updated', entityType: 'Order', entityId: orderId, after: input });
    return this.detail(orderId);
  }

  // Quantity of a line the kitchen has not seen yet; once sent, change it by voiding (with approval) and adding.
  async setLineQty(orderId: string, lineId: string, qty: number, user: RequestUser) {
    await this.editable(orderId, user);
    const line = await this.prisma.db.orderLine.findFirst({ where: { id: lineId, orderId, voided: false } });
    if (!line) throw new NotFoundException('Line not found');
    if (line.sentAt) throw new ConflictException('This line was already sent to the kitchen; void it and add a new one');
    await this.prisma.db.$transaction(async (tx) => {
      await tx.orderLine.updateMany({ where: { id: lineId }, data: { qty } });
      await this.recompute(tx, orderId);
      await this.audit.record({ action: 'order.line_qty_changed', entityType: 'Order', entityId: orderId, before: { qty: line.qty }, after: { lineId, qty } }, tx);
    });
    return this.detail(orderId);
  }

  // ---------------------------------------------------------------- discounts

  async applyDiscount(orderId: string, input: { kind: 'PERCENT' | 'AMOUNT'; value: number; reason: string; override?: ManagerOverride }, user: RequestUser) {
    const order = await this.editable(orderId, user);
    if (input.value <= 0) throw new BadRequestException('Discount must be positive');
    const gross = d(order.subtotal);
    if (gross.isZero()) throw new BadRequestException('Nothing to discount');
    const amount = input.kind === 'PERCENT' ? money(gross.times(input.value).div(100)) : money(input.value);
    const pct = amount.div(gross).times(100).toNumber();
    const decision = await this.policy.evaluate('pos.discount', { amount: Number(amount), variancePct: pct, branchId: order.branchId });
    const approvedBy = await this.overrides.elevate(user, decision, order.branchId, `A ${pct.toFixed(1)}% discount`, input.override);
    return this.addDiscount(orderId, { kind: input.kind, value: input.value, reason: input.reason, approvedBy });
  }

  async applyVoucher(orderId: string, code: string, user: RequestUser) {
    const order = await this.editable(orderId, user);
    const specs = (order.discounts as unknown as DiscountSpec[]) ?? [];
    if (specs.some((s) => s.kind === 'VOUCHER')) throw new ConflictException('A voucher is already applied');
    const afterOthers = d(order.subtotal).minus(d(order.discountTotal));
    const v = await this.vouchers.validate(code, afterOthers);
    return this.addDiscount(orderId, { kind: 'VOUCHER', value: 0, amount: Number(v.discount), reason: `Voucher ${code}`, voucherId: v.voucherId });
  }

  async applyLoyalty(orderId: string, points: number, user: RequestUser) {
    const order = await this.editable(orderId, user);
    if (!order.customerId) throw new BadRequestException('Attach a customer to redeem loyalty points');
    const customer = await this.prisma.db.customer.findFirstOrThrow({ where: { id: order.customerId } });
    if (customer.points < points) throw new BadRequestException(`Customer has ${customer.points} points`);
    return this.addDiscount(orderId, { kind: 'LOYALTY', value: 0, amount: points / 100, reason: `${points} loyalty points`, points });
  }

  private async addDiscount(orderId: string, spec: DiscountSpec) {
    await this.prisma.db.$transaction(async (tx) => {
      const o = await tx.order.findFirstOrThrow({ where: { id: orderId } });
      await tx.order.updateMany({ where: { id: orderId }, data: { discounts: [...((o.discounts as unknown as DiscountSpec[]) ?? []), spec] as any } });
      await this.recompute(tx, orderId);
      await this.audit.record({ action: 'order.discount_applied', entityType: 'Order', entityId: orderId, after: spec }, tx);
    });
    return this.detail(orderId);
  }

  // Re-derives every line and the order totals from unit prices and the discount list, so the numbers always agree.
  private async recompute(tx: ScopedTx, orderId: string) {
    const order = await tx.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: true } });
    const active = order.lines.filter((l) => !l.voided);
    const grosses = active.map((l) => money(d(l.unitPrice).times(l.qty)));
    const gross = grosses.reduce((s, g) => s.plus(g), d(0));
    const specs = ((order.discounts as unknown as DiscountSpec[]) ?? []).map((s) => ({ ...s }));
    const { amounts, total: discTotal } = resolveDiscounts(gross, specs);
    const alloc = allocateDiscount(grosses, discTotal);
    let total = d(0);
    let tax = d(0);
    let discount = d(0);
    for (const [i, l] of active.entries()) {
      const a = lineAmounts(l.qty, d(l.unitPrice), d(l.taxRate), alloc[i]);
      await tx.orderLine.updateMany({ where: { id: l.id }, data: { gross: a.gross, discount: a.discount, total: a.total, tax: a.tax, net: a.net } });
      total = total.plus(a.total);
      tax = tax.plus(a.tax);
      discount = discount.plus(a.discount);
    }
    await tx.order.updateMany({
      where: { id: orderId },
      data: { subtotal: gross, discountTotal: discount, total, taxTotal: tax, discounts: specs.map((s, i) => ({ ...s, resolved: amounts[i].toString() })) as any },
    });
  }

  // ---------------------------------------------------------------- kitchen, tables, splitting

  // Used for orders that arrive from outside (online, marketplaces) where no cashier is involved.
  async sendAsSystem(orderId: string) {
    await this.prisma.db.$transaction((tx) => this.sendTx(tx, orderId));
    return this.detail(orderId);
  }

  async send(orderId: string, user: RequestUser) {
    await this.editable(orderId, user);
    await this.prisma.db.$transaction((tx) => this.sendTx(tx, orderId));
    return this.detail(orderId);
  }

  private async sendTx(tx: ScopedTx, orderId: string) {
    const order = await tx.order.findFirstOrThrow({ where: { id: orderId }, include: { lines: true } });
    const unsent = order.lines.filter((l) => !l.voided && !l.sentAt);
    if (!unsent.length) return;
    await tx.orderLine.updateMany({ where: { id: { in: unsent.map((l) => l.id) } }, data: { sentAt: new Date() } });
    await tx.order.updateMany({ where: { id: orderId, status: 'OPEN' }, data: { status: 'SENT' } });
    await this.kds.createTickets(tx, { id: order.id, branchId: order.branchId, channel: order.channel }, unsent.map((l) => ({ id: l.id, name: l.name, qty: l.qty, modifiers: ((l.modifiers as any[]) ?? []).map((m) => ({ id: m.id, name: m.name })), notes: l.notes, stationKey: l.stationKey })));
  }

  async transferTable(orderId: string, tableId: string, user: RequestUser) {
    const order = await this.editable(orderId, user);
    await this.assertTableFree(tableId, order.branchId);
    await this.prisma.db.order.updateMany({ where: { id: orderId }, data: { tableId } });
    await this.audit.record({ action: 'order.table_transferred', entityType: 'Order', entityId: orderId, before: { tableId: order.tableId }, after: { tableId } });
    return this.detail(orderId);
  }

  // Bill splitting by items: the chosen lines move to a new order on the same table, each paid separately.
  async split(orderId: string, lineIds: string[], user: RequestUser) {
    const order = await this.editable(orderId, user);
    const lines = await this.prisma.db.orderLine.findMany({ where: { orderId, id: { in: lineIds }, voided: false } });
    const remaining = await this.prisma.db.orderLine.count({ where: { orderId, voided: false } });
    if (lines.length !== lineIds.length) throw new BadRequestException('Some lines are not on this order or are voided');
    if (lines.length >= remaining) throw new BadRequestException('Leave at least one line on the original order');
    const branch = await this.prisma.db.branch.findFirstOrThrow({ where: { id: order.branchId } });
    const newId = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next(`ORD:${branch.id}`, branch.code, tx);
      const child = await tx.order.create({
        data: { tenantId: '', number, branchId: order.branchId, shiftId: order.shiftId, tableId: order.tableId, channel: order.channel, status: order.status, customerId: order.customerId, source: order.source, notes: `Split from ${order.number}`, idempotencyKey: `split:${randomUUID()}`, correlationId: order.correlationId, createdBy: user.id },
      });
      await tx.orderLine.updateMany({ where: { id: { in: lineIds } }, data: { orderId: child.id } });
      await this.recompute(tx, order.id);
      await this.recompute(tx, child.id);
      await this.audit.record({ action: 'order.split', entityType: 'Order', entityId: order.id, after: { child: number, lines: lineIds.length } }, tx);
      return child.id;
    });
    return { original: await this.detail(orderId), split: await this.detail(newId) };
  }

  // ---------------------------------------------------------------- payments

  async addTender(orderId: string, input: { method: 'CASH' | 'CARD' | 'DIGITAL' | 'GIFT_CARD'; amount?: number; tendered?: number; reference?: string; idempotencyKey: string }, user: RequestUser, opts: { useOrderShift?: boolean } = {}) {
    const order = await this.forUser(orderId, user);
    const replay = await this.prisma.db.tender.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return replay;
    if (!EDITABLE.includes(order.status)) throw new ConflictException(`Order is ${order.status}`);
    const captured = await this.prisma.db.tender.aggregate({ where: { orderId, status: 'CAPTURED' }, _sum: { amount: true } });
    const due = d(order.total).minus(d(captured._sum.amount ?? 0));
    if (!due.gt(0)) throw new ConflictException('The order is already fully paid');

    const shift = opts.useOrderShift && order.shiftId ? await this.prisma.db.shift.findFirst({ where: { id: order.shiftId, status: 'OPEN' } }) : await this.shifts.currentFor(user, order.branchId);
    if (input.method === 'CASH' && !shift) throw new ConflictException('Open a shift to take cash');

    let amount: Decimal;
    let tendered: Decimal;
    let change = d(0);
    if (input.method === 'CASH') {
      tendered = money(input.tendered ?? input.amount ?? due);
      amount = Decimal.min(tendered, due);
      change = tendered.minus(amount);
    } else {
      amount = money(input.amount ?? due);
      if (!amount.gt(0) || amount.gt(due)) throw new BadRequestException(`Amount must be between 0.001 and the amount due (${due})`);
      tendered = amount;
    }
    const base = { tenantId: '', orderId, shiftId: shift?.id ?? order.shiftId, method: input.method, amount, tendered, change, idempotencyKey: input.idempotencyKey, correlationId: currentContext()?.correlationId ?? input.idempotencyKey, createdBy: user.id };

    try {
      if (input.method === 'CASH') {
        return await this.prisma.db.$transaction(async (tx) => {
          const t = await tx.tender.create({ data: { ...base, status: 'CAPTURED', capturedAt: new Date() } });
          await tx.shiftCashEntry.create({ data: { tenantId: '', shiftId: shift!.id, kind: 'SALE', amount, refType: 'Tender', refId: t.id, createdBy: user.id } });
          return t;
        });
      }
      if (input.method === 'GIFT_CARD') {
        if (!input.reference) throw new BadRequestException('Gift card code is required as reference');
        return await this.prisma.db.$transaction(async (tx) => {
          await this.gifts.redeem(tx, input.reference!, amount);
          return tx.tender.create({ data: { ...base, status: 'CAPTURED', reference: input.reference, capturedAt: new Date() } });
        });
      }
      // Card and digital: authorization and capture are separate states, both independent of the order's status.
      const auth = await this.terminal.authorize({ amount: amount.toString(), reference: input.reference, method: input.method });
      if (auth.status === 'DECLINED') {
        const failed = await this.prisma.db.tender.create({ data: { ...base, status: 'FAILED', reference: auth.reference } });
        await this.audit.record({ action: 'tender.declined', entityType: 'Tender', entityId: failed.id, outcome: 'FAILURE', externalResponse: auth });
        return failed;
      }
      const authorized = await this.prisma.db.tender.create({ data: { ...base, status: 'AUTHORIZED', reference: auth.reference } });
      const cap = await this.terminal.capture(auth.reference);
      if (cap.status !== 'CAPTURED') return authorized;
      await this.prisma.db.tender.updateMany({ where: { id: authorized.id }, data: { status: 'CAPTURED', capturedAt: new Date() } });
      return this.prisma.db.tender.findFirstOrThrow({ where: { id: authorized.id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.db.tender.findFirstOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- completion

  async complete(orderId: string, user: RequestUser) {
    const order = await this.forUser(orderId, user);
    if (order.status === 'COMPLETED') return this.detail(orderId);
    if (!EDITABLE.includes(order.status)) throw new ConflictException(`Order is ${order.status}`);
    const paid = await this.prisma.db.tender.aggregate({ where: { orderId, status: 'CAPTURED' }, _sum: { amount: true } });
    const paidAmt = d(paid._sum.amount ?? 0);
    if (paidAmt.lt(order.total)) throw new BadRequestException(`Underpaid: ${order.total} due, ${paidAmt} captured`);
    const active = await this.prisma.db.orderLine.count({ where: { orderId, voided: false } });
    if (!active) throw new BadRequestException('The order has no lines; void it instead');

    await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.order.updateMany({ where: { id: orderId, status: { in: EDITABLE as any } }, data: { status: 'COMPLETED', completedAt: new Date() } });
      if (res.count !== 1) throw new ConflictException('Order was completed or voided concurrently');
      await this.sendTx(tx, orderId); // quick-service sales go to the kitchen when paid
      const fresh = await tx.order.findFirstOrThrow({ where: { id: orderId } });
      const number = await this.sequences.next('SINV', 'SI', tx);
      await tx.invoice.create({ data: { tenantId: '', orderId, number, subtotal: fresh.subtotal, discountTotal: fresh.discountTotal, taxTotal: fresh.taxTotal, total: fresh.total } });
      for (const s of (fresh.discounts as unknown as DiscountSpec[]) ?? []) {
        if (s.kind === 'VOUCHER' && s.voucherId) await this.vouchers.redeem(tx, s.voucherId, orderId);
        if (s.kind === 'LOYALTY' && s.points && fresh.customerId) await this.loyalty.redeem(tx, fresh.customerId, orderId, s.points);
      }
      if (fresh.customerId && fresh.total.gt(0)) await this.loyalty.earn(tx, fresh.customerId, orderId, Math.floor(Number(fresh.total)));
      await tx.businessEvent.create({
        data: { tenantId: '', type: 'SaleFinalized', aggregateType: 'Order', aggregateId: orderId, payload: { orderId, number: fresh.number, branchId: fresh.branchId, total: fresh.total.toString(), tax: fresh.taxTotal.toString() } as any, idempotencyKey: `order:${orderId}:SaleFinalized`, correlationId: fresh.correlationId, createdBy: user.id },
      });
      await this.audit.record({ action: 'order.completed', entityType: 'Order', entityId: orderId, after: { number: fresh.number, total: fresh.total.toString(), invoice: number } }, tx);
    });

    await this.sales.postSale(orderId);
    await this.events.emitAsync(SALE_FINALIZED, { tenantId: currentTenantId(), orderId } satisfies SaleFinalizedEvent);
    return this.detail(orderId);
  }

  async voidOrder(orderId: string, reason: string, user: RequestUser, override?: ManagerOverride) {
    const order = await this.editable(orderId, user);
    const paid = await this.prisma.db.tender.count({ where: { orderId, status: { in: ['CAPTURED', 'AUTHORIZED'] } } });
    if (paid) throw new ConflictException('The order has payments; complete it and issue a refund instead');
    if (order.status === 'SENT') {
      const decision = await this.policy.evaluate('pos.void_sent_line', { amount: Number(order.total), branchId: order.branchId });
      await this.overrides.elevate(user, decision, order.branchId, 'Voiding an order already sent to the kitchen', override);
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.order.updateMany({ where: { id: orderId, status: { in: EDITABLE as any } }, data: { status: 'VOIDED', notes: reason } });
      await this.kds.cancelOrder(tx, orderId);
      await this.audit.record({ action: 'order.voided', entityType: 'Order', entityId: orderId, after: { reason } }, tx);
    });
    return this.detail(orderId);
  }

  async receipt(orderId: string) {
    const o = await this.detail(orderId);
    const [branch, entity] = await Promise.all([
      this.prisma.db.branch.findFirstOrThrow({ where: { id: o.branchId } }),
      this.prisma.db.branch.findFirstOrThrow({ where: { id: o.branchId } }).then((b) => this.prisma.db.legalEntity.findFirstOrThrow({ where: { id: b.legalEntityId } })),
    ]);
    const lines = o.lines.filter((l) => !l.voided);
    const taxByRate = new Map<string, { net: Decimal; tax: Decimal }>();
    for (const l of lines) {
      const k = d(l.taxRate).times(100).toString();
      const cur = taxByRate.get(k) ?? { net: d(0), tax: d(0) };
      taxByRate.set(k, { net: cur.net.plus(l.net), tax: cur.tax.plus(l.tax) });
    }
    return {
      invoiceNumber: o.invoice?.number ?? null,
      orderNumber: o.number,
      issuedAt: o.invoice?.issuedAt ?? null,
      seller: { name: entity.name, taxNumber: entity.taxNumber, branch: branch.name },
      lines: lines.map((l) => ({ name: l.name, nameAr: l.nameAr, qty: l.qty, unitPrice: l.unitPrice.toString(), modifiers: l.modifiers, discount: l.discount.toString(), total: l.total.toString() })),
      subtotal: o.subtotal.toString(),
      discount: o.discountTotal.toString(),
      total: o.total.toString(),
      taxBreakdown: [...taxByRate].map(([ratePct, v]) => ({ ratePct, net: money(v.net).toString(), tax: money(v.tax).toString() })),
      tenders: o.tenders.filter((t) => t.status === 'CAPTURED').map((t) => ({ method: t.method, amount: t.amount.toString(), tendered: t.tendered.toString(), change: t.change.toString() })),
      eInvoice: { status: o.invoice?.externalStatus ?? 'NOT_REQUIRED', reference: o.invoice?.externalRef ?? null, qr: null },
      currency: 'JOD',
    };
  }
}
