import { INestApplication } from '@nestjs/common';
import { Http, auth, createApp } from './helpers';
import { PosWorld, posHelpers, setupPos } from './pos-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';

describe('M3 POS operations: shifts, settlements, offline sync (AT-06), posting failures', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let w: PosWorld;
  type H = ReturnType<typeof posHelpers>;
  let get: H['get'], post: H['post'], key: H['key'], lineCake: H['lineCake'], newOrder: H['newOrder'], payCash: H['payCash'], sellCash: H['sellCash'];
  let stock: H['stock'], tb: H['tb'], journalsFor: H['journalsFor'], byAccount: H['byAccount'];

  const completeWithCard = async (ref: string, cakes = 1, token = w.cashier.token) => {
    const o = await newOrder([lineCake(cakes)], token);
    const t = (await post(`/pos/orders/${o.id}/tenders`, token, { idempotencyKey: key(), method: 'CARD', reference: ref }).expect(201)).body;
    expect(t.status).toBe('CAPTURED');
    return (await post(`/pos/orders/${o.id}/complete`, token).expect(201)).body;
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    w = await setupPos(http, 'm3ops');
    ({ get, post, key, lineCake, newOrder, payCash, sellCash, stock, tb, journalsFor, byAccount } = posHelpers(http, w));
  });

  afterAll(() => app.close());

  describe('shifts and cash control', () => {
    it('tracks every cash effect, blocks closing with open orders, and books a cash shortage', async () => {
      await post('/pos/shifts', w.cashier.token, { branchId: w.fx.b1.branchId }).expect(409); // already open
      await sellCash([lineCake(2)]); // 6.96
      await sellCash([lineCake(1)]); // 3.48
      await post(`/pos/shifts/${w.shift.id}/drops`, w.cashier.token, { amount: 999 }).expect(400); // more than the drawer holds
      await post(`/pos/shifts/${w.shift.id}/drops`, w.cashier.token, { amount: 20, reason: 'safe drop' }).expect(201);

      const held = await newOrder([lineCake(1)]);
      await post(`/pos/shifts/${w.shift.id}/close`, w.cashier.token, { countedCash: 40 }).expect(409); // an order is still open
      await post(`/pos/orders/${held.id}/void`, w.cashier.token, { reason: 'left it' }).expect(201);

      const report = await get(`/pos/shifts/${w.shift.id}/report`, w.manager.token);
      expect(report).toMatchObject({ orders: 2, total: '10.44', expectedCash: '40.44' }); // 50 float + 10.44 sales - 20 drop
      expect(report.byTender).toEqual([{ method: 'CASH', count: 2, amount: '10.44' }]);

      const closed = (await post(`/pos/shifts/${w.shift.id}/close`, w.cashier.token, { countedCash: 39.44 }).expect(201)).body;
      expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: '40.44', countedCash: '39.44', variance: '-1' });
      expect(byAccount((await journalsFor('Shift', w.shift.id))[0])).toEqual({ CASH_VARIANCE: ['1', '0'], CASH: ['0', '1'] });
      expect((await get('/exceptions?open=true', w.manager.token)).filter((e: any) => e.code === 'POS_CASH_VARIANCE')).toHaveLength(0); // within the 2 JOD auto tolerance
      await post(`/pos/shifts/${w.shift.id}/close`, w.cashier.token, { countedCash: 39.44 }).expect(409);
      await post('/pos/orders', w.cashier.token, { idempotencyKey: key(), branchId: w.fx.b1.branchId, lines: [lineCake(1)] }).expect(409); // no open shift now
    });

    it('a large cash difference is booked and routed to the branch manager, never the owner', async () => {
      const s2 = (await post('/pos/shifts', w.cashier2.token, { branchId: w.fx.b1.branchId, openingFloat: 20 }).expect(201)).body;
      await sellCash([lineCake(1)], w.cashier2.token); // 3.48 -> expected 23.48
      await post(`/pos/shifts/${s2.id}/close`, w.cashier2.token, { countedCash: 18.48 }).expect(201);
      const ex = (await get('/exceptions?open=true', w.manager.token)).find((e: any) => e.code === 'POS_CASH_VARIANCE');
      expect(ex).toMatchObject({ ownerRole: 'BRANCH_MANAGER', branchId: w.fx.b1.branchId, ownerEscalated: false });
      expect((await get('/dashboard/owner')).decisions).toEqual([]);
      // the CASH ledger equals the cash actually taken: 6.96 + 3.48 + 3.48 sales, less 1 and 5 shortages
      expect((await tb('1000')).balance).toBe('7.92');
    });
  });

  describe('card settlement reconciliation (POS-03)', () => {
    let shiftCard: any;

    beforeAll(async () => {
      shiftCard = (await post('/pos/shifts', w.cashier.token, { branchId: w.fx.b1.branchId, openingFloat: 0 }).expect(201)).body;
    });

    it('auto-matches a reliable payout and clears card clearing into bank less fees', async () => {
      await completeWithCard('SLIP-A', 2); // 6.96
      await completeWithCard('SLIP-B', 1); // 3.48
      expect((await tb('1160')).balance).toBe('10.44');
      const s = (await post('/pos/settlements', w.fin.token, { provider: 'ACQUIRER', settlementDate: new Date().toISOString().slice(0, 10), reference: 'STM-1', gross: 10.44, fees: 0.125, net: 10.315, lines: [{ reference: 'SLIP-A', amount: 6.96 }, { reference: 'SLIP-B', amount: 3.48 }] }).expect(201)).body;
      expect(s.status).toBe('MATCHED');
      expect(byAccount((await journalsFor('Settlement', s.id))[0])).toEqual({ BANK: ['10.315', '0'], COMMISSION_EXPENSE: ['0.125', '0'], CARD_CLEARING: ['0', '10.44'] });
      expect((await tb('1160')).balance).toBe('0');
      await post('/pos/settlements', w.fin.token, { provider: 'ACQUIRER', settlementDate: new Date().toISOString().slice(0, 10), reference: 'STM-1', gross: 10.44, fees: 0.125, net: 10.315, lines: [{ reference: 'SLIP-A', amount: 6.96 }] }).expect(409); // same statement twice
      await post('/pos/settlements', w.fin.token, { provider: 'ACQUIRER', settlementDate: new Date().toISOString().slice(0, 10), reference: 'STM-BAD', gross: 10, fees: 1, net: 10, lines: [{ reference: 'SLIP-A', amount: 10 }] }).expect(400); // gross - fees != net
    });

    it('differences, unknown charges and missing payouts become exceptions for finance; accepting books the gap to over/short', async () => {
      await completeWithCard('SLIP-C', 1); // 3.48
      await completeWithCard('SLIP-D', 1); // 3.48, never settled
      const clearingBefore = Number((await tb('1160')).balance); // 6.96
      const s = (await post('/pos/settlements', w.fin.token, { provider: 'ACQUIRER', settlementDate: new Date().toISOString().slice(0, 10), reference: 'STM-2', gross: 8.4, fees: 0.1, net: 8.3, lines: [{ reference: 'SLIP-C', amount: 3.4 }, { reference: 'SLIP-X', amount: 5 }] }).expect(201)).body;
      expect(s.status).toBe('EXCEPTION');
      expect(s.lines.map((l: any) => [l.reference, l.matched])).toEqual(expect.arrayContaining([['SLIP-C', false], ['SLIP-X', false]]));
      expect(Number((await tb('1160')).balance)).toBe(clearingBefore); // nothing cleared yet
      const ex = (await get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'POS_SETTLEMENT_MISMATCH');
      expect(ex).toMatchObject({ ownerRole: 'FINANCE' });
      expect(ex.evidence.unknown[0]).toMatchObject({ reference: 'SLIP-X', amount: '5' });
      expect(ex.evidence.mismatched[0]).toMatchObject({ reference: 'SLIP-C', statement: '3.4', tender: '3.48' });

      const resolved = (await post(`/pos/settlements/${s.id}/resolve`, w.fin.token, { accept: true, reason: 'bank statement is right, 0.08 fee adjustment' }).expect(201)).body;
      expect(resolved.status).toBe('MATCHED');
      // bank 8.3 + fees 0.1 = 8.4 received; only SLIP-C's 3.48 left clearing; the rest of the gap hits cash over/short
      expect(byAccount((await journalsFor('Settlement', s.id))[0])).toEqual({ BANK: ['8.3', '0'], COMMISSION_EXPENSE: ['0.1', '0'], CARD_CLEARING: ['0', '3.48'], CASH_VARIANCE: ['0', '4.92'] });
      expect((await get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'POS_SETTLEMENT_MISMATCH')).toBeUndefined();
      expect((await get('/finance/trial-balance')).balanced).toBe(true);

      const missing = (await post('/pos/settlements/check-missing?olderThanDays=0', w.fin.token).expect(201)).body;
      expect(missing).toMatchObject({ missing: 1, total: '3.48' }); // SLIP-D
      expect((await get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'POS_PAYOUT_MISSING')).toBeDefined();
      await post('/pos/settlements/check-missing?olderThanDays=0', w.fin.token).expect(201);
      expect((await get('/exceptions?open=true', w.fin.token)).filter((e: any) => e.code === 'POS_PAYOUT_MISSING')).toHaveLength(1); // not duplicated
    });
  });

  describe('AT-06: offline POS syncs without duplicates or silent loss', () => {
    let device: { id: string; key: string };
    const hdr = (d = device) => ({ 'x-device-id': d.id, 'x-device-key': d.key });
    const sale = (clientOrderId: string, lines: object[], tendered: number, extra: object = {}) => ({ clientOrderId, channel: 'TAKEAWAY', lines, tenders: [{ method: 'CASH', tendered }], ...extra });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

    beforeAll(async () => {
      device = (await post('/pos/devices', w.manager.token, { branchId: w.fx.b1.branchId, name: 'Tablet 1' }).expect(201)).body;
      await post('/pos/shifts', w.cashier.token, { branchId: w.fx.b1.branchId }).catch(() => undefined); // the card-test shift is still open
    });

    it('enrolls a device with a one-time key and publishes what works offline and what does not', async () => {
      expect(device.key).toHaveLength(48);
      const list = await get('/pos/devices', w.manager.token);
      expect(list[0]).not.toHaveProperty('keyHash');
      await http.get('/pos/offline/bundle').set(auth(w.cashier.token)).expect(401); // device credentials required
      await http.get('/pos/offline/bundle').set(auth(w.cashier.token)).set({ ...hdr(), 'x-device-key': 'wrong' }).expect(401);
      const bundle = (await http.get('/pos/offline/bundle').set(auth(w.cashier.token)).set(hdr()).expect(200)).body;
      expect(bundle.capabilities.blocked.map((b: any) => b.action).join(' ')).toMatch(/CARD/);
      expect(JSON.stringify(bundle.menu)).toContain('Latte');
    });

    it('applies offline sales once, keeps the customer\'s price, flags drift, and explains blocked actions', async () => {
      const ops = [
        { opId: 'op-sale-0001', kind: 'SALE', capturedAt: hoursAgo(2), sale: sale('CL-1', [{ menuItemId: w.cake.id, qty: 2 }], 10) },
        { opId: 'op-drift-001', kind: 'SALE', capturedAt: hoursAgo(1), sale: sale('CL-2', [{ menuItemId: w.cake.id, qty: 1, unitPrice: 4.5 }], 5) },
        { opId: 'op-card-0001', kind: 'SALE', capturedAt: hoursAgo(1), sale: { clientOrderId: 'CL-3', lines: [{ menuItemId: w.cake.id, qty: 1 }], tenders: [{ method: 'CARD', tendered: 3.48 }] } },
        { opId: 'op-refund-01', kind: 'REFUND', capturedAt: hoursAgo(1) },
      ];
      const first = (await http.post('/pos/sync').set(auth(w.cashier.token)).set(hdr()).send({ operations: ops }).expect(201)).body;
      expect(first).toMatchObject({ applied: 2, duplicates: 0, rejected: 2 });
      expect(first.results[0]).toMatchObject({ status: 'APPLIED', orderNumber: expect.any(String) });
      expect(first.results[1]).toMatchObject({ status: 'APPLIED', flags: [expect.stringMatching(/^PRICE_DRIFT/)] });
      expect(first.results[2]).toMatchObject({ status: 'REJECTED', code: 'UNSUPPORTED_TENDER' });
      expect(first.results[3]).toMatchObject({ status: 'REJECTED', code: 'BLOCKED_OFFLINE' });

      // the same batch arrives again after a reconnect: nothing is applied twice
      const again = (await http.post('/pos/sync').set(auth(w.cashier.token)).set(hdr()).send({ operations: ops }).expect(201)).body;
      expect(again).toMatchObject({ applied: 0, duplicates: 2, rejected: 2 });
      expect(again.results[0].orderId).toBe(first.results[0].orderId);
      expect(await prisma.raw.order.count({ where: { tenantId: w.T.tenantId, source: 'OFFLINE' } })).toBe(2);

      // honoured price, original timestamp, fully posted
      const drift = await get(`/pos/orders/${first.results[1].orderId}`, w.manager.token);
      expect(drift).toMatchObject({ total: '4.5', source: 'OFFLINE', externalRef: 'CL-2', postingStatus: 'POSTED', status: 'COMPLETED' });
      expect(new Date(drift.createdAt).getTime()).toBeLessThan(Date.now() - 3_000_000);

      // nothing is lost: the rejected operations are kept and visible, with exceptions for the manager
      const rejected = await get('/pos/sync/operations?status=REJECTED', w.manager.token);
      expect(rejected.map((r: any) => r.opId).sort()).toEqual(['op-card-0001', 'op-refund-01']);
      const open = (await get('/exceptions?open=true', w.manager.token)).map((e: any) => e.code);
      expect(open).toEqual(expect.arrayContaining(['POS_OFFLINE_REJECTED', 'POS_OFFLINE_PRICE_CONFLICT']));
      expect((await get('/finance/trial-balance')).balanced).toBe(true);
    });

    it('a sale rejected for a fixable reason can be retried by a manager and then posts once', async () => {
      await http.patch(`/menu/items/${w.seasonal.id}`).set(auth(w.T.token)).send({ active: false }).expect(200);
      const op = { opId: 'op-seasonal-1', kind: 'SALE', capturedAt: hoursAgo(1), sale: sale('CL-4', [{ menuItemId: w.seasonal.id, qty: 1 }], 5) };
      const r1 = (await http.post('/pos/sync').set(auth(w.cashier.token)).set(hdr()).send({ operations: [op] }).expect(201)).body;
      expect(r1.results[0]).toMatchObject({ status: 'REJECTED', code: 'INVALID' });
      const stored = (await get('/pos/sync/operations?status=REJECTED', w.manager.token)).find((o: any) => o.opId === 'op-seasonal-1');

      await http.patch(`/menu/items/${w.seasonal.id}`).set(auth(w.T.token)).send({ active: true }).expect(200);
      const retried = (await post(`/pos/sync/operations/${stored.id}/retry`, w.manager.token, { shiftId: shiftOf(await openShift()) }).expect(201)).body;
      expect(retried).toMatchObject({ status: 'APPLIED' });
      const again = (await post(`/pos/sync/operations/${stored.id}/retry`, w.manager.token, {}).expect(201)).body;
      expect(again.status).toBe('DUPLICATE');
      expect(await prisma.raw.order.count({ where: { tenantId: w.T.tenantId, externalRef: 'CL-4' } })).toBe(1);
    });

    it('one malformed operation is rejected on its own, and an enrolled device can hold a longer session', async () => {
      const cat = (await post('/menu/categories', w.T.token, { name: 'Bakery' }).expect(201)).body;
      await http.patch(`/menu/items/${w.cake.id}`).set(auth(w.T.token)).send({ categoryId: cat.id }).expect(200);
      const bundle = (await http.get('/pos/offline/bundle').set(auth(w.cashier.token)).set(hdr()).expect(200)).body;
      expect(bundle.menu.categories.map((c: any) => c.name)).toContain('Bakery');
      expect(bundle.menu.tables.map((t: any) => t.name)).toContain('T1');
      expect(bundle.menu.items.find((i: any) => i.sku === 'CAKE').categoryId).toBe(cat.id);

      const good = { opId: 'op-good-0001', kind: 'SALE', capturedAt: hoursAgo(1), sale: sale('CL-5', [{ menuItemId: w.cake.id, qty: 1 }], 4) };
      const bad = { opId: 'op-bad-00001', kind: 'SALE', capturedAt: hoursAgo(1), sale: sale('CL-6', [{ menuItemId: w.cake.id, qty: 0 }], 4) };
      const junk = { opId: 'x', kind: 7 };
      const r = (await http.post('/pos/sync').set(auth(w.cashier.token)).set(hdr()).send({ operations: [good, bad, junk] }).expect(201)).body;
      expect(r).toMatchObject({ applied: 1, rejected: 2 });
      expect(r.results.map((x: any) => x.status)).toEqual(['APPLIED', 'REJECTED', 'REJECTED']);
      expect(r.results[1]).toMatchObject({ code: 'INVALID', reason: expect.stringContaining('qty') });
      // the well-formed but rejected one is stored for review; one without a usable opId cannot be
      expect((await get('/pos/sync/operations?status=REJECTED', w.manager.token)).map((o: any) => o.opId)).toContain('op-bad-00001');

      const session = (await http.post('/pos/session').set(auth(w.cashier.token)).set(hdr()).expect(201)).body;
      expect(session.expiresIn).toBe('12h');
      await http.get('/auth/me').set(auth(session.accessToken)).expect(200);
      await http.post('/pos/session').set(auth(w.cashier.token)).expect(401); // device credentials required
    });

    it('a revoked device is cut off immediately', async () => {
      await post(`/pos/devices/${device.id}/revoke`, w.manager.token).expect(201);
      await http.post('/pos/sync').set(auth(w.cashier.token)).set(hdr()).send({ operations: [{ opId: 'op-late-0001', kind: 'SALE', capturedAt: hoursAgo(1), sale: sale('CL-9', [{ menuItemId: w.cake.id, qty: 1 }], 4) }] }).expect(401);
    });

    async function openShift() {
      return (await get(`/pos/shifts?branchId=${w.fx.b1.branchId}&status=OPEN`, w.manager.token))[0];
    }
    const shiftOf = (s: any) => s.id as string;
  });

  describe('financial posting is its own track', () => {
    it('a locked period never blocks serving the customer: the sale completes, posting fails visibly, and repost fixes it once', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const lock = (await post('/finance/periods/lock', w.fin.token, { startDate: `${today.slice(0, 8)}01`, endDate: `${today.slice(0, 4)}-12-31` }).expect(201)).body;
      const milkBefore = await stock(w.fx.milk.id);
      const done = (await post('/pos/orders', w.cashier.token, { idempotencyKey: key(), branchId: w.fx.b1.branchId, lines: [{ menuItemId: w.latte.id, qty: 1 }] }).expect(201)).body;
      await payCash(done.id, 5);
      const completed = (await post(`/pos/orders/${done.id}/complete`, w.cashier.token).expect(201)).body;
      expect(completed).toMatchObject({ status: 'COMPLETED', postingStatus: 'FAILED' });
      expect(await journalsFor('Order', done.id)).toHaveLength(0);
      expect((await stock(w.fx.milk.id)).qtyBase).toBe(milkBefore.qtyBase); // consumption posts with the ledger, atomically
      const ex = (await get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'POS_POSTING_FAILED' && e.evidence.orderId === done.id);
      expect(ex).toMatchObject({ ownerRole: 'FINANCE' });
      expect(ex.reason).toContain('locked');

      await post(`/finance/periods/${lock.id}/unlock`, w.T.token).expect(201);
      const re = (await post(`/pos/orders/${done.id}/repost`, w.fin.token).expect(201)).body;
      expect(re).toEqual({ posted: true });
      expect((await get(`/pos/orders/${done.id}`, w.cashier.token)).postingStatus).toBe('POSTED');
      expect(await journalsFor('Order', done.id)).toHaveLength(2);
      await post(`/pos/orders/${done.id}/repost`, w.fin.token).expect(201);
      expect(await journalsFor('Order', done.id)).toHaveLength(2);
      expect(Number((await stock(w.fx.milk.id)).qtyBase)).toBeLessThan(Number(milkBefore.qtyBase));
    });
  });

  describe('access control and reporting', () => {
    it('branch-limited staff cannot touch another branch', async () => {
      const o = await newOrder([lineCake(1)]);
      await http.get(`/pos/orders/${o.id}`).set(auth(w.cashierB2.token)).expect(403);
      await post(`/pos/orders/${o.id}/tenders`, w.cashierB2.token, { idempotencyKey: key(), method: 'CASH', tendered: 5 }).expect(403);
      await post('/pos/shifts', w.cashierB2.token, { branchId: w.fx.b1.branchId }).expect(403);
      await post('/pos/orders', w.cashierB2.token, { idempotencyKey: key(), branchId: w.fx.b1.branchId, lines: [lineCake(1)] }).expect(403);
      await post('/pos/devices', w.cashier.token, { branchId: w.fx.b1.branchId, name: 'x' }).expect(403); // cashiers cannot enroll devices
      await post(`/pos/orders/${o.id}/void`, w.cashier.token, { reason: 'cleanup' }).expect(201);
    });

    it('the sales report agrees with the orders and the ledger', async () => {
      const report = await get('/pos/reports/sales', w.manager.token);
      const orders = (await get('/pos/orders?status=COMPLETED&take=200', w.manager.token)) as any[];
      const sum = (f: string) => orders.reduce((s, o) => s + Number(o[f]), 0);
      expect(report.orders).toBe(orders.length);
      expect(Number(report.total)).toBeCloseTo(sum('total'), 3);
      expect(Number(report.tax)).toBeCloseTo(sum('taxTotal'), 3);
      expect(report.byChannel.reduce((s: number, c: any) => s + c.orders, 0)).toBe(orders.length);
      expect(report.topItems[0].name).toBe('Cake');

      // revenue + output tax in the ledger equals sales net of refunds
      const salesLedger = Number((await tb('4000')).credit) - Number((await tb('4000')).debit) - Number((await tb('4100')).debit);
      const taxLedger = Number((await tb('2100')).credit) - Number((await tb('2100')).debit);
      expect(salesLedger + taxLedger).toBeCloseTo(Number(report.netAfterRefunds), 3);
      expect((await get('/finance/trial-balance')).balanced).toBe(true);
      expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
      expect(await get('/finance/reconciliation/inventory')).toMatchObject({ reconciled: true });
    });
  });
});
