import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ExternalOrder, StubAggregatorAdapter, StubCustomerNotifier } from '../src/modules/commerce/commerce.adapters';
import { Http, auth, createApp } from './helpers';
import { PosWorld, posHelpers, setupPos } from './pos-fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(250);
  }
}

describe('M5 Order-to-Fulfillment: direct ordering and marketplaces (WF-05, AT-05)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let w: PosWorld;
  let h: ReturnType<typeof posHelpers>;
  let stub: StubAggregatorAdapter;
  let notifier: StubCustomerNotifier;
  let slug: string;
  let branchId: string;

  const pub = (path: string) => http.get(path);
  const store = (body: object) => http.post(`/store/${slug}/orders`).send(body);
  const customer = { name: 'Lina', phone: '0791234567', consent: true };
  const order = (extra: object = {}) => ({
    idempotencyKey: randomUUID(),
    branchId,
    fulfilment: 'PICKUP',
    customer,
    lines: [{ menuItemId: w.cake.id, qty: 2 }], // 6.96
    payment: { method: 'CARD_ONLINE', token: 'tok_ok' },
    ...extra,
  });
  const staff = (path: string, body: object = {}, token = () => w.manager.token) => http.post(path).set(auth(token())).send(body);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    stub = app.get(StubAggregatorAdapter, { strict: false });
    notifier = app.get(StubCustomerNotifier, { strict: false });
    w = await setupPos(http, 'm5');
    h = posHelpers(http, w);
    slug = w.T.slug;
    branchId = w.fx.b1.branchId;
  });
  afterAll(() => app.close());

  describe('direct online ordering', () => {
    it('is configured by the branch manager only and invisible until enabled', async () => {
      expect(await pub(`/store/${slug}/branches`).expect(200).then((r) => r.body)).toEqual([]);
      await http.put(`/online-store/${branchId}`).set(auth(w.cashier.token)).send({ enabled: true }).expect(403);
      await http.put(`/online-store/${branchId}`).set(auth(w.cashierB2.token)).send({ enabled: true }).expect(403);
      await http.put(`/online-store/${branchId}`).set(auth(w.manager.token)).send({ enabled: true, deliveryEnabled: true, deliveryFee: 1, minOrder: 5, serviceAreas: ['Abdoun'], prepMinutes: 20, scheduledOrdering: true }).expect(200);
      await pub('/store/no-such-business/branches').expect(404);
      const branches = (await pub(`/store/${slug}/branches`).expect(200)).body;
      expect(branches).toEqual([expect.objectContaining({ branchId, delivery: true, deliveryFee: '1', minOrder: '5', serviceAreas: ['Abdoun'] })]);
      const menu = (await pub(`/store/${slug}/branches/${branchId}/menu`).expect(200)).body;
      expect(menu.items.map((i: any) => i.name)).toEqual(expect.arrayContaining(['Latte', 'Cake']));
      expect(JSON.stringify(menu)).not.toContain('stationKey');
      await pub(`/store/${slug}/branches/${w.fx.b2.branchId}/menu`).expect(404); // not an online branch
    });

    it('validates the basket, the service area, the schedule and never accepts card numbers', async () => {
      await store(order({ lines: [{ menuItemId: w.cake.id, qty: 1 }] })).expect(400); // below the 5 JOD minimum
      await store(order({ fulfilment: 'DELIVERY' })).expect(400); // no address
      await store(order({ fulfilment: 'DELIVERY', address: { area: 'Sweileh', text: 'x' } })).expect(400); // outside the service area
      await store(order({ scheduledFor: new Date(Date.now() + 5 * 60_000).toISOString() })).expect(400); // sooner than the prep time
      await store(order({ payment: { method: 'CARD_ONLINE' } })).expect(400); // token required
      await store(order({ payment: { method: 'CARD_ONLINE', token: 'tok', cardNumber: '4111111111111111' } })).expect(400); // raw card data is refused
      await store(order({ lines: [{ menuItemId: w.cake.id, qty: 500 }] })).expect(400);
      await store(order({ customer: { name: 'x', phone: '1' } })).expect(400);
      expect(await prisma.raw.order.count({ where: { tenantId: w.T.tenantId, source: 'ONLINE' } })).toBe(0); // nothing was created
    });

    it('takes a prepaid pickup order once, even if the customer retries', async () => {
      const body = order();
      const r1 = (await store(body).expect(201)).body;
      expect(r1).toMatchObject({ status: 'PLACED', total: '6.96', paid: true, trackingCode: expect.stringMatching(/^[0-9a-f]{12}$/) });
      const r2 = (await store(body).expect(201)).body;
      expect(r2.orderNumber).toBe(r1.orderNumber);
      expect(await prisma.raw.order.count({ where: { tenantId: w.T.tenantId, source: 'ONLINE' } })).toBe(1);
      const o = await prisma.raw.order.findFirstOrThrow({ where: { tenantId: w.T.tenantId, trackingCode: r1.trackingCode } });
      expect(await prisma.raw.tender.count({ where: { orderId: o.id } })).toBe(1); // charged once
      expect((await prisma.raw.tender.findFirstOrThrow({ where: { orderId: o.id } })).reference).toMatch(/^STUBPAY-/);

      const track = (await pub(`/store/${slug}/track/${r1.trackingCode}`).expect(200)).body;
      expect(track).toMatchObject({ orderNumber: r1.orderNumber, status: 'PLACED', items: [{ name: 'Cake', qty: 2 }] });
      await pub(`/store/${slug}/track/doesnotexist`).expect(404);
      expect((await h.get('/notifications', w.manager.token)).some((n: any) => n.title.includes('New online order'))).toBe(true);
      expect(notifier.sent.some((m) => m.template === 'order_received' && m.phone === customer.phone)).toBe(true);
      expect(await prisma.raw.customer.count({ where: { tenantId: w.T.tenantId, phone: customer.phone } })).toBe(1); // profile only with consent
    });

    it('a declined payment creates no live order', async () => {
      const res = await store(order({ payment: { method: 'CARD_ONLINE', token: 'DECLINE-1' } })).expect(402);
      expect(res.body.error).toBe('PAYMENT_DECLINED');
      const o = await prisma.raw.order.findFirst({ where: { tenantId: w.T.tenantId, source: 'ONLINE', status: 'VOIDED' } });
      expect(o).toMatchObject({ fulfilmentStatus: 'CANCELLED' });
    });

    it('moves through the branch: accept, kitchen, ready, handover; the sale posts at handover', async () => {
      const placed = (await store(order()).expect(201)).body;
      const row = async () => (await h.get('/online-orders', w.manager.token)).find((o: any) => o.number === placed.orderNumber);
      const id = (await row()).id;
      await staff(`/online-orders/${id}/ready`).expect(409); // must be accepted first
      await staff(`/online-orders/${id}/deliver`).expect(409);
      const accepted = (await staff(`/online-orders/${id}/accept`).expect(201)).body;
      expect(accepted).toMatchObject({ fulfilmentStatus: 'ACCEPTED', status: 'SENT' });
      expect((await h.get(`/kds/tickets?branchId=${branchId}`, w.manager.token)).filter((t: any) => t.orderId === id)).toHaveLength(1);
      await staff(`/online-orders/${id}/ready`).expect(201);
      expect(notifier.sent.some((m) => m.template === 'order_ready')).toBe(true);
      await staff(`/online-orders/${id}/deliver`, {}, () => w.cashierB2.token).expect(403); // other branch
      const done = (await staff(`/online-orders/${id}/deliver`).expect(201)).body;
      expect(done).toMatchObject({ status: 'COMPLETED', fulfilmentStatus: 'DELIVERED', postingStatus: 'POSTED' });
      expect(h.byAccount((await h.journalsFor('Order', id))[0])).toEqual({ CARD_CLEARING: ['6.96', '0'], SALES: ['0', '6'], OUTPUT_TAX: ['0', '0.96'] });
      expect((await pub(`/store/${slug}/track/${placed.trackingCode}`)).body.status).toBe('DELIVERED');
      expect(done.invoice.number).toMatch(/^SI-/);
    });

    it('cash-on-delivery with a delivery fee: dispatch is required, cash is collected at the door, the fee is revenue', async () => {
      const placed = (await store(order({ fulfilment: 'DELIVERY', address: { area: 'abdoun', text: 'Street 5, building 3' }, payment: { method: 'CASH_ON_DELIVERY' } })).expect(201)).body;
      expect(placed).toMatchObject({ total: '7.96', paid: false }); // 6.96 + 1.000 fee
      const id = (await h.get('/online-orders', w.manager.token)).find((o: any) => o.number === placed.orderNumber).id;
      await staff(`/online-orders/${id}/accept`).expect(201);
      const tickets = (await h.get(`/kds/tickets?branchId=${branchId}`, w.manager.token)).filter((t: any) => t.orderId === id);
      expect(tickets.flatMap((t: any) => t.items.map((i: any) => i.name))).toEqual(['Cake']); // the fee never reaches the kitchen
      await staff(`/online-orders/${id}/ready`).expect(201);
      await staff(`/online-orders/${id}/deliver`, { cash: { tendered: 10 } }).expect(409); // dispatch first
      await staff(`/online-orders/${id}/dispatch`, { driver: 'Omar' }).expect(201);
      await staff(`/online-orders/${id}/deliver`, {}, () => w.cashier.token).expect(400); // 7.96 still due
      const done = (await staff(`/online-orders/${id}/deliver`, { cash: { tendered: 10 } }, () => w.cashier.token).expect(201)).body;
      expect(done).toMatchObject({ status: 'COMPLETED', total: '7.96', postingStatus: 'POSTED' });
      expect(done.tenders.find((t: any) => t.method === 'CASH')).toMatchObject({ amount: '7.96', change: '2.04' });
      expect(h.byAccount((await h.journalsFor('Order', id))[0])).toEqual({ CASH: ['7.96', '0'], SALES: ['0', '6.862'], OUTPUT_TAX: ['0', '1.098'] });
    });

    it('rejecting or cancelling a prepaid order refunds the payment and leaves no trace in the books', async () => {
      const a = (await store(order()).expect(201)).body;
      const idA = (await h.get('/online-orders', w.manager.token)).find((o: any) => o.number === a.orderNumber).id;
      const rejected = (await staff(`/online-orders/${idA}/reject`, { reason: 'Kitchen is closing' }).expect(201)).body;
      expect(rejected).toMatchObject({ status: 'VOIDED', fulfilmentStatus: 'REJECTED' });
      expect(rejected.tenders[0].status).toBe('VOIDED');
      expect(notifier.sent.some((m) => m.template === 'order_rejected')).toBe(true);
      expect(await h.journalsFor('Order', idA)).toHaveLength(0);

      const b = (await store(order()).expect(201)).body;
      const idB = (await h.get('/online-orders', w.manager.token)).find((o: any) => o.number === b.orderNumber).id;
      await staff(`/online-orders/${idB}/accept`).expect(201);
      await staff(`/online-orders/${idB}/cancel`, { reason: 'customer called' }, () => w.cashier.token).expect(403); // managers only
      await staff(`/online-orders/${idB}/cancel`, { reason: 'customer called' }).expect(201);
      expect((await h.get(`/kds/tickets?branchId=${branchId}&status=CANCELLED`, w.manager.token)).filter((t: any) => t.orderId === idB)).toHaveLength(1);
      await staff(`/online-orders/${idB}/ready`).expect(409); // a cancelled order cannot move on
      expect((await h.get('/finance/trial-balance')).balanced).toBe(true);
    });

    it('can be paused when the kitchen is overwhelmed, and auto-accepts when configured', async () => {
      await http.put(`/online-store/${branchId}`).set(auth(w.manager.token)).send({ acceptingOrders: false }).expect(200);
      await store(order()).expect(409);
      await http.put(`/online-store/${branchId}`).set(auth(w.manager.token)).send({ acceptingOrders: true, autoAccept: true }).expect(200);
      const r = (await store(order()).expect(201)).body;
      expect(r.status).toBe('ACCEPTED');
      await http.put(`/online-store/${branchId}`).set(auth(w.manager.token)).send({ autoAccept: false }).expect(200);
    });
  });

  describe('AT-05: a marketplace order reaches the kitchen and its commission and payout reconcile', () => {
    let conn: any;
    let secret: string;
    const hook = (connId: string, body: object, s: string | undefined = secret) => http.post(`/aggregators/webhook/${slug}/${connId}`).set(s ? { 'x-webhook-secret': s } : {}).send(body);
    const ext = (externalId: string, extra: object = {}) => ({
      externalId,
      placedAt: new Date().toISOString(),
      customer: { name: 'Hana', phone: '0780000001' },
      address: { text: 'Rainbow St 10' },
      lines: [{ externalItemId: 'T-LATTE', name: 'Latte L', qty: 2, unitPrice: 3.3, modifiers: [{ externalId: 'T-EXTRA-MILK' }] }, { externalItemId: 'T-CAKE', qty: 1, unitPrice: 3.48 }],
      merchantFundedDiscount: 1,
      marketplaceFundedDiscount: 2,
      total: 9.08,
      paymentMethod: 'ONLINE_PREPAID',
      ...extra,
    });
    const outbox = (action: string, ref?: string) => stub.outbox.filter((o) => o.action === action && (!ref || JSON.stringify(o.detail).includes(ref)));

    beforeAll(async () => {
      const c = (await http.post('/aggregators/connections').set(auth(w.T.token)).send({ provider: 'TALABAT', branchId, storeRef: 'TAL-1', commissionRate: 0.25 }).expect(201)).body;
      conn = c;
      secret = c.webhookSecret;
      await http.put(`/aggregators/connections/${c.id}/mappings`).set(auth(w.T.token)).send({ mappings: [{ externalItemId: 'T-LATTE', menuItemId: w.latte.id, variantId: w.largeVariant.id, modifierMap: { 'T-EXTRA-MILK': w.extraMilk.id } }, { externalItemId: 'T-CAKE', menuItemId: w.cake.id }] }).expect(200);
    });

    it('connects a store once and protects the webhook with its secret', async () => {
      expect(conn).not.toHaveProperty('webhookSecretHash');
      expect(secret).toHaveLength(48);
      await http.post('/aggregators/connections').set(auth(w.T.token)).send({ provider: 'TALABAT', branchId, storeRef: 'TAL-1' }).expect(409);
      await http.post('/aggregators/connections').set(auth(w.cashier.token)).send({ provider: 'CAREEM', branchId, storeRef: 'X' }).expect(403);
      await hook(conn.id, ext('TAL-ORDER-0'), 'wrong').expect(403);
      await hook(conn.id, ext('TAL-ORDER-0'), '').expect(403);
      await http.post(`/aggregators/webhook/${slug}/${randomUUID()}`).set({ 'x-webhook-secret': secret }).send(ext('TAL-ORDER-0')).expect(403);
      await http.post(`/aggregators/webhook/no-such-tenant/${conn.id}`).set({ 'x-webhook-secret': secret }).send(ext('TAL-ORDER-0')).expect(404);
      expect((await h.get('/aggregators/connections', w.T.token))[0]).toMatchObject({ provider: 'TALABAT', health: 'OK' });
    });

    it('turns a marketplace order into our canonical order, routes it to the right kitchen stations as RUSH, once', async () => {
      const r = (await hook(conn.id, ext('TAL-ORDER-1')).expect(201)).body;
      expect(r.status).toBe('ACCEPTED');
      const dup = (await hook(conn.id, ext('TAL-ORDER-1')).expect(201)).body;
      expect(dup).toMatchObject({ orderId: r.orderId, duplicate: true });
      expect(await prisma.raw.order.count({ where: { tenantId: w.T.tenantId, source: 'AGGREGATOR' } })).toBe(1);

      const o = await h.get(`/pos/orders/${r.orderId}`, w.manager.token);
      expect(o).toMatchObject({ source: 'AGGREGATOR', channel: 'AGGREGATOR', fulfilmentStatus: 'ACCEPTED', externalRef: 'TAL-ORDER-1', subtotal: '10.08', discountTotal: '1', total: '9.08' });
      expect(o.tenders).toEqual([expect.objectContaining({ method: 'MARKETPLACE', status: 'CAPTURED', amount: '9.08', reference: 'TAL-ORDER-1' })]);
      const tickets = (await h.get(`/kds/tickets?branchId=${branchId}`, w.manager.token)).filter((t: any) => t.orderId === r.orderId);
      expect(tickets.map((t: any) => [t.stationKey, t.priority]).sort()).toEqual([['BAR', 'RUSH'], ['KITCHEN', 'RUSH']]);
      expect(tickets.flatMap((t: any) => t.items.flatMap((i: any) => i.modifiers.map((m: any) => m.name)))).toEqual(['Extra milk']); // modifier mapped
      await until(() => outbox('accept', 'TAL-ORDER-1').length === 1); // acknowledged to the marketplace through the job queue
    });

    it('books the sale against the marketplace receivable: merchant-funded promotions reduce revenue, marketplace-funded ones do not', async () => {
      const id = (await h.get('/online-orders?source=AGGREGATOR', w.manager.token))[0].id;
      const before = await h.stock(w.fx.milk.id);
      await staff(`/online-orders/${id}/ready`).expect(201);
      const done = (await staff(`/online-orders/${id}/deliver`).expect(201)).body; // nothing to collect: the marketplace owes us
      expect(done).toMatchObject({ status: 'COMPLETED', fulfilmentStatus: 'DELIVERED', postingStatus: 'POSTED', total: '9.08' });
      const j = h.byAccount((await h.journalsFor('Order', id)).find((x: any) => !x.memo.startsWith('Cost')));
      expect(j.MARKETPLACE_CLEARING).toEqual(['9.08', '0']);
      expect(Number(j.SALES_DISCOUNTS[0])).toBeCloseTo(0.862, 2); // the 1 JOD merchant promotion, ex-tax
      expect(Number(j.SALES[1]) - Number(j.SALES_DISCOUNTS[0]) + Number(j.OUTPUT_TAX[1])).toBeCloseTo(9.08, 3); // net revenue + tax = what we are owed
      expect(Number(before.qtyBase) - Number((await h.stock(w.fx.milk.id)).qtyBase)).toBeCloseTo(0.95); // recipes consumed incl. the extra-milk modifier
      await until(() => outbox('status', 'DELIVERED').length === 1);
      expect(outbox('status', 'READY')).toHaveLength(1);
      expect((await h.tb('1150')).balance).toBe('9.08');
    });

    it('reconciles commission and payout from the statement to the source order, and flags a deviating fee', async () => {
      stub.injectStatement('TALABAT', 'TAL-1', { reference: 'WK-1', settlementDate: new Date().toISOString().slice(0, 10), gross: 9.08, fees: 2.27, net: 6.81, lines: [{ reference: 'TAL-ORDER-1', amount: 9.08 }] });
      const sync = (await http.post(`/aggregators/connections/${conn.id}/settlements/sync`).set(auth(w.fin.token)).expect(201)).body;
      expect(sync).toMatchObject({ imported: 1, statements: [{ status: 'MATCHED' }] });
      const st = (await h.get('/pos/settlements', w.fin.token))[0];
      expect(h.byAccount((await h.journalsFor('Settlement', st.id))[0])).toEqual({ BANK: ['6.81', '0'], COMMISSION_EXPENSE: ['2.27', '0'], MARKETPLACE_CLEARING: ['0', '9.08'] });
      expect((await h.tb('1150')).balance).toBe('0');
      expect((await h.get('/exceptions?open=true', w.fin.token)).some((e: any) => e.code === 'AGG_COMMISSION_VARIANCE')).toBe(false); // exactly 25%
      await http.post(`/aggregators/connections/${conn.id}/settlements/sync`).set(auth(w.fin.token)).expect(201); // nothing new, nothing duplicated

      const r2 = (await hook(conn.id, ext('TAL-ORDER-2', { merchantFundedDiscount: 0, total: 10.08 })).expect(201)).body;
      await staff(`/online-orders/${r2.orderId}/ready`).expect(201);
      await staff(`/online-orders/${r2.orderId}/deliver`).expect(201);
      stub.injectStatement('TALABAT', 'TAL-1', { reference: 'WK-2', settlementDate: new Date().toISOString().slice(0, 10), gross: 10.08, fees: 4.03, net: 6.05, lines: [{ reference: 'TAL-ORDER-2', amount: 10.08 }] }); // 40% instead of 25%
      await http.post(`/aggregators/connections/${conn.id}/settlements/sync`).set(auth(w.fin.token)).expect(201);
      const ex = (await h.get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'AGG_COMMISSION_VARIANCE');
      expect(ex).toMatchObject({ ownerRole: 'FINANCE' });
      expect(ex.evidence).toMatchObject({ statement: 'WK-2', expected: '2.52' });

      const report = await h.get('/aggregators/report', w.fin.token);
      expect(report.providers[0]).toMatchObject({ provider: 'TALABAT', delivered: 2, settledGross: '19.16', commissionAndFees: '6.3', netPayouts: '12.86' });
      expect(report.receivableFromMarketplaces).toBe('0');
      expect((await h.get('/finance/trial-balance')).balanced).toBe(true);
    });

    it('keeps an order it cannot map, raises an exception, and processes it once the mapping is fixed', async () => {
      const bad = ext('TAL-ORDER-3', { lines: [{ externalItemId: 'T-UNKNOWN', name: 'Mystery', qty: 1, unitPrice: 5 }], total: 4.5 });
      const r = (await hook(conn.id, bad).expect(201)).body;
      expect(r).toMatchObject({ status: 'NEEDS_MAPPING' });
      const inbound = (await h.get('/aggregators/inbound?status=NEEDS_MAPPING', w.manager.token))[0];
      expect(inbound.payload.externalId).toBe('TAL-ORDER-3'); // the payload is kept, not lost
      expect((await h.get('/exceptions?open=true', w.manager.token)).find((e: any) => e.code === 'AGG_UNMAPPED_ITEM')).toMatchObject({ ownerRole: 'BRANCH_MANAGER' });
      const again = (await http.post(`/aggregators/inbound/${inbound.id}/reprocess`).set(auth(w.manager.token)).expect(201)).body;
      expect(again.status).toBe('NEEDS_MAPPING'); // still unmapped

      await http.put(`/aggregators/connections/${conn.id}/mappings`).set(auth(w.manager.token)).send({ mappings: [{ externalItemId: 'T-UNKNOWN', menuItemId: w.cake.id }] }).expect(200);
      const ok = (await http.post(`/aggregators/inbound/${inbound.id}/reprocess`).set(auth(w.manager.token)).expect(201)).body;
      expect(ok.status).toBe('ACCEPTED');
      await http.post(`/aggregators/inbound/${inbound.id}/reprocess`).set(auth(w.manager.token)).expect(409);
      await staff(`/online-orders/${ok.orderId}/cancel`, { reason: 'test cleanup' }).expect(201);
    });

    it('stops selling what the kitchen ran out of, and declines marketplace orders for it', async () => {
      await http.put(`/menu/branches/${branchId}/items/${w.cake.id}`).set(auth(w.manager.token)).send({ available: false }).expect(200);
      await until(() => outbox('availability', 'T-CAKE').length >= 1);
      expect(JSON.stringify(outbox('availability', 'T-CAKE')[0].detail)).toContain('"available":false');
      const r = (await hook(conn.id, ext('TAL-ORDER-4')).expect(201)).body;
      expect(r.status).toBe('REJECTED');
      await until(() => outbox('reject', 'TAL-ORDER-4').length === 1);
      expect((await h.get('/exceptions?open=true', w.manager.token)).some((e: any) => e.code === 'AGG_ORDER_REJECTED')).toBe(true);
      await store(order()).expect(400); // the online storefront refuses it too
      await http.put(`/menu/branches/${branchId}/items/${w.cake.id}`).set(auth(w.manager.token)).send({ available: true }).expect(200);
    });

    it('applies marketplace cancellations and refunds: void before completion, credit note after', async () => {
      const a = (await hook(conn.id, ext('TAL-ORDER-5')).expect(201)).body;
      const cancel = (await hook(conn.id, { type: 'CANCEL', externalId: 'TAL-ORDER-5', placedAt: new Date().toISOString() }).expect(201)).body;
      expect(cancel).toMatchObject({ status: 'CANCELLED', orderId: a.orderId });
      expect(await h.get(`/pos/orders/${a.orderId}`, w.manager.token)).toMatchObject({ status: 'VOIDED', fulfilmentStatus: 'CANCELLED' });
      expect((await hook(conn.id, { type: 'CANCEL', externalId: 'TAL-ORDER-5', placedAt: new Date().toISOString() }).expect(201)).body.duplicate).toBe(true);

      const b = (await hook(conn.id, ext('TAL-ORDER-6', { merchantFundedDiscount: 0, total: 10.08 })).expect(201)).body;
      await staff(`/online-orders/${b.orderId}/ready`).expect(201);
      await staff(`/online-orders/${b.orderId}/deliver`).expect(201);
      const clearingBefore = Number((await h.tb('1150')).balance);
      const refundEvent = { type: 'REFUND', externalId: 'TAL-ORDER-6', placedAt: new Date().toISOString(), refund: { lines: [{ externalItemId: 'T-CAKE', qty: 1 }], reason: 'cold food' } };
      const r1 = (await hook(conn.id, refundEvent).expect(201)).body;
      expect(r1.status).toBe('ACCEPTED');
      await hook(conn.id, refundEvent).expect(201); // repeated delivery of the same event
      const refunds = await h.get(`/pos/orders/${b.orderId}/refunds`, w.manager.token);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ total: '3.48', method: 'MARKETPLACE', approvedBy: 'system:marketplace', postingStatus: 'POSTED' });
      expect(h.byAccount((await h.journalsFor('Refund', refunds[0].id))[0])).toEqual({ SALES: ['3', '0'], OUTPUT_TAX: ['0.48', '0'], MARKETPLACE_CLEARING: ['0', '3.48'] });
      expect(Number((await h.tb('1150')).balance)).toBeCloseTo(clearingBefore - 3.48, 3);
    });

    it('refuses cash-collected marketplace orders visibly instead of guessing', async () => {
      const r = (await hook(conn.id, ext('TAL-ORDER-7', { paymentMethod: 'CASH' })).expect(201)).body;
      expect(r.status).toBe('ERROR');
      expect((await h.get('/exceptions?open=true', w.manager.token)).some((e: any) => e.code === 'AGG_UNSUPPORTED_PAYMENT')).toBe(true);
      expect((await h.get('/aggregators/inbound?status=ERROR', w.manager.token)).some((i: any) => i.externalId === 'TAL-ORDER-7')).toBe(true);
    });

    it('degrades gracefully when the marketplace API is down: stores keep trading, updates queue and catch up', async () => {
      const o9 = (await hook(conn.id, ext('TAL-ORDER-9', { merchantFundedDiscount: 0, total: 10.08 })).expect(201)).body;
      stub.setOutage('TALABAT', true);
      stub.inject('TALABAT', 'TAL-1', ext('TAL-ORDER-8', { merchantFundedDiscount: 0, total: 10.08 }) as ExternalOrder);
      for (let i = 0; i < 3; i++) await http.post(`/aggregators/connections/${conn.id}/poll`).set(auth(w.manager.token)).expect(201);
      expect((await h.get('/aggregators/connections', w.manager.token))[0]).toMatchObject({ health: 'DEGRADED', consecutiveFailures: 3 });
      const down = (await h.get('/exceptions?open=true', w.manager.token)).filter((e: any) => e.code === 'AGG_API_UNAVAILABLE');
      expect(down).toHaveLength(1);

      // in-store and direct online orders are unaffected
      expect((await h.sellCash([h.lineCake(1)])).postingStatus).toBe('POSTED');
      const placed = (await store(order()).expect(201)).body;
      expect(placed.status).toBe('PLACED');
      // the kitchen is not blocked by the outage: the order moves on, and the marketplace update is queued, not lost
      expect((await staff(`/online-orders/${o9.orderId}/ready`).expect(201)).body.fulfilmentStatus).toBe('READY');
      expect(outbox('status', 'TAL-ORDER-9')).toHaveLength(0);

      stub.setOutage('TALABAT', false);
      const back = (await http.post(`/aggregators/connections/${conn.id}/poll`).set(auth(w.manager.token)).expect(201)).body;
      expect(back).toMatchObject({ polled: 1 });
      expect((await h.get('/aggregators/connections', w.manager.token))[0]).toMatchObject({ health: 'OK', consecutiveFailures: 0 });
      const o8 = await prisma.raw.order.findFirstOrThrow({ where: { tenantId: w.T.tenantId, externalRef: 'TAL-ORDER-8' } });
      expect(o8.fulfilmentStatus).toBe('ACCEPTED');
      await until(() => outbox('status', 'TAL-ORDER-9').length >= 1); // the queued update was delivered after recovery
      expect(JSON.stringify(outbox('status', 'TAL-ORDER-9')[0].detail)).toContain('READY');
      expect((await h.get('/finance/trial-balance')).balanced).toBe(true);
      expect(await h.get('/inventory/reconcile')).toMatchObject({ consistent: true });
    });
  });
});
