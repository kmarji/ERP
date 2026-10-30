import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { IntegrationHandlers, IntegrationsService } from '../integrations/integrations.service';
import { OrdersService } from '../pos/orders.service';
import { RefundsService } from '../pos/refunds.service';
import { SettlementsService } from '../pos/settlements.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { AggregatorAdapter, ExternalOrder, MarketplaceStatus } from './commerce.adapters';
import { FulfilmentService } from './fulfilment.service';
import { SYSTEM_USER } from './store.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface IngestResult {
  status: string;
  orderId?: string;
  duplicate?: boolean;
  error?: string;
}

@Injectable()
export class AggregatorService implements OnModuleInit {
  private readonly log = new Logger(AggregatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: AggregatorAdapter,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly fulfil: FulfilmentService,
    private readonly settlements: SettlementsService,
    private readonly integrations: IntegrationsService,
    private readonly handlers: IntegrationHandlers,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    const store = async (connectionId: string) => {
      const c = await this.prisma.db.aggregatorConnection.findFirstOrThrow({ where: { id: connectionId } });
      return { provider: c.provider as string, storeRef: c.storeRef };
    };
    this.handlers.register('aggregator', 'respond', async (p: { connectionId: string; externalId: string; decision: 'ACCEPT' | 'REJECT'; reason?: string }) => this.adapter.respond(await store(p.connectionId), p.externalId, p.decision, p.reason));
    this.handlers.register('aggregator', 'status', async (p: { connectionId: string; externalId: string; status: MarketplaceStatus }) => this.adapter.updateStatus(await store(p.connectionId), p.externalId, p.status));
    this.handlers.register('aggregator', 'availability', async (p: { connectionId: string; items: { externalItemId: string; available: boolean }[] }) => this.adapter.pushAvailability(await store(p.connectionId), p.items));
  }

  // ---------------------------------------------------------------- connections and mappings

  async createConnection(input: { provider: 'TALABAT' | 'CAREEM'; branchId: string; storeRef: string; autoAccept?: boolean; commissionRate?: number }) {
    if (!(await this.prisma.db.branch.findFirst({ where: { id: input.branchId } }))) throw new BadRequestException('Unknown branch');
    const secret = randomBytes(24).toString('hex');
    try {
      const c = await this.prisma.db.aggregatorConnection.create({ data: { tenantId: '', provider: input.provider, branchId: input.branchId, storeRef: input.storeRef, autoAccept: input.autoAccept ?? true, commissionRate: input.commissionRate ?? 0, webhookSecretHash: sha(secret) } });
      await this.audit.record({ action: 'aggregator.connected', entityType: 'AggregatorConnection', entityId: c.id, after: { provider: input.provider, storeRef: input.storeRef } });
      const { webhookSecretHash: _h, ...safe } = c;
      return { ...safe, webhookSecret: secret }; // shown once
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This marketplace store is already connected');
      throw e;
    }
  }

  async listConnections() {
    const rows = await this.prisma.db.aggregatorConnection.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(({ webhookSecretHash: _h, ...c }) => ({ ...c, health: c.consecutiveFailures >= 3 ? 'DEGRADED' : c.lastError ? 'WARNING' : 'OK' }));
  }

  async patchConnection(id: string, data: { enabled?: boolean; autoAccept?: boolean; commissionRate?: number }) {
    await this.prisma.db.aggregatorConnection.updateMany({ where: { id }, data });
    await this.audit.record({ action: 'aggregator.updated', entityType: 'AggregatorConnection', entityId: id, after: data });
    return (await this.listConnections()).find((c) => c.id === id);
  }

  async putMappings(connectionId: string, mappings: { externalItemId: string; menuItemId: string; variantId?: string; modifierMap?: Record<string, string> }[]) {
    await this.prisma.db.aggregatorConnection.findFirstOrThrow({ where: { id: connectionId } });
    for (const m of mappings) {
      if (!(await this.prisma.db.menuItem.findFirst({ where: { id: m.menuItemId } }))) throw new BadRequestException(`Unknown menu item ${m.menuItemId}`);
      const existing = await this.prisma.db.aggregatorMenuMapping.findFirst({ where: { connectionId, externalItemId: m.externalItemId } });
      const data = { menuItemId: m.menuItemId, variantId: m.variantId ?? null, modifierMap: (m.modifierMap ?? {}) as any };
      if (existing) await this.prisma.db.aggregatorMenuMapping.updateMany({ where: { id: existing.id }, data });
      else await this.prisma.db.aggregatorMenuMapping.create({ data: { tenantId: '', connectionId, externalItemId: m.externalItemId, ...data } });
    }
    await this.audit.record({ action: 'aggregator.mappings_updated', entityType: 'AggregatorConnection', entityId: connectionId, after: { count: mappings.length } });
    return this.prisma.db.aggregatorMenuMapping.findMany({ where: { connectionId } });
  }

  listMappings(connectionId: string) {
    return this.prisma.db.aggregatorMenuMapping.findMany({ where: { connectionId } });
  }

  listInbound(status?: string) {
    return this.prisma.db.aggregatorInbound.findMany({ where: { status: status as any }, orderBy: { receivedAt: 'desc' }, take: 200 });
  }

  // ---------------------------------------------------------------- inbound

  // Webhook entry point: the shared secret proves the call came from the marketplace integration.
  async webhook(connectionId: string, secret: string | undefined, ext: ExternalOrder, tenantId: string) {
    return runWithTenant(tenantId, async () => {
      const c = await this.prisma.db.aggregatorConnection.findFirst({ where: { id: connectionId } });
      const a = Buffer.from(sha(secret ?? ''));
      const b = Buffer.from(c?.webhookSecretHash ?? '0'.repeat(64));
      if (!c || !c.enabled || a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Unknown connection or wrong secret');
      return this.ingest(connectionId, ext);
    });
  }

  async ingest(connectionId: string, ext: ExternalOrder): Promise<IngestResult> {
    const conn = await this.prisma.db.aggregatorConnection.findFirstOrThrow({ where: { id: connectionId }, include: { mappings: true } });
    let inbound = await this.prisma.db.aggregatorInbound.findFirst({ where: { connectionId, externalId: ext.externalId } });
    if (!inbound) {
      try {
        inbound = await this.prisma.db.aggregatorInbound.create({ data: { tenantId: '', connectionId, externalId: ext.externalId, payload: ext as any } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        inbound = await this.prisma.db.aggregatorInbound.findFirstOrThrow({ where: { connectionId, externalId: ext.externalId } });
      }
    }
    const type = ext.type ?? 'ORDER';
    if (type === 'CANCEL') return this.onCancel(conn, inbound);
    if (type === 'REFUND') return this.onRefund(conn, inbound, ext);
    if (inbound.orderId || ['REJECTED', 'CANCELLED'].includes(inbound.status)) return { status: inbound.status, orderId: inbound.orderId ?? undefined, duplicate: true };
    return this.onOrder(conn, inbound, ext);
  }

  private async fail(inboundId: string, status: 'NEEDS_MAPPING' | 'REJECTED' | 'ERROR', error: string, ex: { code: string; reason: string; evidence: object; branchId: string; riskTier?: 'LOW' | 'MEDIUM' }) {
    await this.prisma.db.aggregatorInbound.updateMany({ where: { id: inboundId }, data: { status, error, processedAt: new Date() } });
    const open = await this.prisma.db.exception.findMany({ where: { code: ex.code, status: 'NOTIFIED' } });
    if (!open.some((e) => (e.evidence as any)?.inboundId === inboundId)) {
      await this.exceptions.raise({ code: ex.code, reason: ex.reason, evidence: { inboundId, ...ex.evidence }, branchId: ex.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: ex.riskTier ?? 'MEDIUM', availableActions: ['resolve'] });
    }
    return { status, error };
  }

  private async onOrder(conn: { id: string; provider: string; branchId: string; storeRef: string; autoAccept: boolean; mappings: { externalItemId: string; menuItemId: string; variantId: string | null; modifierMap: unknown }[] }, inbound: { id: string; externalId: string }, ext: ExternalOrder): Promise<IngestResult> {
    const base = { branchId: conn.branchId };
    if ((ext.paymentMethod ?? 'ONLINE_PREPAID') !== 'ONLINE_PREPAID') {
      return this.fail(inbound.id, 'ERROR', 'Orders paid in cash to the merchant are not supported yet', { code: 'AGG_UNSUPPORTED_PAYMENT', reason: `${conn.provider} order ${ext.externalId} is cash-collected, which is not supported; handle it manually`, evidence: { externalId: ext.externalId }, ...base });
    }
    if (!ext.lines?.length) return this.fail(inbound.id, 'ERROR', 'The order has no lines', { code: 'AGG_INVALID_ORDER', reason: `${conn.provider} order ${ext.externalId} has no lines`, evidence: { externalId: ext.externalId }, ...base });

    const missing = ext.lines.filter((l) => !conn.mappings.some((m) => m.externalItemId === l.externalItemId)).map((l) => l.externalItemId);
    if (missing.length) {
      return this.fail(inbound.id, 'NEEDS_MAPPING', `Unmapped items: ${missing.join(', ')}`, { code: 'AGG_UNMAPPED_ITEM', reason: `${conn.provider} order ${ext.externalId} contains ${missing.length} item(s) not mapped to the menu (${missing.join(', ')}); map them and reprocess`, evidence: { externalId: ext.externalId, missing }, ...base });
    }
    const notes: string[] = [];
    const lines = ext.lines.map((l) => {
      const m = conn.mappings.find((x) => x.externalItemId === l.externalItemId)!;
      const modMap = (m.modifierMap as Record<string, string>) ?? {};
      const modifierIds: string[] = [];
      for (const em of l.modifiers ?? []) {
        if (modMap[em.externalId]) modifierIds.push(modMap[em.externalId]);
        else notes.push(`Unmapped modifier ${em.name ?? em.externalId} on ${l.name ?? l.externalItemId}`);
      }
      return { menuItemId: m.menuItemId, variantId: m.variantId ?? undefined, modifierIds, qty: l.qty, notes: l.notes, unitPriceOverride: l.unitPrice } as any;
    });
    if (ext.deliveryFeeMerchant && ext.deliveryFeeMerchant > 0) {
      const svc = (await this.prisma.db.menuItem.findFirst({ where: { sku: 'SVC-DELIVERY' } })) ?? (await this.prisma.db.menuItem.create({ data: { tenantId: '', sku: 'SVC-DELIVERY', name: 'Delivery fee', price: 0 } }));
      lines.push({ menuItemId: svc.id, qty: 1, unitPriceOverride: ext.deliveryFeeMerchant, service: true });
    }
    const discounts = ext.merchantFundedDiscount && ext.merchantFundedDiscount > 0 ? [{ kind: 'AMOUNT' as const, value: ext.merchantFundedDiscount, reason: 'Merchant-funded marketplace promotion', approvedBy: 'system:marketplace' }] : [];

    let order;
    try {
      order = await this.orders.create({ idempotencyKey: `agg:${conn.provider}:${conn.storeRef}:${ext.externalId}`, branchId: conn.branchId, channel: 'DELIVERY', notes: notes.join('; ') || undefined, lines }, SYSTEM_USER, {
        system: true,
        source: 'AGGREGATOR',
        channel: 'AGGREGATOR',
        externalRef: ext.externalId,
        fulfilmentStatus: 'PLACED',
        contact: { name: ext.customer?.name, phone: ext.customer?.phone, address: ext.address ?? null },
        discounts,
        createdAt: ext.placedAt ? new Date(ext.placedAt) : undefined,
      });
    } catch (e: any) {
      // The item cannot be made right now (inactive, 86'd or outside its hours): decline it to the marketplace, visibly.
      await this.integrations.enqueue({ adapter: 'aggregator', operation: 'respond', payload: { connectionId: conn.id, externalId: ext.externalId, decision: 'REJECT', reason: e.message }, idempotencyKey: `agg:respond:${ext.externalId}:reject` });
      return this.fail(inbound.id, 'REJECTED', e.message, { code: 'AGG_ORDER_REJECTED', reason: `${conn.provider} order ${ext.externalId} was declined: ${e.message}`, evidence: { externalId: ext.externalId }, riskTier: 'LOW', ...base });
    }

    await this.prisma.db.tender.create({ data: { tenantId: '', orderId: order.id, method: 'MARKETPLACE', amount: order.total, tendered: order.total, status: 'CAPTURED', capturedAt: new Date(), reference: ext.externalId, idempotencyKey: `agg:${conn.provider}:${conn.storeRef}:${ext.externalId}:tender`, correlationId: order.correlationId, createdBy: 'system' } }).catch((e) => {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    });
    await this.prisma.db.aggregatorInbound.updateMany({ where: { id: inbound.id }, data: { status: 'ACCEPTED', orderId: order.id, error: null, processedAt: new Date() } });
    if (ext.total !== undefined && Math.abs(Number(order.total) - ext.total) > 0.01) {
      await this.exceptions.raise({ code: 'AGG_TOTAL_MISMATCH', reason: `${conn.provider} order ${ext.externalId}: the marketplace says ${ext.total} JOD, our menu prices give ${order.total} JOD. The settlement will show which is right.`, evidence: { orderId: order.id, marketplaceTotal: ext.total, ourTotal: order.total.toString() }, amount: Math.abs(Number(order.total) - ext.total), branchId: conn.branchId, ownerRole: 'FINANCE', riskTier: 'LOW', availableActions: ['resolve'] });
    }
    await this.fulfil.staffAlert(conn.branchId, `New ${conn.provider} order ${order.number}`, `${order.total} JOD`);
    if (conn.autoAccept) await this.fulfil.accept(order.id);
    return { status: 'ACCEPTED', orderId: order.id };
  }

  private async onCancel(conn: { id: string; branchId: string }, inbound: { id: string; orderId: string | null }): Promise<IngestResult> {
    if (!inbound.orderId) {
      await this.prisma.db.aggregatorInbound.updateMany({ where: { id: inbound.id }, data: { status: 'CANCELLED', processedAt: new Date() } });
      return { status: 'CANCELLED' };
    }
    const order = await this.prisma.db.order.findFirstOrThrow({ where: { id: inbound.orderId } });
    if (order.fulfilmentStatus === 'CANCELLED') return { status: 'CANCELLED', orderId: order.id, duplicate: true };
    if (order.status === 'COMPLETED') {
      // Already delivered and booked: a cancellation after the fact is a credit note.
      await this.refunds.refund(order.id, { idempotencyKey: `agg:cancel:${inbound.id}`, full: true, reason: 'Cancelled by the marketplace after completion', method: 'MARKETPLACE' }, SYSTEM_USER, { system: true });
    } else {
      await this.fulfil.cancelPaid(order.id, 'Cancelled by the marketplace', 'CANCELLED');
      await this.prisma.db.order.updateMany({ where: { id: order.id }, data: { fulfilmentStatus: 'CANCELLED' } });
    }
    await this.prisma.db.aggregatorInbound.updateMany({ where: { id: inbound.id }, data: { status: 'CANCELLED', processedAt: new Date() } });
    await this.audit.record({ action: 'aggregator.order_cancelled', entityType: 'Order', entityId: order.id });
    return { status: 'CANCELLED', orderId: order.id };
  }

  private async onRefund(conn: { id: string; branchId: string; mappings: { externalItemId: string; menuItemId: string }[] }, inbound: { id: string; orderId: string | null }, ext: ExternalOrder): Promise<IngestResult> {
    if (!inbound.orderId) return { status: 'ERROR', error: 'No such order' };
    const order = await this.prisma.db.order.findFirstOrThrow({ where: { id: inbound.orderId }, include: { lines: true } });
    if (order.status !== 'COMPLETED') return this.fail(inbound.id, 'ERROR', 'Refund received for an order that is not completed yet', { code: 'AGG_REFUND_BEFORE_COMPLETION', reason: `Refund for ${order.number} arrived before the order was completed`, evidence: { orderId: order.id }, branchId: conn.branchId });
    const key = `agg:refund:${inbound.id}:${sha(JSON.stringify(ext.refund ?? {})).slice(0, 12)}`;
    let lines: { orderLineId: string; qty: number }[] | undefined;
    if (!ext.refund?.full) {
      lines = [];
      for (const r of ext.refund?.lines ?? []) {
        const mapped = conn.mappings.find((m) => m.externalItemId === r.externalItemId);
        const line = order.lines.find((l) => !l.voided && l.menuItemId === mapped?.menuItemId && l.qty - l.refundedQty >= r.qty);
        if (!line) return this.fail(inbound.id, 'ERROR', `Cannot match refund line ${r.externalItemId}`, { code: 'AGG_REFUND_UNMATCHED', reason: `Refund line ${r.externalItemId} on ${order.number} matches no refundable order line`, evidence: { orderId: order.id }, branchId: conn.branchId });
        lines.push({ orderLineId: line.id, qty: r.qty });
      }
      if (!lines.length) return { status: 'ERROR', error: 'The refund names no lines' };
    }
    const refund = await this.refunds.refund(order.id, { idempotencyKey: key, full: !!ext.refund?.full, lines, reason: ext.refund?.reason ?? 'Marketplace refund', method: 'MARKETPLACE' }, SYSTEM_USER, { system: true });
    return { status: 'ACCEPTED', orderId: order.id, error: refund.number };
  }

  // Finance fixed the mapping (or the menu): run the stored payload again.
  async reprocess(inboundId: string) {
    const inbound = await this.prisma.db.aggregatorInbound.findFirst({ where: { id: inboundId } });
    if (!inbound) throw new NotFoundException('Inbound order not found');
    if (inbound.orderId) throw new ConflictException('An order was already created from this payload');
    await this.prisma.db.aggregatorInbound.updateMany({ where: { id: inboundId }, data: { status: 'RECEIVED', error: null } });
    return this.ingest(inbound.connectionId, inbound.payload as unknown as ExternalOrder);
  }

  // ---------------------------------------------------------------- polling with graceful degradation

  async poll(connectionId: string) {
    const conn = await this.prisma.db.aggregatorConnection.findFirstOrThrow({ where: { id: connectionId } });
    if (!conn.enabled) return { polled: 0, skipped: true };
    try {
      const incoming = await this.adapter.fetchOrders({ provider: conn.provider, storeRef: conn.storeRef }, conn.lastPollAt);
      let n = 0;
      for (const o of incoming) {
        await this.ingest(conn.id, o);
        n++;
      }
      await this.prisma.db.aggregatorConnection.updateMany({ where: { id: conn.id }, data: { lastPollAt: new Date(), lastError: null, consecutiveFailures: 0 } });
      return { polled: n, skipped: false };
    } catch (e: any) {
      const failures = conn.consecutiveFailures + 1;
      await this.prisma.db.aggregatorConnection.updateMany({ where: { id: conn.id }, data: { lastError: String(e.message).slice(0, 500), consecutiveFailures: failures } });
      if (failures === 3) {
        await this.exceptions.raise({ code: 'AGG_API_UNAVAILABLE', reason: `${conn.provider} has been unreachable for ${failures} attempts (${e.message}). In-store and direct orders are unaffected; marketplace orders will be picked up when it returns.`, evidence: { connectionId: conn.id }, branchId: conn.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'MEDIUM', availableActions: ['resolve'] });
      }
      return { polled: 0, skipped: false, error: e.message, consecutiveFailures: failures };
    }
  }

  @Cron('*/1 * * * *')
  async pollAll() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) {
      await runWithTenant(t.id, async () => {
        const conns = await this.prisma.db.aggregatorConnection.findMany({ where: { enabled: true } });
        for (const c of conns) await this.poll(c.id);
      }).catch((e) => this.log.error(`marketplace poll failed for ${t.id}: ${e.message}`));
    }
  }

  // ---------------------------------------------------------------- availability and settlements

  @OnEvent('menu.availability_changed')
  async onAvailability(e: { tenantId: string; branchId: string; menuItemId: string; available: boolean }) {
    await runWithTenant(e.tenantId, async () => {
      const conns = await this.prisma.db.aggregatorConnection.findMany({ where: { branchId: e.branchId, enabled: true }, include: { mappings: { where: { menuItemId: e.menuItemId } } } });
      for (const c of conns.filter((x) => x.mappings.length)) {
        await this.integrations.enqueue({ adapter: 'aggregator', operation: 'availability', payload: { connectionId: c.id, items: c.mappings.map((m) => ({ externalItemId: m.externalItemId, available: e.available })) }, idempotencyKey: `agg:availability:${c.id}:${e.menuItemId}:${e.available}:${Date.now()}` });
      }
    });
  }

  async syncSettlements(connectionId: string) {
    const conn = await this.prisma.db.aggregatorConnection.findFirstOrThrow({ where: { id: connectionId } });
    const statements = await this.adapter.fetchSettlements({ provider: conn.provider, storeRef: conn.storeRef }, null);
    const results = [];
    for (const s of statements) {
      const expected = d(s.gross).times(conn.commissionRate);
      if (d(conn.commissionRate).gt(0) && d(s.fees).minus(expected).abs().gt(Math.max(0.01, Number(s.gross) * 0.005))) {
        await this.exceptions.raise({ code: 'AGG_COMMISSION_VARIANCE', reason: `${conn.provider} statement ${s.reference}: fees ${money(s.fees)} JOD differ from the expected ${money(expected)} JOD (${d(conn.commissionRate).times(100)}% of ${money(s.gross)})`, evidence: { connectionId, statement: s.reference, fees: s.fees, expected: money(expected).toString() }, amount: Math.abs(Number(s.fees) - Number(expected)), ownerRole: 'FINANCE', riskTier: 'MEDIUM', availableActions: ['resolve'] });
      }
      try {
        results.push(await this.settlements.import({ provider: conn.provider, settlementDate: s.settlementDate, reference: `${conn.storeRef}:${s.reference}`, gross: s.gross, fees: s.fees, net: s.net, lines: s.lines }, SYSTEM_USER));
      } catch (e) {
        if (e instanceof ConflictException) continue; // statement already imported
        throw e;
      }
    }
    return { imported: results.length, statements: results.map((r) => ({ id: r.id, reference: r.reference, status: r.status })) };
  }

  async report(from?: Date, to?: Date) {
    const inbound = await this.prisma.db.aggregatorInbound.findMany({ where: { orderId: { not: null }, ...(from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) }, include: { connection: true } });
    const orders = await this.prisma.db.order.findMany({ where: { id: { in: inbound.map((i) => i.orderId!) } } });
    const byProvider = new Map<string, { provider: string; orders: number; gross: ReturnType<typeof d>; delivered: number; cancelled: number }>();
    for (const i of inbound) {
      const o = orders.find((x) => x.id === i.orderId);
      if (!o) continue;
      const row = byProvider.get(i.connection.provider) ?? { provider: i.connection.provider, orders: 0, gross: d(0), delivered: 0, cancelled: 0 };
      row.orders++;
      if (o.fulfilmentStatus === 'DELIVERED') {
        row.gross = row.gross.plus(o.total);
        row.delivered++;
      }
      if (o.fulfilmentStatus === 'CANCELLED') row.cancelled++;
      byProvider.set(i.connection.provider, row);
    }
    const settlements = await this.prisma.db.settlement.groupBy({ by: ['provider'], where: { provider: { in: ['TALABAT', 'CAREEM'] }, status: 'MATCHED' }, _sum: { gross: true, fees: true, net: true } });
    const unsettled = await this.prisma.db.tender.aggregate({ where: { method: 'MARKETPLACE', status: 'CAPTURED', settlementId: null, order: { status: 'COMPLETED' } }, _sum: { amount: true } });
    return {
      providers: [...byProvider.values()].map((r) => {
        const s = settlements.find((x) => x.provider === r.provider);
        return { provider: r.provider, orders: r.orders, delivered: r.delivered, cancelled: r.cancelled, grossDelivered: money(r.gross).toString(), settledGross: money(s?._sum.gross ?? 0).toString(), commissionAndFees: money(s?._sum.fees ?? 0).toString(), netPayouts: money(s?._sum.net ?? 0).toString(), effectiveCommissionPct: s && d(s._sum.gross ?? 0).gt(0) ? d(s._sum.fees ?? 0).div(s._sum.gross ?? 1).times(100).toDecimalPlaces(2).toString() : '0' };
      }),
      receivableFromMarketplaces: money(unsettled._sum.amount ?? 0).toString(),
      tenantId: currentTenantId(),
    };
  }
}
