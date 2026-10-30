import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { seedPolicyDefaults } from '../src/modules/policy-engine/defaults';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';
import { receiveMilk, setupSupplyChain } from './supply-fixtures';

describe('M2 Inventory-to-Replenishment (WF-06)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let fx: Awaited<ReturnType<typeof setupSupplyChain>>;
  let mgr1: { id: string; token: string };
  let mgr2: { id: string; token: string };
  let proc: { id: string; token: string };
  let kitchen1: { id: string; token: string };

  const get = async (path: string, token = T.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const stock = async (productId: string, locationId: string) => (await get(`/inventory/stock?productId=${productId}&locationId=${locationId}`))[0] ?? { qtyBase: '0', value: '0' };
  const glInventoryOk = async () => expect(await get('/finance/reconciliation/inventory')).toMatchObject({ reconciled: true });

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm2');
    fx = await setupSupplyChain(http, T);
    mgr1 = await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', fx.b1.branchId);
    mgr2 = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', fx.b2.branchId);
    proc = await makeUser(http, T, 'proc', 'PROCUREMENT');
    kitchen1 = await makeUser(http, T, 'kit1', 'KITCHEN', fx.b1.branchId);
    // opening stock: 10 cartons = 120 l at 1.5 JOD/l into branch 1
    const r = await receiveMilk(http, T, fx, fx.b1, 10, proc.token);
    expect(r.outcome).toBe('POSTED');
  });

  afterAll(() => app.close());

  describe('stock counts', () => {
    it('a small variance auto-applies as a count adjustment, separate from sales consumption', async () => {
      const c = (await http.post('/inventory/counts').set(auth(mgr1.token)).send({ locationId: fx.b1.locationId }).expect(201)).body;
      expect(c.lines).toHaveLength(1);
      await http.put(`/inventory/counts/${c.id}/lines`).set(auth(mgr1.token)).send({ entries: [{ productId: fx.milk.id, qty: 118.8 }] }).expect(200);
      const done = (await http.post(`/inventory/counts/${c.id}/submit`).set(auth(mgr1.token)).expect(201)).body;
      expect(done.status).toBe('APPLIED');
      expect(done.lines[0]).toMatchObject({ expectedQtyBase: '120', varianceQty: '-1.2', varianceValue: '-1.8' });
      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBeCloseTo(118.8);

      const j = (await get(`/finance/journals?sourceType=StockCount&sourceId=${c.id}`))[0];
      expect(Object.fromEntries(j.lines.map((l: any) => [l.account.systemKey, [l.debit, l.credit]]))).toEqual({ INVENTORY_ADJUSTMENT: ['1.8', '0'], INVENTORY: ['0', '1.8'] });
      const moves = await get(`/inventory/movements?sourceType=StockCount&sourceId=${c.id}`);
      expect(moves.map((m: any) => m.type)).toEqual(['COUNT_ADJUSTMENT']);
      await glInventoryOk();
    });

    it('a large variance waits for a delegated approver and changes nothing until approved', async () => {
      const before = await stock(fx.milk.id, fx.b1.locationId);
      const c = (await http.post('/inventory/counts').set(auth(proc.token)).send({ locationId: fx.b1.locationId }).expect(201)).body;
      await http.put(`/inventory/counts/${c.id}/lines`).set(auth(proc.token)).send({ entries: [{ productId: fx.milk.id, qty: 60 }] }).expect(200);
      const pending = (await http.post(`/inventory/counts/${c.id}/submit`).set(auth(proc.token)).expect(201)).body;
      expect(pending.status).toBe('PENDING_APPROVAL');
      expect(await stock(fx.milk.id, fx.b1.locationId)).toMatchObject({ qtyBase: before.qtyBase });

      const approval = (await get('/approvals', mgr1.token)).find((a: any) => a.subjectId === c.id);
      expect(approval).toMatchObject({ action: 'inventory.apply_count', approverRole: 'BRANCH_MANAGER' });
      expect((await get('/dashboard/owner')).decisions).toEqual([]); // the owner is not interrupted
      await http.post(`/approvals/${approval.id}/decide`).set(auth(mgr2.token)).send({ approve: true }).expect(403); // other branch's manager
      await http.post(`/approvals/${approval.id}/decide`).set(auth(mgr1.token)).send({ approve: true }).expect(201);

      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBe(60);
      expect((await get(`/inventory/counts/${c.id}`)).status).toBe('APPLIED');
      const ex = (await get('/exceptions', mgr1.token)).find((e: any) => e.code === 'INV_COUNT_VARIANCE');
      expect(ex.status).toBe('VERIFIED');
      await glInventoryOk();
    });

    it('a rejected count adjustment is cancelled and stock stays as it was', async () => {
      const c = (await http.post('/inventory/counts').set(auth(mgr1.token)).send({ locationId: fx.b1.locationId }).expect(201)).body;
      await http.put(`/inventory/counts/${c.id}/lines`).set(auth(mgr1.token)).send({ entries: [{ productId: fx.milk.id, qty: 10 }] }).expect(200);
      await http.post(`/inventory/counts/${c.id}/submit`).set(auth(mgr1.token)).expect(201);
      const approval = (await get('/approvals', mgr1.token)).find((a: any) => a.subjectId === c.id);
      await http.post(`/approvals/${approval.id}/decide`).set(auth(proc.token)).send({ approve: false, comment: 'recount tomorrow' }).expect(403); // procurement ranks below the required branch manager
      await http.post(`/approvals/${approval.id}/decide`).set(auth(T.token)).send({ approve: false, comment: 'recount tomorrow' }).expect(201);
      expect((await get(`/inventory/counts/${c.id}`)).status).toBe('CANCELLED');
      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBe(60);
    });

    it('branch scope: a manager cannot count another branch', async () => {
      await http.post('/inventory/counts').set(auth(mgr2.token)).send({ locationId: fx.b1.locationId }).expect(403);
    });
  });

  describe('wastage', () => {
    it('small wastage is recorded straight away; unusual wastage is recorded and flagged for review', async () => {
      // tune the review threshold down to 10 JOD (a new policy version, as an owner would)
      await http.post('/policies').set(auth(T.token)).send({ key: 'inventory.wastage', riskTier: 'LOW', rules: { maxAutoAmount: 10 } }).expect(201);
      const small = await http.post('/inventory/wastage').set(auth(kitchen1.token)).send({ locationId: fx.b1.locationId, productId: fx.milk.id, qty: 2, reason: 'SPOILED' }).expect(201);
      expect(small.body).toMatchObject({ status: 'RECORDED', qtyBase: '2', value: '3' });
      const big = await http.post('/inventory/wastage').set(auth(kitchen1.token)).send({ locationId: fx.b1.locationId, productId: fx.milk.id, qty: 1, unit: 'carton', reason: 'EXPIRED', notes: 'cold chain failure' }).expect(201);
      expect(big.body).toMatchObject({ status: 'UNDER_REVIEW', qtyBase: '12', value: '18' });

      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBe(46); // 60 - 2 - 12: both already posted
      const ex = (await get('/exceptions?open=true', mgr1.token)).find((e: any) => e.code === 'INV_WASTAGE_REVIEW');
      expect(ex).toMatchObject({ ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW' });
      await glInventoryOk();
    });

    it('branch scope: kitchen staff cannot log wastage for another branch', async () => {
      await http.post('/inventory/wastage').set(auth(kitchen1.token)).send({ locationId: fx.b2.locationId, productId: fx.milk.id, qty: 1, reason: 'OTHER' }).expect(403);
    });
  });

  describe('transfers', () => {
    it('moves stock and value between branches with a branch-level journal; blocks overdrafts and cross-entity moves', async () => {
      const t = (await http.post('/inventory/transfers').set(auth(mgr1.token)).send({ fromLocationId: fx.b1.locationId, toLocationId: fx.b2.locationId, lines: [{ productId: fx.milk.id, qty: 1, unit: 'carton' }] }).expect(201)).body;
      expect(t.lines[0]).toMatchObject({ qtyBase: '12', value: '18' });
      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBe(34);
      expect(await stock(fx.milk.id, fx.b2.locationId)).toMatchObject({ qtyBase: '12', value: '18' });

      const j = await get(`/finance/journals/${t.journalId}`);
      const byBranch = j.lines.map((l: any) => [l.branchId === fx.b2.branchId ? 'to' : 'from', l.debit, l.credit]).sort();
      expect(byBranch).toEqual([['from', '0', '18'], ['to', '18', '0']]);
      expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
      await glInventoryOk();

      await http.post('/inventory/transfers').set(auth(mgr1.token)).send({ fromLocationId: fx.b1.locationId, toLocationId: fx.b2.locationId, lines: [{ productId: fx.milk.id, qty: 999 }] }).expect(400);
      await http.post('/inventory/transfers').set(auth(mgr2.token)).send({ fromLocationId: fx.b1.locationId, toLocationId: fx.b2.locationId, lines: [{ productId: fx.milk.id, qty: 1 }] }).expect(403); // not their branch

      const le2 = (await http.post('/org/legal-entities').set(auth(T.token)).send({ name: 'Second Co' }).expect(201)).body;
      const b3 = (await http.post('/org/branches').set(auth(T.token)).send({ legalEntityId: le2.id, code: 'X1', name: 'X1' }).expect(201)).body;
      const l3 = (await http.post('/org/stock-locations').set(auth(T.token)).send({ branchId: b3.id, code: 'X1-MAIN', name: 'X1' }).expect(201)).body;
      await http.post('/inventory/transfers').set(auth(T.token)).send({ fromLocationId: fx.b1.locationId, toLocationId: l3.id, lines: [{ productId: fx.milk.id, qty: 1 }] }).expect(400);
    });
  });

  describe('replenishment', () => {
    it('suggests an order up to par, auto-issues a PO within policy, and does not re-order what is already on order', async () => {
      // 34 l on hand at branch 1; reorder at 40, order up to 120
      await http.post('/replenishment/rules').set(auth(proc.token)).send({ productId: fx.milk.id, locationId: fx.b1.locationId, minQtyBase: 40, maxQtyBase: 120, leadTimeDays: 2 }).expect(201);
      const dry = (await http.post('/replenishment/run?dryRun=true').set(auth(proc.token)).expect(201)).body;
      expect(dry.suggestions).toHaveLength(1);
      expect(dry.suggestions[0]).toMatchObject({ onHandBase: '34', suggestedBase: '86', orderUnit: 'carton', orderQty: '8', supplierId: fx.supplier.id, problem: null }); // 86 l -> 8 whole cartons
      expect(dry.requests).toEqual([]);
      expect(await get('/purchase-requests')).toHaveLength(0);

      const run = (await http.post('/replenishment/run').set(auth(proc.token)).expect(201)).body;
      const pr = run.requests[0];
      expect(pr.request.status).toBe('CONVERTED'); // 8 x 18 = 144 JOD: within the auto-approve limit
      expect(pr.request.source).toBe('REPLENISHMENT');
      expect(pr.orders[0]).toMatchObject({ status: 'ISSUED', subtotal: '144' });

      const again = (await http.post('/replenishment/run').set(auth(proc.token)).expect(201)).body;
      expect(again.suggestions).toEqual([]);
      expect(await get('/purchase-orders')).toHaveLength(2); // the opening PO plus this one

      // receiving the order brings stock to par and nothing further is suggested
      const po = await get(`/purchase-orders/${pr.orders[0].id}`);
      const fixture = { confidence: 0.98, qr: 'QR-REPL-1', fields: { invoiceNumber: 'INV-REPL-1', invoiceDate: new Date().toISOString().slice(0, 10), supplierTaxNumber: 'JO-111', subtotal: 144, taxTotal: 23.04, total: 167.04, qrUuid: 'QR-REPL-1' }, lines: [{ supplierSku: 'D-MILK', qty: 8, unit: 'carton', unitPrice: 18, taxRate: 0.16 }] };
      const doc = (await http.post('/documents').set(auth(proc.token)).attach('file', Buffer.from(JSON.stringify(fixture)), { filename: 'i.json', contentType: 'application/json' }).expect(201)).body.id;
      const rec = await http.post('/receiving').set(auth(proc.token)).send({ idempotencyKey: 'repl-receipt-1', purchaseOrderId: po.id, branchId: fx.b1.branchId, stockLocationId: fx.b1.locationId, evidenceDocumentId: doc, receivedLines: [{ poLineId: po.lines[0].id, qty: 8 }] }).expect(201);
      expect(rec.body.outcome).toBe('POSTED');
      expect(Number((await stock(fx.milk.id, fx.b1.locationId)).qtyBase)).toBe(130);
      expect((await http.post('/replenishment/run').set(auth(proc.token)).expect(201)).body.suggestions).toEqual([]);
      await glInventoryOk();
    });

    it('large suggested orders need an approver instead of auto-issuing', async () => {
      await http.post('/replenishment/rules').set(auth(proc.token)).send({ productId: fx.milk.id, locationId: fx.b2.locationId, minQtyBase: 200, maxQtyBase: 600 }).expect(201); // b2 holds 12 l
      const run = (await http.post('/replenishment/run').set(auth(proc.token)).expect(201)).body;
      const pr = run.requests.find((r: any) => r.status === 'PENDING_APPROVAL');
      expect(pr).toBeDefined(); // 49 cartons ~ 882 JOD: over the 200 auto limit
      const approval = (await get('/approvals', mgr2.token)).find((a: any) => a.subjectId === pr.id);
      expect(approval).toMatchObject({ action: 'purchase_request.approve', approverRole: 'BRANCH_MANAGER', branchId: fx.b2.branchId });
      expect((await get('/approvals', mgr1.token)).map((a: any) => a.id)).not.toContain(approval.id); // branch 1's manager cannot see branch 2's request
      await http.post(`/approvals/${approval.id}/decide`).set(auth(mgr1.token)).send({ approve: true }).expect(403);
    });

    it('a product with no supplier raises one exception, not one per run', async () => {
      await http.post('/replenishment/rules').set(auth(proc.token)).send({ productId: fx.flour.id, locationId: fx.b1.locationId, minQtyBase: 10, maxQtyBase: 50 }).expect(201);
      await http.post('/replenishment/run').set(auth(proc.token)).expect(201);
      await http.post('/replenishment/run').set(auth(proc.token)).expect(201);
      const ex = (await get('/exceptions?open=true', proc.token)).filter((e: any) => e.code === 'REPL_NO_SUPPLIER');
      expect(ex).toHaveLength(1);
      expect(ex[0].ownerRole).toBe('PROCUREMENT');
    });
  });

  it('reports stock losses from wastage and count shrinkage', async () => {
    const r = await get('/inventory/reports/losses');
    const byType = Object.fromEntries(r.items.map((i: any) => [i.type, i.value]));
    expect(byType).toEqual({ WASTAGE: '-21', COUNT_ADJUSTMENT: expect.any(String) });
    expect(Number(r.totalLossValue)).toBeGreaterThan(21);
  });

  it('default policy sync is idempotent', async () => {
    const count = () => runWithTenant(T.tenantId, () => prisma.db.policy.count());
    const before = await count();
    await runWithTenant(T.tenantId, () => seedPolicyDefaults(prisma.db, T.tenantId));
    await runWithTenant(T.tenantId, () => seedPolicyDefaults(prisma.db, T.tenantId));
    expect(await count()).toBe(before);
  });

  it('keeps balances, movements and ledger consistent', async () => {
    expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
    await glInventoryOk();
    expect((await get('/finance/trial-balance')).balanced).toBe(true);
  });
});
