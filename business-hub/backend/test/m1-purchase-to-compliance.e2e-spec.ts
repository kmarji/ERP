import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant, today } from './helpers';

describe('M1 Purchase-to-Compliance (AT-01, AT-02)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string;
  let locationId: string;
  let milk: any;
  let flour: any;
  let supplier: any;
  let proc1: { id: string; token: string };
  let proc2: { id: string; token: string };
  let fin1: { id: string; token: string };
  let fin2: { id: string; token: string };
  let manager: { id: string; token: string };

  const get = async (path: string, token = T.token) => (await http.get(path).set(auth(token)).expect(200)).body;

  async function upload(fixture: object) {
    const r = await http.post('/documents').set(auth(T.token)).attach('file', Buffer.from(JSON.stringify(fixture)), { filename: 'inv.json', contentType: 'application/json' }).expect(201);
    return r.body.id as string;
  }

  // A PO of `cartons` milk at 18 JOD per carton (agreed price), issued automatically when small.
  async function milkPo(cartons: number, token = proc1.token) {
    const r = await http.post('/purchase-orders').set(auth(token)).send({ supplierId: supplier.id, branchId, stockLocationId: locationId, lines: [{ productId: milk.id, qty: cartons, unit: 'carton' }] }).expect(201);
    return r.body;
  }

  const invoiceFixture = (over: { number: string; cartons: number; price?: number; qr?: string; taxTotal?: number; taxNumber?: string; confidence?: number }) => {
    const price = over.price ?? 18;
    const net = +(over.cartons * price).toFixed(3);
    const tax = over.taxTotal ?? +(net * 0.16).toFixed(3);
    return {
      confidence: over.confidence ?? 0.97,
      qr: over.qr ?? `QR-${over.number}`,
      fields: { invoiceNumber: over.number, invoiceDate: today(), supplierTaxNumber: over.taxNumber ?? 'JO-111', subtotal: net, taxTotal: tax, total: +(net + tax).toFixed(3), qrUuid: over.qr ?? `QR-${over.number}` },
      lines: [{ supplierSku: 'D-MILK', qty: over.cartons, unit: 'carton', unitPrice: price, taxRate: 0.16 }],
    };
  };

  async function receive(po: any, fixture: object, qty: number, token = proc1.token, key = randomUUID()) {
    const doc = await upload(fixture);
    const res = await http.post('/receiving').set(auth(token)).send({ idempotencyKey: key, purchaseOrderId: po.id, branchId, stockLocationId: locationId, evidenceDocumentId: doc, receivedLines: [{ poLineId: po.lines[0].id, qty }] }).expect(201);
    return { ...res.body, key, doc };
  }

  const stockOf = async (productId: string) => {
    const rows = await get(`/inventory/stock?productId=${productId}&locationId=${locationId}`);
    return rows[0] ?? { qtyBase: '0', value: '0' };
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm1');
    const le = (await get('/org/legal-entities'))[0];
    branchId = (await http.post('/org/branches').set(auth(T.token)).send({ legalEntityId: le.id, code: 'B1', name: 'Branch 1' }).expect(201)).body.id;
    locationId = (await http.post('/org/stock-locations').set(auth(T.token)).send({ branchId, code: 'B1-MAIN', name: 'Main store' }).expect(201)).body.id;
    const s16 = (await get('/tax-codes')).find((t: any) => t.code === 'S16');
    milk = (await http.post('/products').set(auth(T.token)).send({ sku: 'MILK', name: 'Milk', baseUnit: 'l', taxCodeId: s16.id }).expect(201)).body;
    await http.post(`/products/${milk.id}/conversions`).set(auth(T.token)).send({ unit: 'carton', factorToBase: 12 }).expect(201);
    flour = (await http.post('/products').set(auth(T.token)).send({ sku: 'FLOUR', name: 'Flour', baseUnit: 'kg', taxCodeId: s16.id }).expect(201)).body;
    await http.post(`/products/${flour.id}/conversions`).set(auth(T.token)).send({ unit: 'bag', factorToBase: 25 }).expect(201);
    supplier = (await http.post('/suppliers').set(auth(T.token)).send({ name: 'Dairy Co', taxNumber: 'JO-111', paymentTermsDays: 30 }).expect(201)).body;
    await http.post(`/suppliers/${supplier.id}/items`).set(auth(T.token)).send({ productId: milk.id, supplierSku: 'D-MILK', unit: 'carton', agreedPrice: 18, preferred: true }).expect(201);
    proc1 = await makeUser(http, T, 'proc1', 'PROCUREMENT');
    proc2 = await makeUser(http, T, 'proc2', 'PROCUREMENT');
    fin1 = await makeUser(http, T, 'fin1', 'FINANCE');
    fin2 = await makeUser(http, T, 'fin2', 'FINANCE');
    manager = await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', branchId);
  });

  afterAll(() => app.close());

  it('AT-01: a matched invoice scanned once posts stock, AP, tax and linked evidence, with no second entry', async () => {
    const po = await milkPo(10);
    expect(po).toMatchObject({ status: 'ISSUED', subtotal: '180', taxTotal: '28.8', total: '208.8' });

    const r = await receive(po, invoiceFixture({ number: 'INV-1001', cartons: 10 }), 10);
    expect(r).toMatchObject({ outcome: 'POSTED', replay: false, workflowState: 'POSTED', findings: [] });

    // stock in base units at weighted-average cost: 120 l for 180.000
    const st = await stockOf(milk.id);
    expect(Number(st.qtyBase)).toBe(120);
    expect(Number(st.value)).toBe(180);
    expect(Number(st.avgCost)).toBeCloseTo(1.5);

    const trace = await get(`/receiving/${r.receipt.id}/trace`);
    const lines = Object.fromEntries(trace.journal.lines.map((l: any) => [l.account.systemKey, [l.debit, l.credit]]));
    expect(lines).toEqual({ INVENTORY: ['180', '0'], INPUT_TAX: ['28.8', '0'], AP: ['0', '208.8'] });
    expect(trace.payable).toMatchObject({ amountDue: '208.8', status: 'OPEN' });
    expect(trace.taxEntries).toHaveLength(1);
    expect(trace.taxEntries[0]).toMatchObject({ direction: 'INPUT', base: '180', taxAmount: '28.8', eligible: true });
    expect(trace.document.id).toBe(r.doc);
    expect(trace.document.subjectId).toBe(r.invoice.id);
    expect(trace.movements).toHaveLength(1);
    expect(trace.purchaseOrder.status).toBe('RECEIVED');
    expect(Number(trace.invoice.extractionConfidence)).toBeCloseTo(0.97);

    // retry with the same key: no duplicate stock or journal (AT-03 pattern)
    const doc2 = await upload(invoiceFixture({ number: 'INV-1001', cartons: 10 }));
    const again = await http.post('/receiving').set(auth(proc1.token)).send({ idempotencyKey: r.key, purchaseOrderId: po.id, branchId, stockLocationId: locationId, evidenceDocumentId: doc2, receivedLines: [{ poLineId: po.lines[0].id, qty: 10 }] }).expect(201);
    expect(again.body.replay).toBe(true);
    expect(again.body.receipt.id).toBe(r.receipt.id);
    expect(Number((await stockOf(milk.id)).qtyBase)).toBe(120);
    expect((await get(`/finance/journals?sourceType=GoodsReceipt&sourceId=${r.receipt.id}`))).toHaveLength(1);

    // stock to ledger reconciliation (Phase 2 exit criterion)
    expect(await get('/finance/reconciliation/inventory')).toMatchObject({ stockValue: '180', ledgerBalance: '180', reconciled: true });
    expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
    expect((await get('/finance/trial-balance')).balanced).toBe(true);
    expect(await get('/tax/input-summary')).toMatchObject({ recoverableInputTax: '28.8', nonRecoverableInputTax: '0' });
  });

  it('AT-02: a price increase is not auto-posted; the right role gets a clear exception; a second person approves', async () => {
    const before = await stockOf(milk.id);
    const po = await milkPo(10);
    const r = await receive(po, invoiceFixture({ number: 'INV-1002', cartons: 10, price: 20 }), 10, proc1.token);

    expect(r.outcome).toBe('EXCEPTION');
    expect(r.workflowState).toBe('EXCEPTION');
    expect(r.findings.map((f: any) => f.code)).toEqual(['PRICE_VARIANCE']);
    expect(Number((await stockOf(milk.id)).qtyBase)).toBe(Number(before.qtyBase)); // nothing posted
    expect((await get(`/purchase-orders/${po.id}`)).status).toBe('ISSUED');

    const ex = r.exceptions[0];
    expect(ex).toMatchObject({ code: 'PUR_PRICE_VARIANCE', ownerRole: 'PROCUREMENT', status: 'NOTIFIED', ownerEscalated: false });
    expect(ex.evidence.findings[0].details).toMatchObject({ poPrice: '1.5', invoicePrice: '1.666667' });
    const visible = await get('/exceptions?open=true', proc2.token);
    expect(visible.map((e: any) => e.id)).toContain(ex.id);
    const owner = await get('/dashboard/owner');
    expect(owner.decisions.map((d: any) => d.id)).not.toContain(ex.id); // owner is not interrupted

    const approval = (await get('/approvals', proc2.token)).find((a: any) => a.subjectId === r.receipt.id);
    expect(approval).toMatchObject({ action: 'receiving.post_with_variance', approverRole: 'PROCUREMENT' });
    await http.post(`/approvals/${approval.id}/decide`).set(auth(proc1.token)).send({ approve: true }).expect(403); // requester
    await http.post(`/approvals/${approval.id}/decide`).set(auth(proc2.token)).send({ approve: true, comment: 'Supplier price rise agreed' }).expect(201);

    const done = await get(`/receiving/${r.receipt.id}`);
    expect(done).toMatchObject({ outcome: 'POSTED', workflowState: 'POSTED' });
    expect(done.exceptions[0].status).toBe('VERIFIED');
    // posted at the invoice price (20/carton = 240 for 10)
    expect(Number((await stockOf(milk.id)).value) - Number(before.value)).toBeCloseTo(200);
    expect(await get('/finance/reconciliation/inventory')).toMatchObject({ reconciled: true });
  });

  it('a short delivery is blocked for the branch manager; finance can accept it and the shortfall hits price variance', async () => {
    const before = await stockOf(milk.id);
    const po = await milkPo(10);
    const r = await receive(po, invoiceFixture({ number: 'INV-1003', cartons: 10 }), 8);
    expect(r.outcome).toBe('EXCEPTION');
    expect(r.findings.map((f: any) => f.code)).toEqual(['QTY_MISMATCH']);
    expect(r.exceptions[0]).toMatchObject({ ownerRole: 'BRANCH_MANAGER', branchId });
    expect((await get('/exceptions?open=true', manager.token)).map((e: any) => e.id)).toContain(r.exceptions[0].id);
    await http.post(`/receiving/${r.receipt.id}/override-post`).set(auth(proc1.token)).send({ reason: 'accept' }).expect(403);

    const o = await http.post(`/receiving/${r.receipt.id}/override-post`).set(auth(fin1.token)).send({ reason: 'Short delivery credited by supplier' }).expect(201);
    expect(o.body.outcome).toBe('POSTED');
    expect(Number((await stockOf(milk.id)).qtyBase) - Number(before.qtyBase)).toBe(96); // 8 cartons x 12 l, not 10
    const trace = await get(`/receiving/${r.receipt.id}/trace`);
    const jl = Object.fromEntries(trace.journal.lines.map((l: any) => [l.account.systemKey, [l.debit, l.credit]]));
    expect(jl).toEqual({ INVENTORY: ['144', '0'], INPUT_TAX: ['28.8', '0'], PURCHASE_VARIANCE: ['36', '0'], AP: ['0', '208.8'] });
    expect(o.body.exceptions[0].status).toBe('VERIFIED');
    expect(await get('/finance/reconciliation/inventory')).toMatchObject({ reconciled: true });
  });

  it('a duplicate invoice is blocked for finance and can be rejected, releasing the invoice number', async () => {
    const before = await stockOf(milk.id);
    const po = await milkPo(10);
    const dup = await receive(po, invoiceFixture({ number: 'inv-1001', cartons: 10 }), 10); // same supplier + number, different case
    expect(dup.outcome).toBe('EXCEPTION');
    expect(dup.findings[0]).toMatchObject({ code: 'DUPLICATE_INVOICE', ownerRole: 'FINANCE' });
    expect(dup.exceptions[0]).toMatchObject({ code: 'PUR_DUPLICATE_INVOICE', ownerRole: 'FINANCE', riskTier: 'HIGH' });
    expect(Number((await stockOf(milk.id)).qtyBase)).toBe(Number(before.qtyBase));

    const rej = await http.post(`/receiving/${dup.receipt.id}/reject`).set(auth(fin1.token)).send({ reason: 'Already booked as INV-1001' }).expect(201);
    expect(rej.body).toMatchObject({ outcome: 'REJECTED', workflowState: 'REJECTED' });
    expect(rej.body.exceptions[0].status).toBe('ARCHIVED');

    // A legitimately different invoice that reuses a rejected number is accepted afterwards.
    const ok = await receive(po, invoiceFixture({ number: 'INV-2001', cartons: 10, qr: 'QR-FRESH' }), 10);
    expect(ok.outcome).toBe('POSTED');
  });

  it('wrong tax and unmapped items are hard exceptions routed to the right owner', async () => {
    const po = await milkPo(5);
    const tax = await receive(po, invoiceFixture({ number: 'INV-3001', cartons: 5, taxTotal: 5 }), 5);
    expect(tax.findings.map((f: any) => f.code)).toContain('TAX_DISCREPANCY');
    expect(tax.exceptions[0]).toMatchObject({ ownerRole: 'FINANCE', riskTier: 'HIGH' });
    await http.post(`/receiving/${tax.receipt.id}/reject`).set(auth(fin1.token)).send({ reason: 'ask supplier for corrected invoice' }).expect(201);

    const fx: any = invoiceFixture({ number: 'INV-3002', cartons: 5 });
    fx.lines[0].supplierSku = 'UNKNOWN-SKU';
    const un = await receive(po, fx, 5);
    expect(un.findings.map((f: any) => f.code)).toContain('UNMAPPED_ITEM');
    expect(un.exceptions[0].ownerRole).toBe('PROCUREMENT');
    await http.post(`/receiving/${un.receipt.id}/reject`).set(auth(proc1.token)).send({ reason: 'map the SKU first' }).expect(201);
  });

  it('unit conversions: invoice in cartons, receipt in litres', async () => {
    const po = await milkPo(2);
    const doc = await upload(invoiceFixture({ number: 'INV-4001', cartons: 2 }));
    const res = await http.post('/receiving').set(auth(proc1.token)).send({ idempotencyKey: randomUUID(), purchaseOrderId: po.id, branchId, stockLocationId: locationId, evidenceDocumentId: doc, receivedLines: [{ poLineId: po.lines[0].id, qty: 24, unit: 'l' }] }).expect(201);
    expect(res.body.outcome).toBe('POSTED');
    expect(res.body.receipt.lines[0]).toMatchObject({ qtyBase: '24', qtyReceived: '24', unit: 'l' });
  });

  it('partial receipts: PO stays open until fully received, and over-delivery is flagged', async () => {
    const po = await milkPo(10);
    const first = await receive(po, invoiceFixture({ number: 'INV-5001', cartons: 4 }), 4);
    expect(first.outcome).toBe('POSTED');
    expect((await get(`/purchase-orders/${po.id}`)).status).toBe('PARTIALLY_RECEIVED');
    const fresh = await get(`/purchase-orders/${po.id}`);
    const second = await receive(fresh, invoiceFixture({ number: 'INV-5002', cartons: 8 }), 8); // only 6 remain
    expect(second.findings.map((f: any) => f.code)).toEqual(['OVER_DELIVERY']);
    expect(second.outcome).toBe('EXCEPTION');
    await http.post(`/receiving/${second.receipt.id}/reject`).set(auth(proc1.token)).send({ reason: 'send back the extra 2 cartons' }).expect(201);
    const third = await receive(fresh, invoiceFixture({ number: 'INV-5003', cartons: 6 }), 6);
    expect(third.outcome).toBe('POSTED');
    expect((await get(`/purchase-orders/${po.id}`)).status).toBe('RECEIVED');
  });

  it('low OCR confidence blocks straight-through posting', async () => {
    const po = await milkPo(3);
    const r = await receive(po, invoiceFixture({ number: 'INV-6001', cartons: 3, confidence: 0.5 }), 3);
    expect(r.outcome).toBe('EXCEPTION');
    expect(r.exceptions[0]).toMatchObject({ code: 'PUR_POLICY_REVIEW', ownerRole: 'PROCUREMENT' });
    expect(r.exceptions[0].reason).toContain('confidence below minimum');
    await http.post(`/receiving/${r.receipt.id}/reject`).set(auth(proc1.token)).send({ reason: 'rescan' }).expect(201);
  });

  it('locked financial periods block posting; after unlock finance can post', async () => {
    const lock = await http.post('/finance/periods/lock').set(auth(fin1.token)).send({ startDate: `${today().slice(0, 8)}01`, endDate: `${today().slice(0, 4)}-12-31` }).expect(201);
    const po = await milkPo(2);
    const r = await receive(po, invoiceFixture({ number: 'INV-7001', cartons: 2 }), 2);
    expect(r.outcome).toBe('EXCEPTION');
    expect(r.exceptions[0]).toMatchObject({ code: 'PUR_PERIOD_LOCKED', ownerRole: 'FINANCE' });
    expect((await get(`/receiving/${r.receipt.id}`)).receipt.postingStatus).toBe('FAILED');
    await http.post(`/receiving/${r.receipt.id}/override-post`).set(auth(fin1.token)).send({ reason: 'retry' }).expect(201); // still locked: raises again
    expect((await get(`/receiving/${r.receipt.id}`)).outcome).toBe('EXCEPTION');

    await http.post(`/finance/periods/${lock.body.id}/unlock`).set(auth(fin1.token)).expect(400); // only the owner can unlock
    await http.post(`/finance/periods/${lock.body.id}/unlock`).set(auth(T.token)).expect(201);
    const posted = await http.post(`/receiving/${r.receipt.id}/override-post`).set(auth(fin1.token)).send({ reason: 'period reopened' }).expect(201);
    expect(posted.body.outcome).toBe('POSTED');
  });

  it('payment: explicit approval by a second person, confirmation posts AP against bank, workflow archives', async () => {
    const payable = (await get('/payables?status=OPEN'))[0];
    const apBefore = (await get('/finance/trial-balance')).rows.find((r: any) => r.code === '2000');
    await http.post(`/payables/${payable.id}/confirm-payment`).set(auth(fin1.token)).send({ reference: 'TRX-1', method: 'BANK' }).expect(409); // not approved yet

    await http.post(`/payables/${payable.id}/request-payment`).set(auth(fin1.token)).expect(201);
    const approval = (await get('/approvals', fin2.token)).find((a: any) => a.subjectId === payable.id);
    expect(approval).toMatchObject({ action: 'payable.release_payment', approverRole: 'FINANCE' });
    await http.post(`/approvals/${approval.id}/decide`).set(auth(fin1.token)).send({ approve: true }).expect(403);
    await http.post(`/approvals/${approval.id}/decide`).set(auth(fin2.token)).send({ approve: true }).expect(201);
    expect((await get(`/payables/${payable.id}`)).status).toBe('PAYMENT_APPROVED');

    const paid = await http.post(`/payables/${payable.id}/confirm-payment`).set(auth(fin2.token)).send({ reference: 'TRX-1', method: 'BANK' }).expect(201);
    expect(paid.body).toMatchObject({ status: 'PAID', paymentReference: 'TRX-1' });
    const wf = await prisma.raw.workflowInstance.findFirstOrThrow({ where: { tenantId: T.tenantId, subjectId: payable.invoiceId } });
    expect(wf).toMatchObject({ state: 'ARCHIVED', closed: true });
    const apAfter = (await get('/finance/trial-balance')).rows.find((r: any) => r.code === '2000');
    expect(Number(apAfter.debit) - Number(apBefore.debit)).toBeCloseTo(Number(payable.amountDue));
    expect((await get('/finance/trial-balance')).balanced).toBe(true);
  });

  it('PR to PO: small requests auto-approve and auto-issue; larger ones need an approver; PO limits apply', async () => {
    const mk = (cartons: number, token: string) =>
      http.post('/purchase-requests').set(auth(token)).send({ branchId, stockLocationId: locationId, lines: [{ productId: milk.id, qty: cartons, unit: 'carton' }] }).expect(201);

    const small = (await mk(5, proc1.token)).body; // 90 JOD, within the 200 auto limit
    const sent = await http.post(`/purchase-requests/${small.id}/submit`).set(auth(proc1.token)).expect(201);
    expect(sent.body.request.status).toBe('CONVERTED');
    expect(sent.body.orders[0]).toMatchObject({ status: 'ISSUED', purchaseRequestId: small.id });

    const big = (await mk(20, proc1.token)).body; // 360 JOD: needs a delegated approver
    const pending = await http.post(`/purchase-requests/${big.id}/submit`).set(auth(proc1.token)).expect(201);
    expect(pending.body.status).toBe('PENDING_APPROVAL');
    const appr = (await get('/approvals', proc2.token)).find((a: any) => a.subjectId === big.id);
    expect(appr.approverRole).toBe('PROCUREMENT');
    await http.post(`/approvals/${appr.id}/decide`).set(auth(proc2.token)).send({ approve: true }).expect(201);
    const converted = await get(`/purchase-requests/${big.id}`);
    expect(converted.status).toBe('CONVERTED');
    expect(converted.purchaseOrders[0].status).toBe('ISSUED');

    // direct PO above the auto-issue limit waits for approval and cannot be received yet
    const po = await milkPo(40); // 720 net
    expect(po.status).toBe('PENDING_APPROVAL');
    const doc = await upload(invoiceFixture({ number: 'INV-8001', cartons: 40 }));
    await http.post('/receiving').set(auth(proc1.token)).send({ idempotencyKey: randomUUID(), purchaseOrderId: po.id, branchId, stockLocationId: locationId, evidenceDocumentId: doc, receivedLines: [{ poLineId: po.lines[0].id, qty: 40 }] }).expect(409);
    const poAppr = (await get('/approvals', proc2.token)).find((a: any) => a.subjectId === po.id);
    await http.post(`/approvals/${poAppr.id}/decide`).set(auth(proc2.token)).send({ approve: true }).expect(201);
    expect((await get(`/purchase-orders/${po.id}`)).status).toBe('ISSUED');
  });

  it('ledger is append-only (app layer and database trigger), and corrections are reversals', async () => {
    const j = (await get('/finance/journals?take=1'))[0];
    await expect(prisma.db.journal.update({ where: { id: j.id }, data: { memo: 'tampered' } } as any)).rejects.toThrow(/append-only/);
    await expect(prisma.raw.$executeRaw`UPDATE "JournalLine" SET debit = 1 WHERE "journalId" = ${j.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.raw.$executeRaw`DELETE FROM "AuditEvent" WHERE "tenantId" = ${T.tenantId}`).rejects.toThrow(/append-only/);
    await expect(prisma.raw.$executeRaw`UPDATE "StockMovement" SET "qtyBase" = 0 WHERE "tenantId" = ${T.tenantId}`).rejects.toThrow(/append-only/);

    const rev = await http.post(`/finance/journals/${j.id}/reverse`).set(auth(fin1.token)).send({ reason: 'posted in error' }).expect(201);
    expect(rev.body.reversalOfId).toBe(j.id);
    const orig = j.lines.find((l: any) => Number(l.debit) > 0);
    const back = rev.body.lines.find((l: any) => l.accountId === orig.accountId);
    expect(back.credit).toBe(orig.debit);
    await http.post(`/finance/journals/${j.id}/reverse`).set(auth(fin1.token)).send({ reason: 'again' }).expect(409);
    await http.post(`/finance/journals/${rev.body.id}/reverse`).set(auth(fin1.token)).send({ reason: 'again' }).expect(409);
    expect((await get('/finance/trial-balance')).balanced).toBe(true);
  });

  it('manual journals must balance', async () => {
    const le = (await get('/org/legal-entities'))[0];
    const bad = await http.post('/finance/journals').set(auth(fin1.token)).send({ postingDate: today(), memo: 'x', idempotencyKey: 'manual-1', legalEntityId: le.id, lines: [{ account: 'CASH', debit: 10 }, { account: 'EQUITY', credit: 9 }] }).expect(400);
    expect(bad.body.code).toBe('UNBALANCED');
    await http.post('/finance/journals').set(auth(fin1.token)).send({ postingDate: today(), memo: 'x', idempotencyKey: 'manual-2', legalEntityId: le.id, lines: [{ account: 'CASH', debit: 10 }, { account: 'NOPE', credit: 10 }] }).expect(400);
  });

  it('keeps stock, ledger and balances consistent at the end', async () => {
    expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
    const inv = await get('/finance/reconciliation/inventory');
    expect(inv.stockValue).toBe(inv.ledgerBalance);
  });
});
