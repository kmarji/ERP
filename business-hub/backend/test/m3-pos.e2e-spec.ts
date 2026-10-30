import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp } from './helpers';
import { PosWorld, posHelpers, setupPos } from './pos-fixtures';

describe('M3 POS: Sale-to-Financial-Control (AT-03, AT-04)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let w: PosWorld;
  let T: PosWorld['T'];
  let fx: PosWorld['fx'];
  let cashier: PosWorld['cashier'];
  let manager: PosWorld['manager'];
  let fin: PosWorld['fin'];
  let latte: any;
  let cake: any;
  let shift: any;
  let table1: any;
  type H = ReturnType<typeof posHelpers>;
  let get: H['get'], post: H['post'], key: H['key'], lineLatte: H['lineLatte'], lineCake: H['lineCake'], newOrder: H['newOrder'], payCash: H['payCash'];
  let sellCash: H['sellCash'], stock: H['stock'], journalsFor: H['journalsFor'], byAccount: H['byAccount'];

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    w = await setupPos(http, 'm3');
    ({ get, post, key, lineLatte, lineCake, newOrder, payCash, sellCash, stock, journalsFor, byAccount } = posHelpers(http, w));
    ({ T, fx, cashier, manager, fin, latte, cake, shift, table1 } = w);
  });

  afterAll(() => app.close());

  describe('AT-03: a POS sale creates the right records once', () => {
    let order: any;
    let milkBefore: any;

    it('prices a modified sale with tax-inclusive maths', async () => {
      milkBefore = await stock(fx.milk.id);
      order = await newOrder([lineLatte(2), lineCake(1)]);
      expect(order).toMatchObject({ status: 'OPEN', subtotal: '10.08', total: '10.08', taxTotal: '1.39', discountTotal: '0' });
      expect(order.lines.find((l: any) => l.name === 'Latte')).toMatchObject({ unitPrice: '3.3', gross: '6.6', tax: '0.91', net: '5.69', nameAr: 'لاتيه' });
      expect(order.shiftId).toBe(shift.id);
    });

    it('takes cash with change, completes, issues the invoice and posts revenue, tax and cost of sales', async () => {
      const t = await payCash(order.id, 20);
      expect(t).toMatchObject({ status: 'CAPTURED', amount: '10.08', tendered: '20', change: '9.92' });
      const done = (await post(`/pos/orders/${order.id}/complete`, cashier.token).expect(201)).body;
      expect(done).toMatchObject({ status: 'COMPLETED', postingStatus: 'POSTED' });
      expect(done.invoice).toMatchObject({ number: expect.stringMatching(/^SI-\d{6}$/), total: '10.08', taxTotal: '1.39' });

      const [sale, cogs] = await journalsFor('Order', order.id).then((js: any[]) => [js.find((j) => !j.memo.startsWith('Cost')), js.find((j) => j.memo.startsWith('Cost'))]);
      expect(byAccount(sale)).toEqual({ CASH: ['10.08', '0'], SALES: ['0', '8.69'], OUTPUT_TAX: ['0', '1.39'] });
      expect(byAccount(cogs)).toEqual({ COGS: ['1.425', '0'], INVENTORY: ['0', '1.425'] });

      // theoretical consumption: 2 x (0.25 l x 1.5 large + 0.1 l extra milk) = 0.95 l, kept as a SALE_CONSUMPTION movement
      expect(Number((await stock(fx.milk.id)).qtyBase) - Number(milkBefore.qtyBase)).toBeCloseTo(-0.95);
      const moves = await get(`/inventory/movements?sourceType=Order&sourceId=${order.id}`);
      expect(moves.map((m: any) => m.type)).toEqual(['SALE_CONSUMPTION']);

      const ev = await prisma.raw.businessEvent.findMany({ where: { tenantId: T.tenantId, aggregateId: order.id } });
      expect(ev.map((e) => e.type)).toEqual(['SaleFinalized']);
      expect(await get('/finance/reconciliation/inventory')).toMatchObject({ reconciled: true });
      expect((await get('/finance/trial-balance')).balanced).toBe(true);
    });

    it('is safe to retry at every step: no duplicate order, tender, invoice, journal or stock movement', async () => {
      const ik = key();
      const a = (await post('/pos/orders', cashier.token, { idempotencyKey: ik, branchId: fx.b1.branchId, lines: [lineCake(1)] }).expect(201)).body;
      const b = (await post('/pos/orders', cashier.token, { idempotencyKey: ik, branchId: fx.b1.branchId, lines: [lineCake(1)] }).expect(201)).body;
      expect(b.id).toBe(a.id);
      const tk = key();
      const t1 = (await post(`/pos/orders/${a.id}/tenders`, cashier.token, { idempotencyKey: tk, method: 'CASH', tendered: 5 }).expect(201)).body;
      const t2 = (await post(`/pos/orders/${a.id}/tenders`, cashier.token, { idempotencyKey: tk, method: 'CASH', tendered: 5 }).expect(201)).body;
      expect(t2.id).toBe(t1.id);
      await post(`/pos/orders/${a.id}/complete`, cashier.token).expect(201);
      await post(`/pos/orders/${a.id}/complete`, cashier.token).expect(201);
      await post(`/pos/orders/${order.id}/repost`, fin.token).expect(201); // posting is idempotent too
      expect(await journalsFor('Order', a.id)).toHaveLength(1); // cake has no recipe: sale journal only
      expect(await journalsFor('Order', order.id)).toHaveLength(2);
      expect(await prisma.raw.invoice.count({ where: { orderId: a.id } })).toBe(1);
      await post(`/pos/orders/${a.id}/tenders`, cashier.token, { idempotencyKey: key(), method: 'CASH', tendered: 5 }).expect(409); // already paid
    });

    it('produces a bilingual receipt with the tax breakdown', async () => {
      const r = await get(`/pos/orders/${order.id}/receipt`, cashier.token);
      expect(r).toMatchObject({ currency: 'JOD', total: '10.08', taxBreakdown: [{ ratePct: '16', net: '8.69', tax: '1.39' }] });
      expect(r.lines.find((l: any) => l.name === 'Latte').nameAr).toBe('لاتيه');
      expect(r.invoiceNumber).toMatch(/^SI-/);
    });
  });

  describe('payments', () => {
    it('supports split tender (gift card + card), declines, and refuses to complete an underpaid order', async () => {
      const gc = (await post('/pos/gift-cards', cashier.token, { amount: 20, method: 'CASH' }).expect(201)).body;
      const o = await newOrder([lineCake(2)]); // 6.96
      await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(400); // nothing paid
      await post(`/pos/orders/${o.id}/tenders`, cashier.token, { idempotencyKey: key(), method: 'GIFT_CARD', reference: gc.code, amount: 5 }).expect(201);
      const declined = (await post(`/pos/orders/${o.id}/tenders`, cashier.token, { idempotencyKey: key(), method: 'CARD', reference: 'DECLINE-1', amount: 1.96 }).expect(201)).body;
      expect(declined.status).toBe('FAILED');
      await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(400); // still underpaid
      await post(`/pos/orders/${o.id}/tenders`, cashier.token, { idempotencyKey: key(), method: 'CARD', reference: 'SLIP-1', amount: 5 }).expect(400); // more than the 1.96 still due
      const card = (await post(`/pos/orders/${o.id}/tenders`, cashier.token, { idempotencyKey: key(), method: 'CARD', reference: 'SLIP-1', amount: 1.96 }).expect(201)).body;
      expect(card.status).toBe('CAPTURED'); // authorized, then captured: states are separate from the order's
      const done = (await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(201)).body;
      expect(done.postingStatus).toBe('POSTED');
      const sale = (await journalsFor('Order', o.id))[0];
      expect(byAccount(sale)).toEqual({ GIFT_CARD: ['5', '0'], CARD_CLEARING: ['1.96', '0'], SALES: ['0', '6'], OUTPUT_TAX: ['0', '0.96'] });
      expect((await get(`/pos/gift-cards/${gc.code}`, cashier.token)).balance).toBe('15');
      expect((await get('/finance/trial-balance')).balanced).toBe(true);
    });
  });

  describe('discounts, vouchers and loyalty', () => {
    it('small discounts are free; large ones need a manager, who is recorded as approver', async () => {
      const o = await newOrder([lineCake(2)]); // 6.96
      const small = (await post(`/pos/orders/${o.id}/discount`, cashier.token, { kind: 'PERCENT', value: 5, reason: 'regular customer' }).expect(201)).body;
      expect(small.discountTotal).toBe('0.348'); // JOD has three decimals
      const o2 = await newOrder([lineCake(2)]);
      await post(`/pos/orders/${o2.id}/discount`, cashier.token, { kind: 'PERCENT', value: 30, reason: 'friend' }).expect(403);
      const big = (await post(`/pos/orders/${o2.id}/discount`, manager.token, { kind: 'PERCENT', value: 30, reason: 'service recovery' }).expect(201)).body;
      expect(big).toMatchObject({ discountTotal: '2.088', total: '4.872' });
      expect(big.discounts[0]).toMatchObject({ kind: 'PERCENT', approvedBy: manager.id });
    });

    it('a cashier can obtain a manager override at the terminal; the approver is recorded and the manager must hold the right role', async () => {
      const o = await newOrder([lineCake(2)]);
      const wrong = { email: `cash2@${T.slug}.test`, password: 'correct-horse-battery' }; // another cashier cannot approve
      await post(`/pos/orders/${o.id}/discount`, cashier.token, { kind: 'PERCENT', value: 30, reason: 'friend', override: wrong }).expect(403);
      await post(`/pos/orders/${o.id}/discount`, cashier.token, { kind: 'PERCENT', value: 30, reason: 'friend', override: { email: `mgr1@${T.slug}.test`, password: 'bad-password' } }).expect(403);
      const ok = (await post(`/pos/orders/${o.id}/discount`, cashier.token, { kind: 'PERCENT', value: 30, reason: 'friend', override: { email: `mgr1@${T.slug}.test`, password: 'correct-horse-battery' } }).expect(201)).body;
      expect(ok.discounts[0]).toMatchObject({ approvedBy: manager.id });
      const audit = (await get('/audit?action=override')).map((a: any) => a.action);
      expect(audit).toEqual(expect.arrayContaining(['override.granted', 'override.denied']));
      await post(`/pos/orders/${o.id}/void`, cashier.token, { reason: 'test cleanup' }).expect(201);
    });

    it('posts the discount to its own contra account and keeps tax on the discounted amount', async () => {
      const o = await newOrder([{ menuItemId: cake.id, qty: 5 }]); // 17.40
      await post(`/pos/orders/${o.id}/discount`, cashier.token, { kind: 'AMOUNT', value: 1.74, reason: '10% promo' }).expect(201);
      await payCash(o.id, 20);
      const done = (await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(201)).body;
      expect(done).toMatchObject({ subtotal: '17.4', discountTotal: '1.74', total: '15.66', taxTotal: '2.16' });
      expect(byAccount((await journalsFor('Order', o.id))[0])).toEqual({ CASH: ['15.66', '0'], SALES_DISCOUNTS: ['1.5', '0'], SALES: ['0', '15'], OUTPUT_TAX: ['0', '2.16'] });
    });

    it('vouchers are counted once at completion; loyalty points are earned, redeemed and clawed back', async () => {
      await post('/vouchers', T.token, { code: 'SAVE10', kind: 'PERCENT', value: 10, maxUses: 1 }).expect(201);
      const cust = (await post('/customers', cashier.token, { name: 'Sara', phone: '0790000001', consent: true }).expect(201)).body;
      const o = await newOrder([lineCake(3)], cashier.token, { customerId: cust.id }); // 10.44
      const v = (await post(`/pos/orders/${o.id}/voucher`, cashier.token, { code: 'SAVE10' }).expect(201)).body;
      expect(v.discountTotal).toBe('1.044');
      await post(`/pos/orders/${o.id}/voucher`, cashier.token, { code: 'SAVE10' }).expect(409);
      await payCash(o.id, 10);
      await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(201);
      expect((await get('/vouchers')).find((x: any) => x.code === 'SAVE10').usedCount).toBe(1);
      const o2 = await newOrder([lineCake(1)]);
      await post(`/pos/orders/${o2.id}/voucher`, cashier.token, { code: 'SAVE10' }).expect(400); // used up
      expect((await get(`/customers/${cust.id}`, cashier.token)).points).toBe(9); // floor(9.40)

      const o3 = await newOrder([lineCake(2)], cashier.token, { customerId: cust.id }); // 6.96
      await post(`/pos/orders/${o3.id}/loyalty`, cashier.token, { points: 500 }).expect(400); // not enough points
      const l = (await post(`/pos/orders/${o3.id}/loyalty`, cashier.token, { points: 9 }).expect(201)).body;
      expect(l.discountTotal).toBe('0.09');
      await payCash(o3.id, 7);
      await post(`/pos/orders/${o3.id}/complete`, cashier.token).expect(201);
      expect((await get(`/customers/${cust.id}`, cashier.token)).points).toBe(6); // 9 - 9 redeemed + floor(6.87) earned
    });
  });

  describe('kitchen', () => {
    it('sends to the right stations, blocks cashiers from voiding sent lines, and cancels the kitchen ticket', async () => {
      const o = await newOrder([lineLatte(1), lineCake(1)], cashier.token, { tableId: table1.id, channel: 'DINE_IN' });
      await post(`/pos/orders/${o.id}/send`, cashier.token).expect(201);
      const tickets = (await get(`/kds/tickets?branchId=${fx.b1.branchId}`, cashier.token)).filter((t: any) => t.orderId === o.id);
      expect(tickets.map((t: any) => t.stationKey).sort()).toEqual(['BAR', 'KITCHEN']);
      expect((await get(`/floor/tables?branchId=${fx.b1.branchId}`, cashier.token)).find((t: any) => t.id === table1.id).openOrderId).toBe(o.id);
      await post('/pos/orders', cashier.token, { idempotencyKey: key(), branchId: fx.b1.branchId, tableId: table1.id, lines: [lineCake(1)] }).expect(409); // table busy

      const cakeLine = (await get(`/pos/orders/${o.id}`, cashier.token)).lines.find((l: any) => l.name === 'Cake');
      await post(`/pos/orders/${o.id}/lines/${cakeLine.id}/void`, cashier.token, { reason: 'customer changed mind' }).expect(403);
      const voided = (await post(`/pos/orders/${o.id}/lines/${cakeLine.id}/void`, manager.token, { reason: 'customer changed mind' }).expect(201)).body;
      expect(voided).toMatchObject({ total: '3.3', subtotal: '3.3' });
      const after = (await get(`/kds/tickets?branchId=${fx.b1.branchId}&status=CANCELLED`, cashier.token)).filter((t: any) => t.orderId === o.id);
      expect(after).toHaveLength(1);

      // transfer table, then pay and complete
      const plan = (await post('/floor/plans', T.token, { branchId: fx.b1.branchId, name: 'Terrace' }).expect(201)).body;
      const t2 = (await post(`/floor/plans/${plan.id}/tables`, T.token, { name: 'T2', seats: 2 }).expect(201)).body;
      await post(`/pos/orders/${o.id}/table`, cashier.token, { tableId: t2.id }).expect(201);
      await payCash(o.id, 5);
      await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(201);
    });

    it('splits a bill by items, paying each part separately', async () => {
      const o = await newOrder([lineCake(1), lineLatte(1)], cashier.token, { tableId: table1.id });
      const lines = (await get(`/pos/orders/${o.id}`, cashier.token)).lines;
      const cakeLine = lines.find((l: any) => l.name === 'Cake');
      const s = (await post(`/pos/orders/${o.id}/split`, cashier.token, { lineIds: [cakeLine.id] }).expect(201)).body;
      expect(s.split).toMatchObject({ total: '3.48', tableId: table1.id });
      expect(s.original.total).toBe('3.3');
      await post(`/pos/orders/${o.id}/split`, cashier.token, { lineIds: lines.filter((l: any) => l.name !== 'Cake').map((l: any) => l.id) }).expect(400); // must leave a line
      for (const id of [o.id, s.split.id]) {
        await payCash(id, 5);
        await post(`/pos/orders/${id}/complete`, cashier.token).expect(201);
      }
    });

    it('voids an unpaid order but refuses to void a paid one', async () => {
      const o = await newOrder([lineCake(1)]);
      expect((await post(`/pos/orders/${o.id}/void`, cashier.token, { reason: 'walked out' }).expect(201)).body.status).toBe('VOIDED');
      expect(await journalsFor('Order', o.id)).toHaveLength(0);
      const paid = await newOrder([lineCake(1)]);
      await payCash(paid.id, 4);
      await post(`/pos/orders/${paid.id}/void`, cashier.token, { reason: 'mistake' }).expect(409);
      await post(`/pos/orders/${paid.id}/complete`, cashier.token).expect(201);
    });
  });

  describe('order editing', () => {
    it('changes quantity of unsent lines and attaches a customer; sent lines are protected', async () => {
      const cust = (await post('/customers', cashier.token, { name: 'Omar', phone: '0790000077', consent: true }).expect(201)).body;
      const o = await newOrder([lineCake(1)]);
      const line = o.lines[0];
      const q = (await post(`/pos/orders/${o.id}/lines/${line.id}/qty`, cashier.token, { qty: 3 }).expect(201)).body;
      expect(q).toMatchObject({ total: '10.44', taxTotal: '1.44' });
      await post(`/pos/orders/${o.id}/lines/${line.id}/qty`, cashier.token, { qty: 0 }).expect(400);
      const p = (await http.patch(`/pos/orders/${o.id}`).set(auth(cashier.token)).send({ customerId: cust.id, guestCount: 2, notes: 'birthday' }).expect(200)).body;
      expect(p).toMatchObject({ customerId: cust.id, guestCount: 2, notes: 'birthday' });
      await http.patch(`/pos/orders/${o.id}`).set(auth(cashier.token)).send({ customerId: 'nope' }).expect(400);
      await post(`/pos/orders/${o.id}/send`, cashier.token).expect(201);
      await post(`/pos/orders/${o.id}/lines/${line.id}/qty`, cashier.token, { qty: 2 }).expect(409);
      await payCash(o.id, 11);
      await post(`/pos/orders/${o.id}/complete`, cashier.token).expect(201);
    });
  });

  describe('AT-04: refunds reverse without rewriting history', () => {
    let order: any;
    let originalJournals: any[];
    let milkBefore: any;

    it('a partial cash refund with restock adds a credit note, reverses tax and stock, and leaves the original untouched', async () => {
      order = await sellCash([lineLatte(2), lineCake(1)]); // 10.08
      originalJournals = await journalsFor('Order', order.id);
      expect(originalJournals).toHaveLength(2);
      milkBefore = await stock(fx.milk.id);
      const latteLine = order.lines.find((l: any) => l.name === 'Latte');
      const drawerBefore = (await get(`/pos/shifts/${shift.id}/report`, manager.token)).expectedCash;

      const rk = key();
      const r = (await post(`/pos/orders/${order.id}/refunds`, cashier.token, { idempotencyKey: rk, lines: [{ orderLineId: latteLine.id, qty: 1 }], reason: 'wrong drink', restock: true }).expect(201)).body;
      expect(r).toMatchObject({ total: '3.3', tax: '0.455', method: 'CASH', postingStatus: 'POSTED', approvedBy: null, restock: true });
      expect(r.number).toMatch(/^CN-/);
      expect(byAccount((await journalsFor('Refund', r.id)).find((j: any) => !j.memo.startsWith('Restock')))).toEqual({ SALES: ['2.845', '0'], OUTPUT_TAX: ['0.455', '0'], CASH: ['0', '3.3'] });
      expect(byAccount((await journalsFor('Refund', r.id)).find((j: any) => j.memo.startsWith('Restock')))).toEqual({ INVENTORY: ['0.713', '0'], COGS: ['0', '0.713'] });

      expect(Number((await stock(fx.milk.id)).qtyBase) - Number(milkBefore.qtyBase)).toBeCloseTo(0.475); // one latte's worth returned
      const after = await get(`/pos/orders/${order.id}`, cashier.token);
      expect(after).toMatchObject({ status: 'COMPLETED', refundStatus: 'PARTIAL', refundedTotal: '3.3', total: '10.08' }); // original total intact
      expect(await journalsFor('Order', order.id)).toEqual(originalJournals); // original journals byte-for-byte unchanged
      expect((await get(`/pos/shifts/${shift.id}/report`, manager.token)).expectedCash).toBe(String(Number(drawerBefore) - 3.3));

      const again = (await post(`/pos/orders/${order.id}/refunds`, cashier.token, { idempotencyKey: rk, lines: [{ orderLineId: latteLine.id, qty: 1 }], reason: 'wrong drink', restock: true }).expect(201)).body;
      expect(again.id).toBe(r.id); // retry creates nothing new
      const audit = await get(`/audit?entityType=Order&entityId=${order.id}`);
      expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['order.created', 'order.completed', 'sale.posted']));
    });

    it('refunds above the cashier limit need a manager, who is recorded as approver; over-refunding is rejected', async () => {
      const latteLine = order.lines.find((l: any) => l.name === 'Latte');
      await post(`/pos/orders/${order.id}/refunds`, cashier.token, { idempotencyKey: key(), lines: [{ orderLineId: latteLine.id, qty: 2 }], reason: 'too many' }).expect(400); // only 1 left
      const big = await sellCash([{ menuItemId: cake.id, qty: 6 }]); // 20.88 JOD
      await post(`/pos/orders/${big.id}/refunds`, cashier.token, { idempotencyKey: key(), full: true, reason: 'customer unhappy' }).expect(403); // over the 15 JOD cashier limit
      const drawerBefore = Number((await get(`/pos/shifts/${shift.id}/report`, manager.token)).expectedCash);
      const override = { email: `mgr1@${T.slug}.test`, password: 'correct-horse-battery' };
      const r = (await post(`/pos/orders/${big.id}/refunds`, cashier.token, { idempotencyKey: key(), full: true, reason: 'customer unhappy', override }).expect(201)).body;
      expect(r).toMatchObject({ total: '20.88', approvedBy: manager.id, createdBy: cashier.id }); // manager approved, cashier's drawer paid
      expect(Number((await get(`/pos/shifts/${shift.id}/report`, manager.token)).expectedCash)).toBeCloseTo(drawerBefore - 20.88, 3);
      expect((await get(`/pos/orders/${big.id}`, cashier.token)).refundStatus).toBe('FULL');
      await post(`/pos/orders/${big.id}/refunds`, cashier.token, { idempotencyKey: key(), full: true, reason: 'again', override }).expect(400); // nothing left
    });

    it('partial refunds never lose a fil: three single-unit refunds add up to exactly the sale', async () => {
      const odd = (await post('/menu/items', T.token, { sku: 'ODD', name: 'Odd', price: 3.33, taxCodeId: fx.s16.id }).expect(201)).body;
      const sale = await sellCash([{ menuItemId: odd.id, qty: 3 }]); // 9.99 incl 1.378 tax
      expect(sale).toMatchObject({ total: '9.99', taxTotal: '1.378' });
      const line = sale.lines[0];
      const refunds: any[] = [];
      for (let i = 0; i < 3; i++) refunds.push((await post(`/pos/orders/${sale.id}/refunds`, cashier.token, { idempotencyKey: key(), lines: [{ orderLineId: line.id, qty: 1 }], reason: `unit ${i + 1}` }).expect(201)).body);
      const sum = (f: string) => refunds.reduce((s, r) => s + Number(r[f]), 0);
      expect(sum('total')).toBeCloseTo(9.99, 3);
      expect(sum('tax')).toBeCloseTo(1.378, 3);
      expect((await get(`/pos/orders/${sale.id}`, cashier.token))).toMatchObject({ refundStatus: 'FULL', refundedTotal: '9.99' });
      expect((await get('/finance/trial-balance')).balanced).toBe(true);
    });
  });
});
