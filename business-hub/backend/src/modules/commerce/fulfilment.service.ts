import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { KdsService } from '../kds/kds.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { NotificationsService } from '../notifications/notifications.module';
import { OrdersService } from '../pos/orders.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { CustomerNotificationAdapter, PaymentGatewayAdapter } from './commerce.adapters';

export const FULFILMENT_ROLES = ['OWNER', 'BRANCH_MANAGER', 'CASHIER', 'KITCHEN'] as const;

// Legal fulfilment moves. Anything not listed here is refused.
const NEXT: Record<string, string[]> = {
  PLACED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
};

const FINAL = ['DELIVERED', 'REJECTED', 'CANCELLED'];

@Injectable()
export class FulfilmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly kds: KdsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly customerNotifier: CustomerNotificationAdapter,
    private readonly gateway: PaymentGatewayAdapter,
    private readonly integrations: IntegrationsService,
    private readonly exceptions: ExceptionService,
  ) {}

  list(filter: { branchId?: string; status?: 'ACTIVE' | string; source?: string }) {
    const active = filter.status === 'ACTIVE' || !filter.status;
    return this.prisma.db.order.findMany({
      where: {
        branchId: filter.branchId,
        source: filter.source ?? { in: ['ONLINE', 'AGGREGATOR'] },
        fulfilmentStatus: active ? { notIn: FINAL, not: null } : filter.status,
      },
      include: { lines: true, tenders: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  private async load(id: string, user?: RequestUser) {
    const o = await this.prisma.db.order.findFirst({ where: { id }, include: { tenders: true } });
    if (!o || !o.fulfilmentStatus) throw new NotFoundException('Online order not found');
    if (user) assertBranchAccess(user, o.branchId, FULFILMENT_ROLES);
    return o;
  }

  private async move(order: { id: string; fulfilmentStatus: string | null }, to: string) {
    if (!NEXT[order.fulfilmentStatus ?? '']?.includes(to)) throw new ConflictException(`Order is ${order.fulfilmentStatus}; it cannot move to ${to}`);
    const res = await this.prisma.db.order.updateMany({ where: { id: order.id, fulfilmentStatus: order.fulfilmentStatus }, data: { fulfilmentStatus: to } });
    if (res.count !== 1) throw new ConflictException('The order was changed by someone else; reload it');
    await this.audit.record({ action: `fulfilment.${to.toLowerCase()}`, entityType: 'Order', entityId: order.id, before: { status: order.fulfilmentStatus }, after: { status: to } });
  }

  // Marketplace updates are queued: if the marketplace API is down they retry, and the kitchen keeps working.
  private async tellMarketplace(orderId: string, kind: 'respond' | 'status', detail: Record<string, unknown>) {
    const inbound = await this.prisma.db.aggregatorInbound.findFirst({ where: { orderId } });
    if (!inbound) return;
    await this.integrations.enqueue({
      adapter: 'aggregator',
      operation: kind,
      payload: { connectionId: inbound.connectionId, externalId: inbound.externalId, ...detail },
      idempotencyKey: `agg:${kind}:${inbound.externalId}:${JSON.stringify(detail)}`,
    });
  }

  private async notifyCustomer(order: { contact: unknown; number: string; trackingCode: string | null }, template: string, text: string, textAr: string) {
    const c = (order.contact as { phone?: string; email?: string } | null) ?? {};
    if (!c.phone && !c.email) return;
    await this.customerNotifier.send({ phone: c.phone, email: c.email, template, text: `${text} (${order.number}${order.trackingCode ? `, track: ${order.trackingCode}` : ''})`, textAr });
  }

  async accept(id: string, user?: RequestUser) {
    const o = await this.load(id, user);
    await this.move(o, 'ACCEPTED');
    await this.orders.sendAsSystem(id);
    await this.tellMarketplace(id, 'respond', { decision: 'ACCEPT' });
    await this.notifyCustomer(o, 'order_accepted', 'Your order was accepted and is being prepared.', 'تم قبول طلبك وجاري تحضيره.');
    return this.orders.detail(id);
  }

  async reject(id: string, reason: string, user?: RequestUser) {
    const o = await this.load(id, user);
    await this.move(o, 'REJECTED');
    await this.cancelPaid(o.id, reason, 'REJECTED');
    await this.tellMarketplace(id, 'respond', { decision: 'REJECT', reason });
    await this.notifyCustomer(o, 'order_rejected', `Sorry, we could not accept your order: ${reason}`, 'نعتذر، لم نتمكن من قبول طلبك.');
    return this.orders.detail(id);
  }

  async ready(id: string, user?: RequestUser) {
    const o = await this.load(id, user);
    await this.move(o, 'READY');
    await this.tellMarketplace(id, 'status', { status: 'READY' });
    await this.notifyCustomer(o, 'order_ready', o.channel === 'DELIVERY' ? 'Your order is ready and will be dispatched shortly.' : 'Your order is ready for pickup.', 'طلبك جاهز.');
    return this.orders.detail(id);
  }

  async dispatch(id: string, input: { driver?: string }, user?: RequestUser) {
    const o = await this.load(id, user);
    if (o.channel !== 'DELIVERY' && o.source !== 'AGGREGATOR') throw new BadRequestException('Only delivery orders are dispatched');
    await this.move(o, 'OUT_FOR_DELIVERY');
    await this.prisma.db.order.updateMany({ where: { id }, data: { notes: input.driver ? `${o.notes ?? ''} Driver: ${input.driver}`.trim() : o.notes } });
    await this.tellMarketplace(id, 'status', { status: 'OUT_FOR_DELIVERY' });
    await this.notifyCustomer(o, 'order_dispatched', 'Your order is on its way.', 'طلبك في الطريق إليك.');
    return this.orders.detail(id);
  }

  // Handing over completes the sale: stock, revenue and tax post now. Cash on delivery is collected here.
  async deliver(id: string, input: { cash?: { tendered: number } }, user: RequestUser) {
    const o = await this.load(id, user);
    if (o.fulfilmentStatus === 'DELIVERED') return this.orders.detail(id);
    if (!['READY', 'OUT_FOR_DELIVERY'].includes(o.fulfilmentStatus ?? '')) throw new ConflictException(`Order is ${o.fulfilmentStatus}; mark it ready first`);
    if (o.channel === 'DELIVERY' && o.source === 'ONLINE' && o.fulfilmentStatus !== 'OUT_FOR_DELIVERY') throw new ConflictException('Dispatch the order before marking it delivered');
    const captured = o.tenders.filter((t) => t.status === 'CAPTURED').reduce((s, t) => s.plus(t.amount), d(0));
    if (captured.lt(o.total)) {
      if (!input.cash) throw new BadRequestException(`${money(d(o.total).minus(captured))} JOD is still due: collect cash and pass cash.tendered`);
      await this.orders.addTender(id, { method: 'CASH', tendered: input.cash.tendered, idempotencyKey: `deliver:${id}` }, user);
    }
    await this.orders.complete(id, user);
    await this.prisma.db.order.updateMany({ where: { id }, data: { fulfilmentStatus: 'DELIVERED' } });
    await this.tellMarketplace(id, 'status', { status: 'DELIVERED' });
    await this.notifyCustomer(o, 'order_delivered', 'Delivered. Enjoy your meal!', 'تم التسليم. بالهناء والشفاء!');
    return this.orders.detail(id);
  }

  async cancel(id: string, reason: string, user?: RequestUser) {
    const o = await this.load(id, user);
    await this.move(o, 'CANCELLED');
    await this.cancelPaid(o.id, reason, 'CANCELLED');
    await this.tellMarketplace(id, 'status', { status: 'CANCELLED' });
    await this.notifyCustomer(o, 'order_cancelled', `Your order was cancelled: ${reason}`, 'تم إلغاء طلبك.');
    return this.orders.detail(id);
  }

  // Nothing has reached the ledger before completion, so cancelling an unfinished order just undoes the payment.
  // Online card payments are refunded through the gateway; marketplace payments are the marketplace's to return.
  async cancelPaid(orderId: string, reason: string, _final: string) {
    const order = await this.prisma.db.order.findFirstOrThrow({ where: { id: orderId }, include: { tenders: true } });
    if (order.status === 'COMPLETED') throw new ConflictException('The order is already completed; issue a refund instead');
    const refunds: { reference: string; amount: string }[] = [];
    for (const t of order.tenders.filter((x) => x.status === 'CAPTURED' && x.method === 'CARD' && x.reference)) {
      const r = await this.gateway.refund(t.reference!, t.amount.toString()).catch(() => ({ status: 'FAILED' as const, reference: t.reference! }));
      if (r.status === 'FAILED') {
        await this.exceptions.raise({ code: 'ONLINE_REFUND_FAILED', reason: `Refund of ${t.amount} JOD for cancelled order ${order.number} failed at the payment gateway`, evidence: { orderId, tenderId: t.id, reference: t.reference }, amount: Number(t.amount), branchId: order.branchId, ownerRole: 'FINANCE', riskTier: 'MEDIUM', availableActions: ['resolve'] });
      } else refunds.push({ reference: r.reference, amount: t.amount.toString() });
    }
    await this.prisma.db.$transaction(async (tx) => {
      await tx.tender.updateMany({ where: { orderId, status: { in: ['CAPTURED', 'AUTHORIZED'] } }, data: { status: 'VOIDED' } });
      await tx.order.updateMany({ where: { id: orderId, status: { in: ['OPEN', 'SENT'] } }, data: { status: 'VOIDED', notes: reason } });
      await this.kds.cancelOrder(tx, orderId);
      await this.audit.record({ action: 'online_order.cancelled', entityType: 'Order', entityId: orderId, after: { reason, refunds } }, tx);
    });
    return { refunds };
  }

  async staffAlert(branchId: string, title: string, body: string) {
    await this.notifications.notify({ roleKey: 'BRANCH_MANAGER', title, body });
    return { tenantId: currentTenantId(), branchId };
  }
}
