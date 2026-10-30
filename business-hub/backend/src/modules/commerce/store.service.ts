import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../pos/orders.service';
import { CustomerNotificationAdapter, PaymentGatewayAdapter } from './commerce.adapters';
import { FulfilmentService } from './fulfilment.service';

export const SYSTEM_USER: RequestUser = { id: 'system', tenantId: '', email: 'system', isSystem: true, roles: [], delegations: [] };

export interface PlaceOrderInput {
  idempotencyKey: string;
  branchId: string;
  fulfilment: 'PICKUP' | 'DELIVERY';
  customer: { name: string; phone: string; email?: string; consent?: boolean };
  address?: { area: string; text: string };
  scheduledFor?: string;
  notes?: string;
  lines: { menuItemId: string; variantId?: string; modifierIds?: string[]; qty: number; notes?: string }[];
  payment: { method: 'CASH_ON_DELIVERY' | 'CARD_ONLINE'; token?: string };
}

@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly menu: MenuService,
    private readonly gateway: PaymentGatewayAdapter,
    private readonly notifier: CustomerNotificationAdapter,
    private readonly fulfil: FulfilmentService,
    private readonly audit: AuditService,
  ) {}

  private async tenant(slug: string) {
    const t = await this.prisma.raw.tenant.findUnique({ where: { slug } });
    if (!t || !t.active) throw new NotFoundException('Store not found');
    return t;
  }

  // ---------------------------------------------------------------- staff configuration

  async getConfig(branchId: string, user: RequestUser) {
    assertBranchAccess(user, branchId, ['OWNER', 'BRANCH_MANAGER']);
    return (await this.prisma.db.onlineStoreConfig.findFirst({ where: { branchId } })) ?? { branchId, enabled: false, acceptingOrders: true, pickupEnabled: true, deliveryEnabled: false, deliveryFee: '0', minOrder: '0', serviceAreas: [], prepMinutes: 20, autoAccept: false, scheduledOrdering: false };
  }

  async putConfig(branchId: string, input: Record<string, unknown>, user: RequestUser) {
    assertBranchAccess(user, branchId, ['OWNER', 'BRANCH_MANAGER']);
    if (!(await this.prisma.db.branch.findFirst({ where: { id: branchId } }))) throw new NotFoundException('Branch not found');
    const row = await this.prisma.db.onlineStoreConfig.findFirst({ where: { branchId } });
    if (row) await this.prisma.db.onlineStoreConfig.updateMany({ where: { id: row.id }, data: input as any });
    else await this.prisma.db.onlineStoreConfig.create({ data: { tenantId: '', branchId, ...(input as any) } });
    await this.audit.record({ action: 'online_store.configured', entityType: 'OnlineStoreConfig', entityId: branchId, after: input });
    return this.getConfig(branchId, user);
  }

  // ---------------------------------------------------------------- public storefront

  async branches(slug: string) {
    const t = await this.tenant(slug);
    return runWithTenant(t.id, async () => {
      const cfgs = await this.prisma.db.onlineStoreConfig.findMany({ where: { enabled: true } });
      const branches = await this.prisma.db.branch.findMany({ where: { id: { in: cfgs.map((c) => c.branchId) }, active: true } });
      return cfgs
        .filter((c) => branches.some((b) => b.id === c.branchId))
        .map((c) => ({ branchId: c.branchId, name: branches.find((b) => b.id === c.branchId)!.name, acceptingOrders: c.acceptingOrders, pickup: c.pickupEnabled, delivery: c.deliveryEnabled, deliveryFee: money(c.deliveryFee).toString(), minOrder: money(c.minOrder).toString(), serviceAreas: c.serviceAreas, prepMinutes: c.prepMinutes, scheduledOrdering: c.scheduledOrdering }));
    });
  }

  async publicMenu(slug: string, branchId: string) {
    const t = await this.tenant(slug);
    return runWithTenant(t.id, async () => {
      if (!(await this.prisma.db.onlineStoreConfig.findFirst({ where: { branchId, enabled: true } }))) throw new NotFoundException('This branch does not take online orders');
      const bundle = (await this.menu.offlineBundle(branchId)) as any;
      // Only what a customer needs: no internal tax ids, stations or costing.
      return {
        currency: 'JOD',
        taxInclusive: true,
        categories: bundle.categories,
        items: bundle.items.filter((i: any) => i.available && !i.sku.startsWith('SVC-')).map((i: any) => ({ id: i.id, name: i.name, nameAr: i.nameAr, categoryId: i.categoryId, price: i.price, taxRate: i.taxRate, variants: i.variants, modifierGroups: i.modifierGroups, isCombo: i.isCombo })),
      };
    });
  }

  private async serviceItem(sku: string, name: string) {
    const existing = await this.prisma.db.menuItem.findFirst({ where: { sku } });
    if (existing) return existing;
    const tax = await this.prisma.db.taxCode.findFirst({ where: { code: 'S16' } });
    return this.prisma.db.menuItem.create({ data: { tenantId: '', sku, name, price: 0, taxCodeId: tax?.id ?? null } });
  }

  async placeOrder(slug: string, input: PlaceOrderInput) {
    const t = await this.tenant(slug);
    return runWithTenant(t.id, async () => {
      const cfg = await this.prisma.db.onlineStoreConfig.findFirst({ where: { branchId: input.branchId, enabled: true } });
      if (!cfg) throw new NotFoundException('This branch does not take online orders');
      if (!cfg.acceptingOrders) throw new ConflictException('The branch is not accepting online orders right now');
      if (input.fulfilment === 'PICKUP' && !cfg.pickupEnabled) throw new BadRequestException('Pickup is not available at this branch');
      if (input.fulfilment === 'DELIVERY') {
        if (!cfg.deliveryEnabled) throw new BadRequestException('Delivery is not available at this branch');
        const areas = (cfg.serviceAreas as string[]).map((a) => a.toLowerCase());
        if (!input.address?.area || !input.address.text) throw new BadRequestException('A delivery address is required');
        if (!areas.includes(input.address.area.toLowerCase())) throw new BadRequestException(`We do not deliver to ${input.address.area}`);
      }
      const now = Date.now();
      let promisedAt = new Date(now + cfg.prepMinutes * 60_000);
      if (input.scheduledFor) {
        if (!cfg.scheduledOrdering) throw new BadRequestException('Scheduled orders are not available at this branch');
        const when = new Date(input.scheduledFor);
        if (Number.isNaN(when.getTime()) || when.getTime() < now + cfg.prepMinutes * 60_000 || when.getTime() > now + 7 * 86_400_000) throw new BadRequestException('Choose a time at least the preparation time from now and within 7 days');
        promisedAt = when;
      }
      if (input.payment.method === 'CARD_ONLINE' && !input.payment.token) throw new BadRequestException('A payment token from the payment page is required for card payments');

      // Price the basket first so the minimum applies to the food, not the delivery fee.
      let itemsTotal = d(0);
      for (const l of input.lines) {
        const r = await this.menu.resolveLine({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: l.modifierIds, branchId: input.branchId });
        itemsTotal = itemsTotal.plus(r.unitPrice.times(l.qty));
      }
      if (itemsTotal.lt(cfg.minOrder)) throw new BadRequestException(`The minimum order is ${money(cfg.minOrder)} JOD`);

      const lines: any[] = input.lines.map((l) => ({ ...l }));
      const fee = input.fulfilment === 'DELIVERY' ? d(cfg.deliveryFee) : d(0);
      if (fee.gt(0)) lines.push({ menuItemId: (await this.serviceItem('SVC-DELIVERY', 'Delivery fee')).id, qty: 1, unitPriceOverride: Number(fee), service: true });

      let customerId: string | undefined;
      if (input.customer.consent) {
        const existing = await this.prisma.db.customer.findFirst({ where: { phone: input.customer.phone } });
        customerId = existing?.id ?? (await this.prisma.db.customer.create({ data: { tenantId: '', name: input.customer.name, phone: input.customer.phone, email: input.customer.email ?? null, marketingConsent: false, consentAt: new Date() } })).id;
      }
      const trackingCode = randomBytes(6).toString('hex');
      const order = await this.orders.create(
        { idempotencyKey: `online:${input.idempotencyKey}`, branchId: input.branchId, channel: input.fulfilment, customerId, notes: input.notes, lines },
        SYSTEM_USER,
        { system: true, source: 'ONLINE', channel: input.fulfilment, fulfilmentStatus: 'PLACED', trackingCode, promisedAt, contact: { name: input.customer.name, phone: input.customer.phone, email: input.customer.email ?? null, address: input.address ?? null } },
      );
      // A retry with the same key returns what was already created, never a second order or a second charge.
      if (order.tenders.length || order.status !== 'OPEN' || order.fulfilmentStatus !== 'PLACED') return this.summary(order);

      if (input.payment.method === 'CARD_ONLINE') {
        const pay = await this.gateway.authorizeAndCapture({ amount: order.total.toString(), currency: 'JOD', orderRef: order.number, token: input.payment.token! });
        if (pay.status === 'DECLINED') {
          await this.prisma.db.order.updateMany({ where: { id: order.id }, data: { status: 'VOIDED', fulfilmentStatus: 'CANCELLED', notes: 'Payment declined' } });
          await this.audit.record({ action: 'online_order.payment_declined', entityType: 'Order', entityId: order.id, outcome: 'FAILURE', externalResponse: pay });
          throw new HttpException({ error: 'PAYMENT_DECLINED', message: pay.reason ?? 'The payment was declined' }, HttpStatus.PAYMENT_REQUIRED);
        }
        await this.prisma.db.tender.create({ data: { tenantId: '', orderId: order.id, method: 'CARD', amount: order.total, tendered: order.total, status: 'CAPTURED', capturedAt: new Date(), reference: pay.reference, idempotencyKey: `online:${input.idempotencyKey}:pay`, correlationId: order.correlationId, createdBy: 'system' } });
      }
      await this.notifier.send({ phone: input.customer.phone, email: input.customer.email, template: 'order_received', text: `We received your order ${order.number}. Track it with code ${trackingCode}.`, textAr: `استلمنا طلبك ${order.number}.` });
      await this.fulfil.staffAlert(input.branchId, `New online order ${order.number}`, `${input.fulfilment} • ${order.total} JOD • promised ${promisedAt.toISOString()}`);
      if (cfg.autoAccept) await this.fulfil.accept(order.id);
      return this.summary(await this.orders.detail(order.id));
    });
  }

  private summary(o: { number: string; trackingCode: string | null; total: any; fulfilmentStatus: string | null; promisedAt: Date | null; tenders: { status: string; method: string }[] }) {
    return { orderNumber: o.number, trackingCode: o.trackingCode, total: o.total.toString(), status: o.fulfilmentStatus, promisedAt: o.promisedAt, paid: o.tenders.some((t) => t.status === 'CAPTURED') };
  }

  async track(slug: string, code: string) {
    const t = await this.tenant(slug);
    return runWithTenant(t.id, async () => {
      const o = await this.prisma.db.order.findFirst({ where: { trackingCode: code }, include: { lines: true } });
      if (!o) throw new NotFoundException('Order not found');
      return { orderNumber: o.number, status: o.fulfilmentStatus, channel: o.channel, promisedAt: o.promisedAt, total: o.total.toString(), items: o.lines.filter((l) => !l.voided).map((l) => ({ name: l.name, nameAr: l.nameAr, qty: l.qty })) };
    });
  }
}
