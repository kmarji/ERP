import { INestApplication } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { GiftCardService, LoyaltyService, VoucherService } from '../src/modules/customers/customers.contracts';
import { KdsService } from '../src/modules/kds/kds.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';
import { setupSupplyChain } from './supply-fixtures';

describe('M3-B front of house: KDS, floor, customers, vouchers, gift cards', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let fx: Awaited<ReturnType<typeof setupSupplyChain>>;
  let cashier: { id: string; token: string };
  let kitchen1: { id: string; token: string };
  let kitchen2: { id: string; token: string };
  let mgr1: { id: string; token: string };

  const get = async (path: string, token = T.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const inTenant = <R>(fn: () => Promise<R>) => runWithTenant(T.tenantId, fn);
  const dec = (v: number | string) => new Decimal(v);

  async function makeOrder(branchId: string, channel: 'DINE_IN' | 'DELIVERY' = 'DINE_IN', tableId?: string, status: 'OPEN' | 'SENT' = 'SENT') {
    const key = randomUUID();
    return inTenant(() =>
      prisma.db.order.create({ data: { tenantId: '', number: `T-${key.slice(0, 8)}`, branchId, channel, status, tableId: tableId ?? null, idempotencyKey: key, correlationId: key, createdBy: cashier.id } }),
    );
  }
  const tickets = (token: string, branchId: string, q = '') => get(`/kds/tickets?branchId=${branchId}${q}`, token);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm3b');
    fx = await setupSupplyChain(http, T);
    cashier = await makeUser(http, T, 'cash1', 'CASHIER', fx.b1.branchId);
    kitchen1 = await makeUser(http, T, 'kit1', 'KITCHEN', fx.b1.branchId);
    kitchen2 = await makeUser(http, T, 'kit2', 'KITCHEN', fx.b2.branchId);
    mgr1 = await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', fx.b1.branchId);
  });

  afterAll(() => app.close());

  describe('customers', () => {
    it('requires explicit consent, rejects duplicate phones, and erases by anonymising', async () => {
      await http.post('/customers').set(auth(cashier.token)).send({ name: 'Layla', phone: '0790000001', consent: false }).expect(400);
      await http.post('/customers').set(auth(cashier.token)).send({ name: 'Layla', phone: '0790000001' }).expect(400);
      const c = (await http.post('/customers').set(auth(cashier.token)).send({ name: 'Layla', phone: '0790000001', consent: true, marketingConsent: true }).expect(201)).body;
      expect(c.consentAt).toBeTruthy();
      await http.post('/customers').set(auth(cashier.token)).send({ name: 'Other', phone: '0790000001', consent: true }).expect(409);
      expect((await get('/customers?q=layl', cashier.token)).map((x: any) => x.id)).toContain(c.id);
      expect((await get('/customers?q=0790000001', cashier.token)).map((x: any) => x.id)).toContain(c.id);

      await inTenant(() => prisma.db.$transaction((tx) => app.get(LoyaltyService).earn(tx, c.id, 'ord-erase', 50)));
      await http.delete(`/customers/${c.id}`).set(auth(cashier.token)).expect(403); // erasure is a manager action
      await http.delete(`/customers/${c.id}`).set(auth(mgr1.token)).expect(200);
      const after = await get(`/customers/${c.id}`, mgr1.token);
      expect(after).toMatchObject({ name: 'Erased customer', phone: null, email: null, marketingConsent: false, points: 50 });
      expect(await get(`/customers/${c.id}/loyalty`, mgr1.token)).toHaveLength(1); // history kept
      const audit = await get('/audit?entityType=Customer');
      expect(audit.map((e: any) => e.action)).toContain('customer.erased');
    });
  });

  describe('loyalty', () => {
    it('earn is idempotent, redeem is guarded, clawback never goes below zero', async () => {
      const loyalty = app.get(LoyaltyService);
      const c = (await http.post('/customers').set(auth(cashier.token)).send({ name: 'Omar', phone: '0790000002', consent: true }).expect(201)).body;
      const run = <R>(fn: (tx: any) => Promise<R>) => inTenant(() => prisma.db.$transaction(fn));
      await run((tx) => loyalty.earn(tx, c.id, 'o1', 250));
      await run((tx) => loyalty.earn(tx, c.id, 'o1', 250)); // retry
      expect((await get(`/customers/${c.id}`, cashier.token)).points).toBe(250);

      expect((await run((tx) => loyalty.redeem(tx, c.id, 'o2', 150))).toString()).toBe('1.5');
      await expect(run((tx) => loyalty.redeem(tx, c.id, 'o3', 101))).rejects.toThrow(/enough points/);
      expect((await get(`/customers/${c.id}`, cashier.token)).points).toBe(100);

      await run((tx) => loyalty.clawback(tx, c.id, 'o1', 250)); // only 100 left to take back
      expect((await get(`/customers/${c.id}`, cashier.token)).points).toBe(0);
      const tx = await get(`/customers/${c.id}/loyalty`, cashier.token);
      expect(tx.map((t: any) => [t.reason, t.points]).sort()).toEqual([['CLAWBACK', -100], ['EARN', 250], ['REDEEM', -150]]);
    });
  });

  describe('vouchers', () => {
    it('validates the full matrix and redeems once per order within maxUses', async () => {
      const v = app.get(VoucherService);
      const validate = (code: string, subtotal: number, at?: Date) => inTenant(() => v.validate(code, dec(subtotal), at));
      await http.post('/vouchers').set(auth(cashier.token)).send({ code: 'x', kind: 'PERCENT', value: 10 }).expect(403);
      await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'pct', kind: 'PERCENT', value: 150 }).expect(400);
      const pct = (await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'save10', kind: 'PERCENT', value: 10, minSubtotal: 20 }).expect(201)).body;
      expect(pct.code).toBe('SAVE10');
      await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'SAVE10', kind: 'AMOUNT', value: 1 }).expect(409);
      await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'BIG', kind: 'AMOUNT', value: 50 }).expect(201);
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'FUTURE', kind: 'AMOUNT', value: 1, validFrom: soon }).expect(201);
      await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'PAST', kind: 'AMOUNT', value: 1, validTo: new Date(Date.now() - 1000).toISOString() }).expect(201);
      const once = (await http.post('/vouchers').set(auth(mgr1.token)).send({ code: 'ONCE', kind: 'AMOUNT', value: 2, maxUses: 1 }).expect(201)).body;

      expect(await validate('save10', 40)).toMatchObject({ kind: 'PERCENT' });
      expect((await validate('save10', 40)).discount.toString()).toBe('4');
      expect((await validate('BIG', 30)).discount.toString()).toBe('30'); // capped at the subtotal
      await expect(validate('SAVE10', 19.999)).rejects.toThrow(/minimum/);
      await expect(validate('NOPE', 10)).rejects.toThrow(/Unknown/);
      await expect(validate('FUTURE', 10)).rejects.toThrow(/not valid/);
      await expect(validate('PAST', 10)).rejects.toThrow(/not valid/);

      const redeem = (orderId: string) => inTenant(() => prisma.db.$transaction((tx) => v.redeem(tx, once.id, orderId)));
      const ordA = `ord-a-${randomUUID()}`; // VoucherRedemption.orderId is globally unique, so ids must not repeat across runs
      await redeem(ordA);
      await redeem(ordA); // same order: no second use
      expect((await get('/vouchers', mgr1.token)).find((x: any) => x.code === 'ONCE').usedCount).toBe(1);
      await expect(redeem(`ord-b-${randomUUID()}`)).rejects.toThrow(/fully used/);
      await expect(validate('ONCE', 10)).rejects.toThrow(/fully used/);

      await http.patch(`/vouchers/${pct.id}`).set(auth(mgr1.token)).send({ active: false }).expect(200);
      await expect(validate('SAVE10', 40)).rejects.toThrow(/inactive/);
    });
  });

  describe('gift cards', () => {
    it('issues against an open shift, redeems, restores, blocks overdraft, and the ledger stays balanced', async () => {
      await http.post('/pos/gift-cards').set(auth(cashier.token)).send({ amount: 50, method: 'CASH' }).expect(400); // no shift yet
      const shift = await inTenant(() => prisma.db.shift.create({ data: { tenantId: '', branchId: fx.b1.branchId, cashierId: cashier.id } }));
      const a = (await http.post('/pos/gift-cards').set(auth(cashier.token)).send({ amount: 50, method: 'CASH' }).expect(201)).body;
      const b = (await http.post('/pos/gift-cards').set(auth(cashier.token)).send({ amount: 20.5, method: 'CARD' }).expect(201)).body;
      expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);

      const entries = await inTenant(() => prisma.db.shiftCashEntry.findMany({ where: { shiftId: shift.id } }));
      expect(entries.map((e) => [e.kind, e.amount.toString()])).toEqual([['GIFT_CARD_SALE', '50']]); // card sale does not touch the drawer

      const gc = app.get(GiftCardService);
      const run = <R>(fn: (tx: any) => Promise<R>) => inTenant(() => prisma.db.$transaction(fn));
      expect((await run((tx) => gc.redeem(tx, a.code, dec(30)))).balance.toString()).toBe('20');
      await expect(run((tx) => gc.redeem(tx, a.code, dec(20.001)))).rejects.toThrow(/Insufficient/);
      await run((tx) => gc.redeem(tx, a.code, dec(20)));
      expect((await get(`/pos/gift-cards/${a.code}`, cashier.token)).status).toBe('EXHAUSTED');
      await expect(run((tx) => gc.redeem(tx, a.code, dec(1)))).rejects.toThrow(/Insufficient/);
      await run((tx) => gc.restore(tx, a.code, dec(12)));
      expect(await get(`/pos/gift-cards/${a.code}`, cashier.token)).toMatchObject({ balance: '12', status: 'ACTIVE' });
      await expect(run((tx) => gc.redeem(tx, 'ZZZZZZZZZZZZ', dec(1)))).rejects.toThrow(/Unknown/);

      // liability = outstanding balances (12 + 20.5)
      const tb = await get('/finance/trial-balance');
      const row = tb.rows.find((r: any) => r.code === '2300');
      expect(Number(row.credit) - Number(row.debit)).toBeCloseTo(50 + 20.5);
      expect(tb.balanced).toBe(true);
      const outstanding = Number(b.balance) + 12;
      expect(outstanding).toBeCloseTo(32.5);

      await http.post(`/pos/gift-cards/${b.code}/void`).set(auth(cashier.token)).expect(403);
      await http.post(`/pos/gift-cards/${b.code}/void`).set(auth(T.token)).expect(201);
      await expect(run((tx) => gc.redeem(tx, b.code, dec(1)))).rejects.toThrow(/void/);
      expect((await get('/audit?action=giftcard.voided')).length).toBe(1);
    });
  });

  describe('KDS', () => {
    it('routes lines to stations, prioritises rush orders, and enforces transitions', async () => {
      const dine = await makeOrder(fx.b1.branchId, 'DINE_IN');
      const rush = await makeOrder(fx.b1.branchId, 'DELIVERY');
      const kds = app.get(KdsService);
      const lines = (n: string) => [
        { id: `${n}-1`, name: 'Burger', qty: 2, modifiers: [{ id: 'm1', name: 'No onion' }], notes: 'well done', stationKey: 'GRILL' },
        { id: `${n}-2`, name: 'Latte', qty: 1, modifiers: [], notes: null, stationKey: 'BAR' },
        { id: `${n}-3`, name: 'Fries', qty: 1, modifiers: [], stationKey: null },
      ];
      await inTenant(() => prisma.db.$transaction((tx) => kds.createTickets(tx, dine, lines('d'))));
      await inTenant(() => prisma.db.$transaction((tx) => kds.createTickets(tx, rush, lines('r'))));

      expect((await get(`/kds/stations?branchId=${fx.b1.branchId}`, kitchen1.token)).map((s: any) => s.key)).toEqual(['BAR', 'GRILL', 'KITCHEN']);
      const grill = await tickets(kitchen1.token, fx.b1.branchId, '&stationKey=GRILL');
      expect(grill).toHaveLength(2);
      expect(grill.map((t: any) => t.priority)).toEqual(['RUSH', 'NORMAL']); // rush first even though created later
      expect(grill[1]).toMatchObject({ stationName: 'Grill', orderNumber: dine.number, status: 'NEW' });
      expect(grill[1].items[0]).toMatchObject({ lineId: 'd-1', name: 'Burger', qty: 2, cancelled: false, notes: 'well done' });
      expect(typeof grill[1].ageSeconds).toBe('number');
      expect(await tickets(kitchen1.token, fx.b1.branchId, '&stationKey=KITCHEN')).toHaveLength(2); // null station -> KITCHEN

      const t = grill[1];
      const act = (id: string, a: string, token = kitchen1.token) => http.post(`/kds/tickets/${id}/${a}`).set(auth(token));
      await act(t.id, 'ready').expect(400); // must start first
      await act(t.id, 'bump').expect(400);
      await act(t.id, 'start').expect(201);
      await act(t.id, 'start').expect(400);
      const ready = (await act(t.id, 'ready').expect(201)).body;
      expect(ready.readyAt).toBeTruthy();
      const note = (await get('/notifications', cashier.token)).find((n: any) => n.title === `Order ${dine.number} ready`);
      expect(note).toBeTruthy();
      await act(t.id, 'recall').expect(201); // back to in progress
      await act(t.id, 'ready').expect(201);
      const bumped = (await act(t.id, 'bump').expect(201)).body;
      expect(bumped.bumpedAt).toBeTruthy();
      await act(t.id, 'ready').expect(400);
      await act(t.id, 'recall').expect(201);
      await act(t.id, 'nope').expect(404);
      expect((await tickets(kitchen1.token, fx.b1.branchId, '&status=BUMPED'))).toHaveLength(0);
    });

    it('cancelling lines or an order updates tickets', async () => {
      const o = await makeOrder(fx.b1.branchId);
      const kds = app.get(KdsService);
      await inTenant(() => prisma.db.$transaction((tx) => kds.createTickets(tx, o, [
        { id: 'c-1', name: 'Burger', qty: 1, modifiers: [], stationKey: 'GRILL' },
        { id: 'c-2', name: 'Steak', qty: 1, modifiers: [], stationKey: 'GRILL' },
        { id: 'c-3', name: 'Tea', qty: 1, modifiers: [], stationKey: 'BAR' },
      ])));
      await inTenant(() => prisma.db.$transaction((tx) => kds.cancelLines(tx, o.id, ['c-1', 'c-3'])));
      const all = await inTenant(() => prisma.db.kitchenTicket.findMany({ where: { orderId: o.id }, include: { station: true } }));
      const grill = all.find((t) => t.station.key === 'GRILL')!;
      const bar = all.find((t) => t.station.key === 'BAR')!;
      expect(bar.status).toBe('CANCELLED');
      expect(grill.status).toBe('NEW');
      expect((grill.items as any[]).map((i) => [i.lineId, i.cancelled])).toEqual([['c-1', true], ['c-2', false]]);
      await inTenant(() => prisma.db.$transaction((tx) => kds.cancelOrder(tx, o.id)));
      expect((await inTenant(() => prisma.db.kitchenTicket.findMany({ where: { orderId: o.id } }))).every((t) => t.status === 'CANCELLED')).toBe(true);
    });

    it('branch scope: kitchen staff only see and act on their own branch', async () => {
      await http.get(`/kds/tickets?branchId=${fx.b1.branchId}`).set(auth(kitchen2.token)).expect(403);
      await http.get(`/kds/stations?branchId=${fx.b1.branchId}`).set(auth(kitchen2.token)).expect(403);
      const t = (await tickets(kitchen1.token, fx.b1.branchId))[0];
      await http.post(`/kds/tickets/${t.id}/start`).set(auth(kitchen2.token)).expect(403);
      await http.get('/kds/tickets').set(auth(kitchen1.token)).expect(400);
    });
  });

  describe('floor', () => {
    it('manages plans and tables with branch scope and shows open orders on tables', async () => {
      await http.post('/floor/plans').set(auth(cashier.token)).send({ branchId: fx.b1.branchId, name: 'Hall' }).expect(403);
      await http.post('/floor/plans').set(auth(mgr1.token)).send({ branchId: fx.b2.branchId, name: 'Hall' }).expect(403); // other branch
      const plan = (await http.post('/floor/plans').set(auth(mgr1.token)).send({ branchId: fx.b1.branchId, name: 'Hall' }).expect(201)).body;
      const t1 = (await http.post(`/floor/plans/${plan.id}/tables`).set(auth(mgr1.token)).send({ name: 'T1', seats: 4 }).expect(201)).body;
      const t2 = (await http.post(`/floor/plans/${plan.id}/tables`).set(auth(mgr1.token)).send({ name: 'T2', seats: 2 }).expect(201)).body;
      await http.post(`/floor/plans/${plan.id}/tables`).set(auth(mgr1.token)).send({ name: 'T1', seats: 2 }).expect(409);

      const open = await makeOrder(fx.b1.branchId, 'DINE_IN', t1.id, 'SENT');
      await makeOrder(fx.b1.branchId, 'DINE_IN', t2.id, 'OPEN').then((o) => inTenant(() => prisma.db.order.updateMany({ where: { id: o.id }, data: { status: 'COMPLETED' } })));
      const tables = await get(`/floor/tables?branchId=${fx.b1.branchId}`, cashier.token);
      expect(tables.find((t: any) => t.id === t1.id)).toMatchObject({ openOrderId: open.id, openOrderNumber: open.number });
      expect(tables.find((t: any) => t.id === t2.id)).toMatchObject({ openOrderId: null, openOrderNumber: null });
      expect((await get(`/floor/plans?branchId=${fx.b1.branchId}`, kitchen1.token))[0].tables.length).toBeGreaterThanOrEqual(2);
      await http.get(`/floor/tables?branchId=${fx.b1.branchId}`).set(auth(kitchen2.token)).expect(403);

      await http.delete(`/floor/tables/${t2.id}`).set(auth(cashier.token)).expect(403);
      await http.delete(`/floor/tables/${t2.id}`).set(auth(mgr1.token)).expect(200);
      expect((await get(`/floor/tables?branchId=${fx.b1.branchId}`, cashier.token)).map((t: any) => t.id)).not.toContain(t2.id);
    });
  });

  it('keeps the ledger balanced', async () => {
    expect((await get('/finance/trial-balance')).balanced).toBe(true);
  });
});
