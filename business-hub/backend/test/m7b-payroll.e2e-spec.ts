import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { FieldCrypto } from '../src/common/crypto/field-crypto';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M7b payroll and offboarding (AT-09)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let crypto: FieldCrypto;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string;
  let legalEntityId: string;
  let hr: { id: string; token: string };
  let fin: { id: string; token: string };
  let positionId: string;
  let seq = 0;

  const get = async (path: string, token = hr.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);

  async function employee(basic: number, opts: { iban?: boolean; hireDate?: string } = {}) {
    const n = ++seq;
    const e = await prisma.raw.employee.create({
      data: {
        tenantId: T.tenantId, number: `E-${n}`, legalEntityId, name: `Emp ${n}`, phone: `0790000${String(n).padStart(3, '0')}`, status: 'ACTIVE',
        hireDate: new Date(opts.hireDate ?? '2020-01-01'), positionId, sensitive: opts.iban === false ? null : crypto.encrypt({ iban: `JO94CBJO0010000000000131000${n}` }),
        contracts: { create: { tenantId: T.tenantId, version: 1, type: 'PERMANENT', startDate: new Date(opts.hireDate ?? '2020-01-01'), salaryBasic: basic, allowances: [{ name: 'Transport', amount: 30 }], weeklyHours: 48 } },
        assignments: { create: { tenantId: T.tenantId, branchId, isPrimary: true, validFrom: new Date('2020-01-01') } },
      },
    });
    return e;
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    crypto = app.get(FieldCrypto);
    T = await newTenant(http, 'm7b');
    legalEntityId = T.legalEntityId;
    branchId = (await post('/org/branches', T.token, { legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    hr = await makeUser(http, T, 'hr1', 'HR');
    fin = await makeUser(http, T, 'fin1', 'FINANCE');
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', payBandMin: 300, payBandMax: 900 } })).id;
  });
  afterAll(() => app.close());

  describe('payroll run', () => {
    let a: Awaited<ReturnType<typeof employee>>;
    let b: Awaited<ReturnType<typeof employee>>;
    let run: any;

    beforeAll(async () => {
      a = await employee(600);
      b = await employee(450, { iban: false });
    });

    it('calculates every employee with a trace and flags the missing bank account', async () => {
      run = (await post('/payroll/runs', hr.token, { legalEntityId, periodStart: '2026-09-01', periodEnd: '2026-09-30' }).expect(201)).body;
      await post('/payroll/runs', hr.token, { legalEntityId, periodStart: '2026-09-15', periodEnd: '2026-10-15' }).expect(409); // overlap
      run = (await post(`/payroll/runs/${run.id}/calculate`, hr.token).expect(201)).body;
      expect(run.status).toBe('CALCULATED');
      expect(run.lines).toHaveLength(2);
      const la = run.lines.find((l: any) => l.employeeId === a.id);
      expect(Number(la.gross)).toBeCloseTo(630, 3);
      expect(Number(la.net)).toBeLessThan(Number(la.gross));
      expect(la.trace.steps.length).toBeGreaterThan(3);
      expect(run.exceptions.map((x: any) => x.code)).toEqual(['MISSING_BANK']);
      expect(run.rulesVerified).toBe(false);
    });

    it('cannot go to review with an open exception; acknowledging needs a note', async () => {
      await post(`/payroll/runs/${run.id}/submit-review`, hr.token).expect(409);
      const ex = (await get(`/payroll/runs/${run.id}`)).exceptions[0];
      await post(`/payroll/exceptions/${ex.id}/resolve`, hr.token, { action: 'ACKNOWLEDGE', note: '' }).expect(400);
      await post(`/payroll/exceptions/${ex.id}/resolve`, hr.token, { action: 'ACKNOWLEDGE', note: 'Pays in cash this month' }).expect(201);
      await post(`/payroll/runs/${run.id}/submit-review`, hr.token).expect(201);
    });

    it('the preparer cannot review, and unverified rules block authorization', async () => {
      await post(`/payroll/runs/${run.id}/review`, hr.token, { approve: true }).expect(403); // HR cannot review at all
      await post(`/payroll/runs/${run.id}/review`, fin.token, { approve: true }).expect(409); // placeholder rules
    });

    it('verified rules, a second reviewer and an owner authorization finalize it with a balanced journal', async () => {
      const rs = (await get('/payroll/rules', fin.token))[0];
      await post(`/payroll/rules/${rs.id}/verify`, fin.token, { note: 'Checked against the current regulation' }).expect(201);
      await post(`/payroll/runs/${run.id}/review`, fin.token, { approve: true }).expect(201);
      const approval = (await get('/approvals', T.token)).find((x: any) => x.subjectId === run.id && x.action === 'payroll.finalize');
      expect(approval).toBeTruthy();
      expect((await get(`/payroll/runs/${run.id}`)).status).toBe('IN_REVIEW');
      await post(`/approvals/${approval.id}/decide`, T.token, { approve: true }).expect(201);

      const done = await get(`/payroll/runs/${run.id}`);
      expect(done.status).toBe('FINALIZED');
      expect(done.journalId).toBeTruthy();
      const j = await prisma.raw.journalLine.findMany({ where: { journalId: done.journalId } });
      const sum = (k: 'debit' | 'credit') => j.reduce((s, l) => s + Number(l[k]), 0);
      expect(sum('debit')).toBeCloseTo(sum('credit'), 3);
      expect(done.lines.every((l: any) => l.payslipDocId)).toBe(true);
      expect((await get('/payroll/obligations', fin.token)).length).toBeGreaterThan(0);
      await post(`/payroll/runs/${run.id}/cancel`, hr.token).expect(409);
    });

    it('bank file skips staff without an account, and payment needs its own approval', async () => {
      const bank = (await post(`/payroll/runs/${run.id}/bank-file`, fin.token).expect(201)).body;
      expect(bank.csv.split('\n')).toHaveLength(2);
      expect(bank.skipped).toEqual([b.number]);
      await post(`/payroll/runs/${run.id}/confirm-payment`, fin.token, { reference: 'TRF-1' }).expect(409);
      await post(`/payroll/runs/${run.id}/request-payment`, fin.token).expect(201);
      const ap = (await get('/approvals', T.token)).find((x: any) => x.subjectId === run.id && x.action === 'payroll.release_payment');
      await post(`/approvals/${ap.id}/decide`, T.token, { approve: true }).expect(201);
      expect((await post(`/payroll/runs/${run.id}/confirm-payment`, fin.token, { reference: 'TRF-1' }).expect(201)).body.status).toBe('PAID');
    });
  });

  describe('advances', () => {
    it('are recovered by instalment in the next run', async () => {
      const e = await employee(500);
      const adv = (await post('/payroll/advances', hr.token, { employeeId: e.id, amount: 90, installments: 3 }).expect(201)).body;
      expect(adv.installmentAmount).toBe('30');
      const r = (await post('/payroll/runs', hr.token, { legalEntityId, periodStart: '2026-10-01', periodEnd: '2026-10-31' }).expect(201)).body;
      const calc = (await post(`/payroll/runs/${r.id}/calculate`, hr.token).expect(201)).body;
      const line = calc.lines.find((l: any) => l.employeeId === e.id);
      expect(Number(line.advances)).toBe(30);
      await post(`/payroll/runs/${r.id}/cancel`, hr.token).expect(201);
    });
  });

  describe('offboarding', () => {
    it('needs checklist and an approved settlement before the employee is terminated', async () => {
      const e = await employee(500);
      const o = (await post('/offboarding', hr.token, { employeeId: e.id, reason: 'RESIGNATION', noticeDate: '2026-10-01', lastWorkingDay: '2026-10-31' }).expect(201)).body;
      await post('/offboarding', hr.token, { employeeId: e.id, reason: 'RESIGNATION', noticeDate: '2026-10-01', lastWorkingDay: '2026-10-31' }).expect(409);
      await post(`/offboarding/${o.id}/complete`, hr.token).expect(409);
      await post(`/offboarding/${o.id}/settlement`, hr.token, { extra: [{ label: 'Notice shortfall', kind: 'DEDUCTION', amount: 20 }] }).expect(201);
      for (const k of ['RETURN_ASSETS', 'REVOKE_ACCESS', 'EXIT_INTERVIEW', 'HANDOVER']) await post(`/offboarding/${o.id}/checklist/${k}`, hr.token).expect(201);
      await post(`/offboarding/${o.id}/complete`, hr.token).expect(409); // settlement not approved
      await post(`/offboarding/${o.id}/request-approval`, hr.token).expect(201);
      const ap = (await get('/approvals', fin.token)).find((x: any) => x.subjectId === o.id);
      await post(`/approvals/${ap.id}/decide`, fin.token, { approve: true }).expect(201);
      const done = (await post(`/offboarding/${o.id}/complete`, hr.token).expect(201)).body;
      expect(done.status).toBe('COMPLETED');
      const after = await prisma.raw.employee.findFirstOrThrow({ where: { id: e.id } });
      expect(after.status).toBe('TERMINATED');
      expect(await prisma.raw.sscAction.count({ where: { employeeId: e.id, kind: 'TERMINATION' } })).toBe(1);
      const adj = await prisma.raw.payrollAdjustment.findMany({ where: { employeeId: e.id } });
      expect(adj.map((x) => x.label)).toEqual(['Settlement: Notice shortfall']);
    });
  });
});
