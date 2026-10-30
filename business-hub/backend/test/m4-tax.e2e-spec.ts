import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { TaxReturnsService } from '../src/modules/tax/tax-returns.service';
import { Http, auth, createApp, makeUser, today } from './helpers';
import { PosWorld, posHelpers, setupPos } from './pos-fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(200);
  }
}

describe('M4 Transaction-to-Tax-Filing (WF-07, AT-10)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const monthStart = `${today().slice(0, 8)}01`;
  const yearEnd = `${today().slice(0, 4)}-12-31`;

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
  });
  afterAll(() => app.close());

  describe('findings stop a bad return, and the review route is enforced', () => {
    let w: PosWorld;
    let h: ReturnType<typeof posHelpers>;
    let periodId: string;

    beforeAll(async () => {
      w = await setupPos(http, 'm4a');
      h = posHelpers(http, w);
    });

    it('flags a sale that never reached the ledger and refuses to send the return to review', async () => {
      await h.sellCash([h.lineCake(2)]);
      const lock = (await h.post('/finance/periods/lock', w.fin.token, { startDate: monthStart, endDate: yearEnd }).expect(201)).body;
      const failed = await h.sellCash([h.lineCake(1)]);
      expect(failed.postingStatus).toBe('FAILED');

      periodId = (await h.post('/tax/periods', w.fin.token, { legalEntityId: w.fx.le.id, startDate: monthStart, endDate: yearEnd, label: 'Test period' }).expect(201)).body.id;
      await h.post('/tax/periods', w.fin.token, { legalEntityId: w.fx.le.id, startDate: monthStart, endDate: yearEnd }).expect(409); // overlap
      const v1 = (await h.post(`/tax/periods/${periodId}/generate`, w.fin.token).expect(201)).body;
      expect(v1).toMatchObject({ version: 1, status: 'DRAFT', workflowState: 'DRAFT' });
      expect(v1.findings.map((f: any) => f.code)).toEqual(['UNPOSTED_DOCUMENTS']);
      const ex = (await h.get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'TAX_RETURN_FINDINGS');
      expect(ex).toMatchObject({ ownerRole: 'FINANCE' });

      await h.post(`/tax/returns/${v1.id}/submit-review`, w.fin.token).expect(409);
      await h.post(`/tax/returns/${v1.id}/acknowledge`, w.fin.token, { code: 'UNPOSTED_DOCUMENTS', reason: 'x' }).expect(400); // reason too short
      await h.post(`/tax/returns/${v1.id}/acknowledge`, w.fin.token, { code: 'NOPE', reason: 'not a real finding' }).expect(404);
      await h.post(`/tax/returns/${v1.id}/acknowledge`, w.T.token, { code: 'UNPOSTED_DOCUMENTS', reason: 'owner is not a finance reviewer' }).expect(403);
      await h.post(`/tax/returns/${v1.id}/acknowledge`, w.fin.token, { code: 'UNPOSTED_DOCUMENTS', reason: 'repost scheduled after period reopening' }).expect(201);
      const inReview = (await h.post(`/tax/returns/${v1.id}/submit-review`, w.fin.token).expect(201)).body;
      expect(inReview.status).toBe('IN_REVIEW');
      expect((await h.get('/exceptions', w.fin.token)).find((e: any) => e.code === 'TAX_RETURN_FINDINGS').status).toBe('VERIFIED');
      await h.post(`/tax/periods/${periodId}/generate`, w.fin.token).expect(409); // already in review

      // the reviewer sends it back; data is fixed; regenerating supersedes v1
      const fin2 = await makeUser(http, w.T, 'fin2', 'FINANCE');
      expect((await h.post(`/tax/returns/${v1.id}/review`, fin2.token, { approve: false, comment: 'fix the unposted sale first' }).expect(201)).body.status).toBe('DRAFT');
      await h.post(`/finance/periods/${lock.id}/unlock`, w.T.token).expect(201);
      await h.post(`/pos/orders/${failed.id}/repost`, w.fin.token).expect(201);
      const v2 = (await h.post(`/tax/periods/${periodId}/generate`, w.fin.token).expect(201)).body;
      expect(v2).toMatchObject({ version: 2, findings: [] });
      expect((await h.get(`/tax/returns/${v1.id}`, w.fin.token)).status).toBe('CANCELLED');
      expect((await h.get(`/tax/returns/${v1.id}`, w.fin.token)).workflowState).toBe('CANCELLED');
    });

    it('overdue periods raise one escalating exception, not a pile of them', async () => {
      const past = (await h.post('/tax/periods', w.fin.token, { legalEntityId: w.fx.le.id, startDate: '2025-01-01', endDate: '2025-01-31', dueDate: '2025-02-28' }).expect(201)).body;
      const svc = app.get(TaxReturnsService);
      expect(await runWithTenant(w.T.tenantId, () => svc.flagOverdue())).toBe(1);
      expect(await runWithTenant(w.T.tenantId, () => svc.flagOverdue())).toBe(0);
      const ex = (await h.get('/exceptions?open=true', w.fin.token)).find((e: any) => e.code === 'TAX_FILING_OVERDUE');
      expect(ex).toMatchObject({ ownerRole: 'FINANCE', riskTier: 'HIGH' });
      expect(ex.evidence.periodId).toBe(past.id);
    });
  });

  describe('AT-10: the return reconciles to the ledger and filing stays explicitly authorized', () => {
    let w: PosWorld;
    let h: ReturnType<typeof posHelpers>;
    let fin2: { id: string; token: string };
    let ret: any;
    let orders: any[];
    let refund: any;

    beforeAll(async () => {
      w = await setupPos(http, 'm4b');
      h = posHelpers(http, w);
      fin2 = await makeUser(http, w.T, 'fin2', 'FINANCE');
      orders = [await h.sellCash([h.lineLatte(2), h.lineCake(1)]), await h.sellCash([h.lineCake(3)]), await h.sellCash([h.lineLatte(1)]), await h.sellCash([h.lineCake(40)]), await h.sellCash([h.lineCake(40)])];
      refund = (await h.post(`/pos/orders/${orders[1].id}/refunds`, w.cashier.token, { idempotencyKey: h.key(), lines: [{ orderLineId: orders[1].lines[0].id, qty: 1 }], reason: 'cold' }).expect(201)).body;
      const p = (await h.post('/tax/periods', w.fin.token, { legalEntityId: w.fx.le.id, startDate: monthStart, endDate: today() }).expect(201)).body;
      ret = (await h.post(`/tax/periods/${p.id}/generate`, w.fin.token).expect(201)).body;
    });

    it('builds the draft from source documents and ties it to invoices and the ledger', async () => {
      expect(ret.findings).toEqual([]);
      const salesTax = orders.reduce((s, o) => s + Number(o.taxTotal), 0);
      expect(Number(ret.outputTax)).toBeCloseTo(salesTax - Number(refund.tax), 3);
      expect(Number(ret.outputBase)).toBeCloseTo(orders.reduce((s, o) => s + Number(o.total) - Number(o.taxTotal), 0) - Number(refund.net), 3);
      expect(ret.inputTaxRecoverable).toBe('28.8'); // the opening milk purchase
      expect(Number(ret.netPayable)).toBeCloseTo(Number(ret.outputTax) - 28.8, 3);
      expect(Number(ret.netPayable)).toBeGreaterThan(0); // a payable position

      // the same figure comes out of the general ledger
      const out = await h.tb('2100');
      expect(Number(out.credit) - Number(out.debit)).toBeCloseTo(Number(ret.outputTax), 3);
      const inp = await h.tb('1210');
      expect(Number(inp.debit) - Number(inp.credit)).toBeCloseTo(28.8, 3);

      expect(ret.lines.map((l: any) => [l.direction, l.taxRate, l.eligible, l.documents])).toEqual([['INPUT', '0.16', true, 1], ['OUTPUT', '0.16', true, 6]]); // 5 sales + 1 credit note
      const wp = ret.workingPapers;
      expect(wp.sales[0].invoices).toBe(5);
      expect(wp.creditNotes).toHaveLength(1);
      expect(wp.purchases[0]).toMatchObject({ eligible: true, supplierTaxNumber: 'JO-111' });
      const csv = (await http.get(`/tax/returns/${ret.id}/working-papers.csv`).set(auth(w.fin.token)).expect(200)).text;
      expect(csv).toContain('NET_PAYABLE');
      expect(csv.split('\n').filter((l) => l.startsWith('SALES')).length).toBe(1);
      expect(await h.get('/tax/output-summary', w.fin.token)).toMatchObject({ outputTax: ret.outputTax });
    });

    it('requires a different finance reviewer, then an explicit owner decision that locks the period', async () => {
      await h.post(`/tax/returns/${ret.id}/review`, w.fin.token, { approve: true }).expect(409); // not yet in review
      await h.post(`/tax/returns/${ret.id}/submit-review`, w.fin.token).expect(201);
      await h.post(`/tax/returns/${ret.id}/review`, w.fin.token, { approve: true }).expect(403); // preparer cannot review own work
      await h.post(`/tax/returns/${ret.id}/review`, w.T.token, { approve: true }).expect(403); // owner is not a finance reviewer
      const reviewed = (await h.post(`/tax/returns/${ret.id}/review`, fin2.token, { approve: true, comment: 'agrees to ledger' }).expect(201)).body;
      expect(reviewed).toMatchObject({ status: 'AWAITING_AUTHORIZATION', reviewedBy: fin2.id });

      // filing is regulated: nothing proceeds without the owner, and the owner sees it as a decision
      const approval = (await h.get('/approvals', w.T.token)).find((a: any) => a.action === 'tax.file_return');
      expect(approval).toMatchObject({ approverRole: 'OWNER', subjectId: ret.id });
      expect((await h.get('/dashboard/owner')).decisions.map((d: any) => d.id)).toContain(approval.id);
      await h.post(`/tax/returns/${ret.id}/package`, w.fin.token).expect(409);
      await h.post(`/approvals/${approval.id}/decide`, w.fin.token, { approve: true }).expect(403);
      await h.post(`/approvals/${approval.id}/decide`, w.T.token, { approve: true, comment: 'authorized' }).expect(201);

      const approved = await h.get(`/tax/returns/${ret.id}`, w.fin.token);
      expect(approved).toMatchObject({ status: 'APPROVED', workflowState: 'APPROVED', authorizedBy: w.T.ownerId });
      // closing the period: later sales in it cannot silently change what was filed
      const late = await h.sellCash([h.lineCake(1)]);
      expect(late.postingStatus).toBe('FAILED');
      expect((await h.get('/exceptions?open=true', w.fin.token)).some((e: any) => e.code === 'POS_POSTING_FAILED')).toBe(true);
    });

    it('prepares a guided package (official submission is not assumed) and tracks filing, payment and archive with evidence', async () => {
      const pkg = (await h.post(`/tax/returns/${ret.id}/package`, w.fin.token).expect(201)).body;
      expect(pkg.method).toBe('MANUAL');
      expect(pkg.why).toMatch(/manual/i);
      expect(pkg.documents).toHaveLength(2);
      expect(pkg.steps.join(' ')).toContain(`net ${ret.netPayable}`);

      await h.post(`/tax/returns/${ret.id}/record-payment`, w.fin.token, { reference: 'PAY-1' }).expect(409); // not filed yet
      await h.post(`/tax/returns/${ret.id}/record-filing`, w.fin.token, { acknowledgmentRef: 'x' }).expect(400);
      const filed = (await h.post(`/tax/returns/${ret.id}/record-filing`, w.fin.token, { acknowledgmentRef: 'ACK-2026-0001' }).expect(201)).body;
      expect(filed).toMatchObject({ status: 'FILED', acknowledgmentRef: 'ACK-2026-0001', workflowState: 'FILED' });

      await h.post(`/tax/returns/${ret.id}/record-payment`, w.fin.token, { method: 'BANK' }).expect(400); // tax is payable: a reference is required
      const paid = (await h.post(`/tax/returns/${ret.id}/record-payment`, w.fin.token, { reference: 'EFAW-998877', method: 'BANK', paidAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) }).expect(201)).body;
      expect(paid).toMatchObject({ status: 'PAID', paymentRef: 'EFAW-998877' });
      const j = (await h.journalsFor('TaxReturn', ret.id))[0];
      expect(h.byAccount(j)).toEqual({ OUTPUT_TAX: [ret.outputTax, '0'], INPUT_TAX: ['0', '28.8'], BANK: ['0', ret.netPayable] });
      expect((await h.tb('2100')).balance).toBe('0'); // output tax account is cleared for the period
      expect((await h.tb('1210')).balance).toBe('0');

      const archived = (await h.post(`/tax/returns/${ret.id}/archive`, w.fin.token).expect(201)).body;
      expect(archived).toMatchObject({ status: 'ARCHIVED', workflowState: 'ARCHIVED' });
      const wf = await prisma.raw.workflowInstance.findFirstOrThrow({ where: { tenantId: w.T.tenantId, subjectId: ret.id } });
      expect(wf.closed).toBe(true);
      expect((await h.get(`/tax/returns/${ret.id}/evidence`, w.fin.token)).map((d: any) => d.mimeType).sort()).toEqual(['application/json', 'text/csv']);
      await h.post(`/tax/periods/${ret.periodId}/generate`, w.fin.token).expect(409); // a filed return is final
      expect((await h.get('/finance/trial-balance')).balanced).toBe(true);

      const audit = (await h.get(`/audit?entityType=TaxReturn&entityId=${ret.id}`)).map((a: any) => a.action);
      expect(audit).toEqual(expect.arrayContaining(['tax_return.generated', 'tax_return.review_approved', 'tax_return.authorized', 'tax_return.package_prepared', 'tax_return.filed', 'tax_return.payment_recorded', 'tax_return.archived']));
    });
  });

  describe('credit position: more input tax than output tax', () => {
    it('needs no payment reference, carries the credit forward and still completes the evidence trail', async () => {
      const w = await setupPos(http, 'm4d');
      const h = posHelpers(http, w);
      const fin2 = await makeUser(http, w.T, 'fin2', 'FINANCE');
      const p = (await h.post('/tax/periods', w.fin.token, { legalEntityId: w.fx.le.id, startDate: monthStart, endDate: today() }).expect(201)).body;
      const ret = (await h.post(`/tax/periods/${p.id}/generate`, w.fin.token).expect(201)).body;
      expect(ret).toMatchObject({ outputTax: '0', inputTaxRecoverable: '28.8', netPayable: '-28.8' });
      await h.post(`/tax/returns/${ret.id}/submit-review`, w.fin.token).expect(201);
      await h.post(`/tax/returns/${ret.id}/review`, fin2.token, { approve: true }).expect(201);
      const approval = (await h.get('/approvals', w.T.token)).find((a: any) => a.action === 'tax.file_return');
      await h.post(`/approvals/${approval.id}/decide`, w.T.token, { approve: false, comment: 'check the purchase invoices first' }).expect(201);
      expect((await h.get(`/tax/returns/${ret.id}`, w.fin.token)).status).toBe('DRAFT'); // a declined filing goes back to draft
      await h.post(`/tax/returns/${ret.id}/submit-review`, w.fin.token).expect(201);
      await h.post(`/tax/returns/${ret.id}/review`, fin2.token, { approve: true }).expect(201);
      const again = (await h.get('/approvals', w.T.token)).find((a: any) => a.action === 'tax.file_return');
      await h.post(`/approvals/${again.id}/decide`, w.T.token, { approve: true }).expect(201);
      await h.post(`/tax/returns/${ret.id}/package`, w.fin.token).expect(201);
      await h.post(`/tax/returns/${ret.id}/record-filing`, w.fin.token, { acknowledgmentRef: 'ACK-CREDIT-1' }).expect(201);
      const paid = (await h.post(`/tax/returns/${ret.id}/record-payment`, w.fin.token, {}).expect(201)).body;
      expect(paid).toMatchObject({ status: 'PAID', paymentRef: null, paymentJournalId: null });
      expect((await h.tb('1210')).balance).toBe('28.8'); // credit carried forward
      expect((await h.post(`/tax/returns/${ret.id}/archive`, w.fin.token).expect(201)).body.status).toBe('ARCHIVED');
    });
  });

  describe('e-invoicing is a separate, retriable external track', () => {
    let w: PosWorld;
    let h: ReturnType<typeof posHelpers>;

    beforeAll(async () => {
      w = await setupPos(http, 'm4c');
      h = posHelpers(http, w);
    });

    it('is off by default and owner-controlled', async () => {
      expect(await h.get('/tax/settings/einvoicing', w.fin.token)).toEqual({ enabled: false });
      const o = await h.sellCash([h.lineCake(1)]);
      expect(o.invoice.externalStatus).toBe('NOT_REQUIRED');
      await http.put('/tax/settings/einvoicing').set(auth(w.fin.token)).send({ enabled: true }).expect(403);
      await http.put('/tax/settings/einvoicing').set(auth(w.T.token)).send({ enabled: true }).expect(200);
    });

    it('submits through the job queue; a rejection (missing seller tax number) is visible and can be resubmitted after the fix', async () => {
      const o = await h.sellCash([h.lineCake(1)]);
      const rejected = await until(async () => {
        const inv = (await h.get('/tax/einvoices?status=REJECTED', w.fin.token)).find((i: any) => i.orderId === o.id);
        return inv;
      });
      expect(rejected.externalStatus).toBe('REJECTED');
      expect((await h.get(`/pos/orders/${o.id}`, w.cashier.token)).externalStatus).toBe('REJECTED');
      expect((await h.get(`/pos/orders/${o.id}/receipt`, w.cashier.token)).eInvoice.status).toBe('REJECTED');

      await http.patch(`/org/legal-entities/${w.fx.le.id}`).set(auth(w.fin.token)).send({ taxNumber: '1234567' }).expect(200);
      await h.post(`/tax/einvoices/${rejected.id}/resubmit`, w.fin.token).expect(201);
      const accepted = await until(async () => {
        const inv = (await h.get('/tax/einvoices?status=ACCEPTED', w.fin.token)).find((i: any) => i.id === rejected.id);
        return inv;
      });
      expect(accepted.externalRef).toBe(`STUB-${rejected.number}`); // clearly marked as a stub reference

      const next = await h.sellCash([h.lineCake(2)]);
      const ok = await until(async () => (await h.get('/tax/einvoices?status=ACCEPTED', w.fin.token)).find((i: any) => i.orderId === next.id));
      expect(ok.externalStatus).toBe('ACCEPTED');
      expect(await prisma.raw.integrationJob.count({ where: { tenantId: w.T.tenantId, adapter: 'einvoice', idempotencyKey: `einvoice:${ok.id}` } })).toBe(1); // exactly one job per invoice
    });
  });
});
