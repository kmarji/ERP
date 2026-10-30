import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { StubCandidateNotifier } from '../src/modules/recruitment/candidate-notifier';
import { SscService } from '../src/modules/people/ssc.service';
import { WorkflowEngineService } from '../src/modules/workflow-engine/workflow-engine.service';
import { Http, PASSWORD, auth, createApp, makeUser, newTenant, today } from './helpers';

describe('M6b onboarding and people core (AT-08)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string;
  let branch2Id: string;
  let legalEntityId: string;
  let positionId: string;
  let hr1: { id: string; token: string };
  let hr2: { id: string; token: string };
  let fin: { id: string; token: string };
  let mgr: { id: string; token: string };
  let mgr2: { id: string; token: string };
  let notifier: StubCandidateNotifier;
  let wfEngine: WorkflowEngineService;
  const NATIONAL_ID = '9871234567890';

  const get = async (path: string, token = hr1.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const inTenant = <R>(fn: () => Promise<R>) => runWithTenant(T.tenantId, fn);

  // An application that has already been through screening and interview: WF-03 at ADVANCED.
  async function advancedApplication(headcount = 1, email: string | null = null) {
    const suffix = randomUUID().slice(0, 6);
    const vacancy = await prisma.raw.vacancy.create({
      data: { tenantId: T.tenantId, number: `VAC-${suffix}`, branchId, legalEntityId, positionId, headcount, payMin: 400, payMax: 600, status: 'OPEN', publicCode: randomBytes(6).toString('hex'), requestedBy: hr1.id },
    });
    const candidate = await prisma.raw.candidate.create({
      data: { tenantId: T.tenantId, name: `Sara ${suffix}`, phone: `079${Math.floor(1000000 + Math.random() * 8999999)}`, email, dataConsentAt: new Date(), privacyNoticeVersion: 'v1', retentionUntil: new Date(Date.now() + 180 * 86_400_000) },
    });
    const application = await prisma.raw.application.create({
      data: { tenantId: T.tenantId, vacancyId: vacancy.id, candidateId: candidate.id, status: 'ADVANCED', trackingToken: randomBytes(18).toString('hex') },
    });
    await inTenant(async () => {
      const wf = await wfEngine.start('WF-03', 'Application', application.id);
      for (const ev of ['screen_pass', 'invite', 'scheduled', 'interview_done', 'auto_advance']) await wfEngine.fire(wf.id, ev);
    });
    return { vacancy, candidate, application };
  }

  const offerBody = (over: object = {}) => ({ startDate: today(), salaryBasic: 500, allowances: [{ name: 'Transport', amount: 30 }], ...over });
  const wfState = async (applicationId: string) => (await prisma.raw.workflowInstance.findFirstOrThrow({ where: { tenantId: T.tenantId, subjectId: applicationId } })).state;
  const upload = (token: string, type: string) => http.post(`/apply/status/${token}/documents/${type}`).attach('file', Buffer.from(`scan of ${type}`), { filename: `${type}.pdf`, contentType: 'application/pdf' });

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    notifier = app.get(StubCandidateNotifier, { strict: false });
    wfEngine = app.get(WorkflowEngineService);
    T = await newTenant(http, 'm6b');
    legalEntityId = (await get('/org/legal-entities', T.token))[0].id;
    await http.patch(`/org/legal-entities/${legalEntityId}`).set(auth(T.token)).send({ taxNumber: '1234567' }).expect(200);
    branchId = (await post('/org/branches', T.token, { legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    branch2Id = (await post('/org/branches', T.token, { legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    hr1 = await makeUser(http, T, 'hr1', 'HR');
    hr2 = await makeUser(http, T, 'hr2', 'HR');
    fin = await makeUser(http, T, 'fin1', 'FINANCE');
    mgr = await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', branchId);
    mgr2 = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', branch2Id);
    positionId = (
      await prisma.raw.jobPosition.create({
        data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600, requiredDocuments: ['NATIONAL_ID', 'BANK_DETAILS'], trainingModules: [{ title: 'Food safety', mandatory: true, dueDays: 14 }, { title: 'POS basics', mandatory: false, dueDays: 7 }] },
      })
    ).id;
  });
  afterAll(() => app.close());

  describe('offers', () => {
    it('only advanced candidates get offers, below-band salaries are refused, in-band offers auto-approve', async () => {
      const a = await advancedApplication();
      await post(`/applications/${a.application.id}/offer`, mgr.token, offerBody()).expect(403); // managers cannot make offers
      await post(`/applications/${a.application.id}/offer`, hr1.token, offerBody({ salaryBasic: 350 })).expect(400);
      await post(`/applications/${a.application.id}/offer`, hr1.token, offerBody({ contractType: 'FIXED_TERM' })).expect(400); // needs an end date
      const notAdvanced = await prisma.raw.application.create({ data: { tenantId: T.tenantId, vacancyId: a.vacancy.id, candidateId: (await prisma.raw.candidate.create({ data: { tenantId: T.tenantId, name: 'X', phone: `078${Math.floor(1000000 + Math.random() * 8999999)}`, dataConsentAt: new Date(), privacyNoticeVersion: 'v1', retentionUntil: new Date() } })).id, status: 'SCREENED', trackingToken: randomBytes(18).toString('hex') } });
      await post(`/applications/${notAdvanced.id}/offer`, hr1.token, offerBody()).expect(409);

      const offer = (await post(`/applications/${a.application.id}/offer`, hr1.token, offerBody()).expect(201)).body;
      expect(offer).toMatchObject({ status: 'APPROVED', salaryBasic: '500', number: expect.stringMatching(/^OFR-\d{6}$/), createdBy: hr1.id });
      expect(offer.contractText.en).toContain('500.000');
      expect(offer.contractText.en).toContain(a.candidate.name);
      expect(offer.contractText.en).toContain('1234567'); // employer tax number
      expect(offer.contractText.ar).toContain('باريستا');
      expect(offer.contractDocId).toBeTruthy();
      expect(await wfState(a.application.id)).toBe('OFFER_PENDING');
      expect((await prisma.raw.application.findFirstOrThrow({ where: { id: a.application.id } })).status).toBe('OFFER_PENDING');
      await post(`/applications/${a.application.id}/offer`, hr1.token, offerBody()).expect(409); // one offer per application
    });

    it('an above-band offer waits for a second person; rejection withdraws it and returns the candidate to advanced', async () => {
      const a = await advancedApplication();
      const offer = (await post(`/applications/${a.application.id}/offer`, hr1.token, offerBody({ salaryBasic: 700 })).expect(201)).body;
      expect(offer.status).toBe('PENDING_APPROVAL');
      await post(`/offers/${offer.id}/send`, hr1.token).expect(409); // not approved yet
      const approval = (await get('/approvals', hr2.token)).find((x: any) => x.subjectId === offer.id);
      expect(approval).toMatchObject({ action: 'offer.approve', approverRole: 'HR' });
      await post(`/approvals/${approval.id}/decide`, hr1.token, { approve: true }).expect(403); // the requester cannot approve their own offer
      await post(`/approvals/${approval.id}/decide`, hr2.token, { approve: true }).expect(201);
      expect((await get(`/applications/${a.application.id}/offer`)).status).toBe('APPROVED');

      const b = await advancedApplication();
      const o2 = (await post(`/applications/${b.application.id}/offer`, hr1.token, offerBody({ salaryBasic: 900 })).expect(201)).body;
      const ap2 = (await get('/approvals', hr2.token)).find((x: any) => x.subjectId === o2.id);
      await post(`/approvals/${ap2.id}/decide`, hr2.token, { approve: false, comment: 'over budget' }).expect(201);
      expect((await get(`/applications/${b.application.id}/offer`)).status).toBe('WITHDRAWN');
      expect(await wfState(b.application.id)).toBe('ADVANCED');
      expect((await get('/offers?status=WITHDRAWN')).map((o: any) => o.id)).toContain(o2.id);
    });
  });

  describe('AT-08: an approved hire produces the employee file with no repeated data entry', () => {
    let ctx: Awaited<ReturnType<typeof advancedApplication>>;
    let offer: any;
    let employee: any;
    let inviteToken: string;
    const token = () => ctx.application.trackingToken;

    beforeAll(async () => {
      ctx = await advancedApplication(1, 'sara.hire@example.test');
      offer = (await post(`/applications/${ctx.application.id}/offer`, hr1.token, offerBody()).expect(201)).body;
    });

    it('the candidate sees and signs the contract using only the private link', async () => {
      await http.get(`/apply/status/${token()}/offer`).expect(404); // not sent yet
      await http.get('/apply/status/not-a-real-token/offer').expect(404);
      await post(`/offers/${offer.id}/countersign`, hr2.token).expect(409); // candidate must sign first
      await post(`/offers/${offer.id}/send`, hr1.token).expect(201);
      expect(notifier.sent.some((m) => m.template === 'offer_sent' && m.text.includes(token()))).toBe(true);

      const seen = (await http.get(`/apply/status/${token()}/offer`).expect(200)).body;
      expect(seen).toMatchObject({ status: 'SENT', salaryBasic: '500' });
      expect(seen.contractText.en).toContain('Employment Contract');
      await http.post(`/apply/status/${token()}/offer/accept`).send({ signatureName: ctx.candidate.name, agree: false }).expect(400);
      const accepted = (await http.post(`/apply/status/${token()}/offer/accept`).send({ signatureName: ctx.candidate.name, agree: true }).expect(201)).body;
      expect(accepted).toMatchObject({ status: 'ACCEPTED', requiredDocuments: ['NATIONAL_ID', 'BANK_DETAILS'] });
      await http.post(`/apply/status/${token()}/offer/accept`).send({ signatureName: 'x y', agree: true }).expect(409);
      const signed = await prisma.raw.offer.findFirstOrThrow({ where: { id: offer.id } });
      expect(JSON.parse(signed.candidateSignature!)).toMatchObject({ name: ctx.candidate.name, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(await wfState(ctx.application.id)).toBe('ONBOARDING');
      expect((await get(`/applications/${ctx.application.id}/documents`)).map((d: any) => [d.type, d.status])).toEqual([['BANK_DETAILS', 'REQUIRED'], ['NATIONAL_ID', 'REQUIRED']]);
    });

    it('collects documents and personal details once; HR verifies; countersign respects separation of duties', async () => {
      await upload(token(), 'PASSPORT').expect(400); // not a required document
      await http.post(`/apply/status/${token()}/documents/NATIONAL_ID`).expect(400); // no file
      await upload(token(), 'NATIONAL_ID').expect(201);
      await upload(token(), 'BANK_DETAILS').expect(201);
      await post(`/applications/${ctx.application.id}/documents/BANK_DETAILS/verify`, hr1.token, { approve: false }).expect(400); // needs a note
      await post(`/applications/${ctx.application.id}/documents/BANK_DETAILS/verify`, hr1.token, { approve: false, note: 'IBAN is unreadable' }).expect(201);
      expect(notifier.sent.some((m) => m.template === 'document_rejected' && m.text.includes('IBAN is unreadable'))).toBe(true);
      await upload(token(), 'BANK_DETAILS').expect(201); // re-upload after rejection
      for (const type of ['NATIONAL_ID', 'BANK_DETAILS']) await post(`/applications/${ctx.application.id}/documents/${type}/verify`, hr1.token, { approve: true }).expect(201);
      await upload(token(), 'NATIONAL_ID').expect(409); // verified documents are final

      await post(`/offers/${offer.id}/countersign`, hr1.token).expect(403); // the drafter cannot countersign
      await post(`/applications/${ctx.application.id}/complete-onboarding`, hr1.token).expect(409); // not countersigned
      await post(`/offers/${offer.id}/countersign`, hr2.token).expect(201);
      await post(`/applications/${ctx.application.id}/complete-onboarding`, hr1.token).expect(409); // no personal details yet

      const details = { nationalId: NATIONAL_ID, dateOfBirth: '1999-04-12', address: 'Rainbow St 10, Amman', iban: 'JO94CBJO0010000000000131000302' };
      await http.post(`/apply/status/${token()}/personal-details`).send({ ...details, nationalId: '1' }).expect(400);
      await http.post(`/apply/status/${token()}/personal-details`).send(details).expect(201);
      await http.post(`/apply/status/${token()}/personal-details`).send(details).expect(409); // entered once
      const stored = await prisma.raw.application.findFirstOrThrow({ where: { id: ctx.application.id } });
      expect(JSON.stringify(stored.intake)).not.toContain(NATIONAL_ID);
      expect(JSON.stringify(stored.intake)).toContain('v1:');
    });

    it('creates the employee file, contract, assignment, attendance profile, training, SSC action, user and tasks in one go', async () => {
      await post(`/applications/${ctx.application.id}/complete-onboarding`, mgr.token).expect(403);
      employee = (await post(`/applications/${ctx.application.id}/complete-onboarding`, hr1.token).expect(201)).body;
      expect(employee).toMatchObject({ number: expect.stringMatching(/^EMP-\d{6}$/), status: 'ACTIVE', legalEntityId, positionId, name: ctx.candidate.name });
      expect(employee).not.toHaveProperty('sensitive');
      expect(employee.assignments).toEqual([expect.objectContaining({ branchId, isPrimary: true })]);
      expect(employee.contracts).toEqual([expect.objectContaining({ version: 1, status: 'ACTIVE', salaryBasic: '500', documentId: offer.contractDocId })]);

      const row = await prisma.raw.employee.findFirstOrThrow({ where: { id: employee.id } });
      expect(row.sensitive).toMatch(/^v1:/);
      expect(row.sensitive).not.toContain(NATIONAL_ID); // no plaintext in the database
      expect(row.attendanceProfile).toMatchObject({ weeklyHours: 48, scheduleType: 'ROSTER', clockMethod: 'MANUAL' });

      const training = await get(`/employees/${employee.id}/training`);
      expect(training.map((t: any) => [t.title, t.mandatory]).sort()).toEqual([['Food safety', true], ['POS basics', false]]);
      expect(new Date(training.find((t: any) => t.title === 'POS basics').dueDate).toISOString().slice(0, 10)).toBe(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));

      const ssc = (await get('/ssc/actions?status=PREPARED'))[0];
      expect(ssc).toMatchObject({ kind: 'REGISTRATION', employeeId: employee.id });
      expect(JSON.stringify(ssc.payload)).not.toContain(NATIONAL_ID); // the stored payload carries no identity numbers
      expect(ssc.payload).toMatchObject({ employeeNumber: employee.number, employerTaxNumber: '1234567', salaryBasic: '500' });

      const tasks = await get('/tasks', mgr.token);
      expect(tasks.map((t: any) => t.title)).toEqual(expect.arrayContaining([`Add ${ctx.candidate.name} to the schedule`, 'Prepare uniform and access']));
      expect((await get('/tasks', mgr2.token)).some((t: any) => t.title.includes(ctx.candidate.name))).toBe(false);
      expect((await get('/notifications', fin.token)).some((n: any) => n.title.includes(employee.number))).toBe(true);

      expect((await prisma.raw.vacancy.findFirstOrThrow({ where: { id: ctx.vacancy.id } }))).toMatchObject({ filled: 1, status: 'FILLED' });
      expect(await wfState(ctx.application.id)).toBe('HIRED');
      expect((await prisma.raw.application.findFirstOrThrow({ where: { id: ctx.application.id } })).status).toBe('HIRED');
    });

    it('is idempotent: a second call returns the same employee and creates nothing', async () => {
      const again = (await post(`/applications/${ctx.application.id}/complete-onboarding`, hr1.token).expect(201)).body;
      expect(again.id).toBe(employee.id);
      expect(await prisma.raw.employee.count({ where: { tenantId: T.tenantId, candidateId: ctx.candidate.id } })).toBe(1);
      expect(await prisma.raw.sscAction.count({ where: { tenantId: T.tenantId, employeeId: employee.id } })).toBe(1);
      expect(await prisma.raw.employmentContract.count({ where: { employeeId: employee.id } })).toBe(1);
    });

    it('the new hire gets a one-time invite that sets their first password, once', async () => {
      const msg = notifier.sent.filter((m) => m.template === 'employee_invite').pop()!;
      inviteToken = msg.text.match(/[0-9a-f]{48}/)![0];
      await http.post('/auth/accept-invite').send({ token: inviteToken, password: 'short' }).expect(400);
      await http.post('/auth/accept-invite').send({ token: 'f'.repeat(48), password: PASSWORD }).expect(400);
      await http.post('/auth/login').send({ tenant: T.slug, email: 'sara.hire@example.test', password: PASSWORD }).expect(401); // nothing works before the invite
      await http.post('/auth/accept-invite').send({ token: inviteToken, password: PASSWORD }).expect(200);
      await http.post('/auth/accept-invite').send({ token: inviteToken, password: 'another-password-1' }).expect(400); // single use
      const login = (await http.post('/auth/login').send({ tenant: T.slug, email: 'sara.hire@example.test', password: PASSWORD }).expect(200)).body;
      const me = (await http.get('/auth/me').set(auth(login.accessToken)).expect(200)).body;
      expect(me.roles).toEqual([expect.objectContaining({ key: 'EMPLOYEE', branchId })]);

      // the employee sees and completes their own training, but not other people's files
      const training = await get(`/employees/${employee.id}/training`, login.accessToken);
      await post(`/training/${training[0].id}/complete`, login.accessToken).expect(201);
      expect((await get(`/employees/${employee.id}/training`)).filter((t: any) => t.status === 'DONE')).toHaveLength(1);
      await http.get(`/employees/${employee.id}`).set(auth(login.accessToken)).expect(403);
      await http.get('/employees').set(auth(login.accessToken)).expect(403);
      await http.get(`/employees/${employee.id}/sensitive`).set(auth(login.accessToken)).expect(403);
      const expired = await prisma.raw.userInvite.findFirstOrThrow({ where: { tenantId: T.tenantId } });
      expect(expired.usedAt).not.toBeNull();
    });
  });

  describe('people: privacy and access', () => {
    let emp: any;

    beforeAll(async () => {
      emp = (await get('/employees'))[0];
    });

    it('lists never leak sensitive data; the sensitive endpoint is HR/owner only and audited', async () => {
      const list = await get('/employees');
      expect(JSON.stringify(list)).not.toContain('sensitive');
      expect(JSON.stringify(list)).not.toContain(NATIONAL_ID);
      expect(JSON.stringify(await get(`/employees/${emp.id}`))).not.toContain(NATIONAL_ID);
      await http.get(`/employees/${emp.id}/sensitive`).set(auth(fin.token)).expect(403);
      await http.get(`/employees/${emp.id}/sensitive`).set(auth(mgr.token)).expect(403);
      const s = await get(`/employees/${emp.id}/sensitive`, hr1.token);
      expect(s).toMatchObject({ nationalId: NATIONAL_ID, dateOfBirth: '1999-04-12' });
      const audit = await get(`/audit?entityType=Employee&entityId=${emp.id}`, T.token);
      expect(audit.find((a: any) => a.action === 'employee.sensitive_viewed').after).toMatchObject({ viewer: hr1.id });
    });

    it('branch managers only see people assigned to their branch, without pay', async () => {
      await http.get('/employees').set(auth(mgr.token)).expect(400); // must name a branch
      expect((await get(`/employees?branchId=${branchId}`, mgr.token)).map((e: any) => e.id)).toContain(emp.id);
      await http.get(`/employees?branchId=${branch2Id}`).set(auth(mgr.token)).expect(403);
      await http.get(`/employees/${emp.id}`).set(auth(mgr2.token)).expect(403);
      const seen = await get(`/employees/${emp.id}`, mgr.token);
      expect(seen.activeContract.salaryBasic).toBeUndefined();
      expect((await get(`/employees/${emp.id}/contracts`, fin.token))[0].salaryBasic).toBe('500'); // finance may read contracts
      await http.get(`/employees/${emp.id}/contracts`).set(auth(mgr.token)).expect(403);
      await http.patch(`/employees/${emp.id}`).set(auth(fin.token)).send({ name: 'x' }).expect(403);
    });

    it('supports several branch assignments and versioned contracts with an audit trail', async () => {
      const second = (await post(`/employees/${emp.id}/assignments`, hr1.token, { branchId: branch2Id, validFrom: today() }).expect(201)).body;
      expect((await get(`/employees?branchId=${branch2Id}`, mgr2.token)).map((e: any) => e.id)).toContain(emp.id); // now visible to the second branch
      await post(`/employees/${emp.id}/assignments/${second.id}/end`, hr1.token, {}).expect(201);
      await post(`/employees/${emp.id}/assignments/${second.id}/end`, hr1.token, {}).expect(409);

      const effective = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      await post(`/employees/${emp.id}/contracts`, hr1.token, { effectiveDate: today(), salaryBasic: 520 }).expect(400); // must be after the current start
      const v2 = (await post(`/employees/${emp.id}/contracts`, hr1.token, { effectiveDate: effective, salaryBasic: 550 }).expect(201)).body;
      expect(v2).toMatchObject({ version: 2, status: 'ACTIVE', salaryBasic: '550' });
      const all = await get(`/employees/${emp.id}/contracts`);
      expect(all.map((c: any) => [c.version, c.status])).toEqual([[2, 'ACTIVE'], [1, 'SUPERSEDED']]);
      const audit = await get(`/audit?entityType=Employee&entityId=${emp.id}`, T.token);
      expect(audit.find((a: any) => a.action === 'employee.contract_changed').after).toMatchObject({ version: 2, salaryBasic: '550' });
      expect((await post(`/employees/${emp.id}/training`, hr1.token, { title: 'Allergen awareness' }).expect(201)).body.status).toBe('ASSIGNED');
      expect((await http.patch(`/employees/${emp.id}`).set(auth(hr1.token)).send({ nameAr: 'سارة' }).expect(200)).body.nameAr).toBe('سارة');
    });
  });

  describe('social security lifecycle (PAY-02)', () => {
    it('guides a manual submission and tracks it to confirmation, with identity data only inside the audited package', async () => {
      const action = (await get('/ssc/actions?status=PREPARED'))[0];
      const pkg = (await post(`/ssc/actions/${action.id}/package`, hr1.token).expect(201)).body;
      expect(pkg).toMatchObject({ method: 'MANUAL', kind: 'REGISTRATION', data: { nationalId: NATIONAL_ID, dateOfBirth: '1999-04-12' } });
      expect(pkg.why).toMatch(/manual/i);
      await post(`/ssc/actions/${action.id}/package`, fin.token).expect(403);
      await post(`/ssc/actions/${action.id}/confirm`, hr1.token, {}).expect(409); // not submitted yet
      expect((await post(`/ssc/actions/${action.id}/record-submission`, hr1.token, { reference: 'SSC-REG-1' }).expect(201)).body.status).toBe('SUBMITTED');
      await post(`/ssc/actions/${action.id}/record-submission`, hr1.token, { reference: 'again' }).expect(409);
      expect((await post(`/ssc/actions/${action.id}/confirm`, hr1.token, {}).expect(201)).body).toMatchObject({ status: 'CONFIRMED', reference: 'SSC-REG-1' });
      expect((await get(`/audit?entityType=SscAction&entityId=${action.id}`, T.token)).map((a: any) => a.action)).toEqual(expect.arrayContaining(['ssc.package_generated', 'ssc.submitted', 'ssc.confirmed']));
    });

    it('raises one overdue exception per stale action and a failure exception for HR', async () => {
      const emp = (await get('/employees'))[0];
      const stale = await prisma.raw.sscAction.create({ data: { tenantId: T.tenantId, employeeId: emp.id, kind: 'CHANGE', payload: {}, preparedAt: new Date(Date.now() - 10 * 86_400_000) } });
      const svc = app.get(SscService);
      expect(await inTenant(() => svc.flagOverdue())).toBe(1);
      expect(await inTenant(() => svc.flagOverdue())).toBe(0);
      const ex = (await get('/exceptions?open=true', hr1.token)).filter((e: any) => e.code === 'SSC_OVERDUE');
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ ownerRole: 'HR' });
      expect(ex[0].evidence.sscActionId).toBe(stale.id);

      const failing = await prisma.raw.sscAction.create({ data: { tenantId: T.tenantId, employeeId: emp.id, kind: 'TERMINATION', payload: {} } });
      await post(`/ssc/actions/${failing.id}/fail`, hr1.token, { notes: 'Portal rejected the national id' }).expect(201);
      expect((await get('/exceptions?open=true', hr1.token)).some((e: any) => e.code === 'SSC_SUBMISSION_ISSUE')).toBe(true);
      expect((await prisma.raw.sscAction.findFirstOrThrow({ where: { id: failing.id } })).status).toBe('FAILED');
    });
  });
});
