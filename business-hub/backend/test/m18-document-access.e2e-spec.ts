import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M18 only authorised people open documents', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let b1: string, b2: string;
  type U = { id: string; token: string };
  let hr: U, fin: U, buyer: U, mgr: U, mgr2: U, staff: U, other: U, boss: U;
  let emp: { id: string };
  let positionId: string;
  const people = () => ({ owner: { id: T.ownerId, token: T.token }, hr, fin, buyer, mgr, mgr2, staff, other, boss });
  type Who = keyof ReturnType<typeof people>;
  let n = 0;

  const upload = async (by: U, query = '') => (await http.post(`/documents${query}`).set(auth(by.token)).attach('file', Buffer.from(`file ${++n}`), { filename: `f${n}.txt`, contentType: 'text/plain' }).expect(201)).body.id as string;
  // Who can open it, checked on both the details and the download route.
  async function openers(id: string) {
    const out: string[] = [];
    for (const [name, u] of Object.entries(people())) {
      const a = (await http.get(`/documents/${id}`).set(auth(u.token))).status;
      const b = (await http.get(`/documents/${id}/download`).set(auth(u.token))).status;
      expect([a, b]).toEqual(a === 200 ? [200, 200] : [404, 404]);
      if (a === 200) out.push(name);
    }
    return out.sort();
  }
  const expectOpeners = async (id: string, names: Who[]) => expect(await openers(id)).toEqual([...new Set<string>(['owner', ...names])].sort());
  const t = () => T.tenantId;

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm18');
    const branch = async (code: string) => (await http.post('/org/branches').set(auth(T.token)).send({ legalEntityId: T.legalEntityId, code, name: code }).expect(201)).body.id as string;
    b1 = await branch('B1');
    b2 = await branch('B2');
    hr = await makeUser(http, T, 'hr', 'HR');
    fin = await makeUser(http, T, 'fin', 'FINANCE');
    buyer = await makeUser(http, T, 'buyer', 'PROCUREMENT');
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', b1);
    mgr2 = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', b2);
    staff = await makeUser(http, T, 'staff', 'EMPLOYEE', b1);
    other = await makeUser(http, T, 'other', 'EMPLOYEE', b1);
    boss = await makeUser(http, T, 'boss', 'EMPLOYEE', b1);
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: t(), title: 'P', titleAr: 'P', payBandMin: 1, payBandMax: 2 } })).id;
    const mk = (number: string, userId: string, managerId?: string) => prisma.raw.employee.create({ data: { tenantId: t(), positionId, number, legalEntityId: T.legalEntityId, userId, managerId, name: number, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01') } });
    const lead = await mk('LEAD', boss.id);
    emp = await mk('EMP', staff.id, lead.id);
    await prisma.raw.employeeAssignment.create({ data: { tenantId: t(), employeeId: emp.id, branchId: b1, isPrimary: true, validFrom: new Date('2025-01-01') } });
  });
  afterAll(() => app.close());

  it('an unlinked file is for its uploader and the owner, whatever label the caller sends', async () => {
    const id = await upload(other, '?subjectType=TaxReturn&subjectId=x');
    await expectOpeners(id, ['other']);
    expect((await prisma.raw.evidenceDocument.findFirstOrThrow({ where: { id } })).subjectType).toBeNull();
  });

  it('candidate documents: HR', async () => {
    const v = await prisma.raw.vacancy.create({ data: { tenantId: t(), number: 'V1', branchId: b1, legalEntityId: T.legalEntityId, positionId, headcount: 1, payMin: 1, payMax: 2, status: 'OPEN', publicCode: randomUUID(), requestedBy: T.ownerId } });
    const c = await prisma.raw.candidate.create({ data: { tenantId: t(), name: 'C', phone: '0791111111', dataConsentAt: new Date(), privacyNoticeVersion: 'v1', retentionUntil: new Date(Date.now() + 86_400_000) } });
    const a = await prisma.raw.application.create({ data: { tenantId: t(), vacancyId: v.id, candidateId: c.id, status: 'ONBOARDING', trackingToken: randomUUID() } });
    const id = await upload({ id: T.ownerId, token: T.token });
    await prisma.raw.evidenceDocument.update({ where: { id }, data: { subjectType: 'Application', subjectId: a.id } });
    await expectOpeners(id, ['hr']);
  });

  it('payslips and bank files: HR and finance', async () => {
    const slip = await upload({ id: T.ownerId, token: T.token });
    const bank = await upload({ id: T.ownerId, token: T.token });
    const run = await prisma.raw.payrollRun.create({ data: { tenantId: t(), number: 'PR1', legalEntityId: T.legalEntityId, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-31'), ruleSetId: 'x', ruleVersion: 1, createdBy: T.ownerId, bankFileDocId: bank } });
    await prisma.raw.payrollRunLine.create({ data: { tenantId: t(), runId: run.id, employeeId: emp.id, branchId: b1, basic: 1, allowances: 0, overtimePay: 0, otherEarnings: 0, lateDeduction: 0, unpaidLeaveDeduction: 0, gross: 1, sscEmployee: 0, sscEmployer: 0, incomeTax: 0, advances: 0, net: 1, regularHours: 0, overtimeHours: 0, trace: {}, payslipDocId: slip } });
    await expectOpeners(slip, ['hr', 'fin']);
    await expectOpeners(bank, ['hr', 'fin']);
  });

  it('leave certificates: HR, the employee and their line manager', async () => {
    const id = await upload({ id: T.ownerId, token: T.token });
    const type = await prisma.raw.leaveType.findFirst({ where: { tenantId: t() } }) ?? await prisma.raw.leaveType.create({ data: { tenantId: t(), key: 'SICK', name: 'Sick' } });
    await prisma.raw.leaveRequest.create({ data: { tenantId: t(), employeeId: emp.id, leaveTypeId: type.id, startDate: new Date('2027-01-04'), endDate: new Date('2027-01-05'), days: 2, hours: 0, certificateDocId: id } });
    await expectOpeners(id, ['hr', 'staff', 'boss']);
  });

  it('discipline evidence: HR', async () => {
    const id = await upload({ id: T.ownerId, token: T.token });
    await prisma.raw.disciplinaryCase.create({ data: { tenantId: t(), number: 'DC1', employeeId: emp.id, category: 'X', description: 'x', incidentDate: new Date(), reportedBy: T.ownerId, evidenceDocIds: [id] } });
    await expectOpeners(id, ['hr']);
  });

  it('guides: all staff; branch proof: that manager and HR', async () => {
    const guide = await upload({ id: T.ownerId, token: T.token });
    await prisma.raw.checklistTemplate.create({ data: { tenantId: t(), code: 'C1', version: 1, name: 'Open', items: [], attachments: [{ id: guide, filename: 'g', mimeType: 'text/plain', sizeBytes: 1 }], createdBy: T.ownerId } });
    await expectOpeners(guide, ['hr', 'fin', 'buyer', 'mgr', 'mgr2', 'staff', 'other', 'boss']);
    const proof = await upload(staff);
    await prisma.raw.correctiveAction.create({ data: { tenantId: t(), number: 'CA1', branchId: b1, source: 'MANUAL', title: 'x', severity: 'LOW', status: 'OPEN', evidenceDocIds: [proof], createdBy: T.ownerId } });
    await expectOpeners(proof, ['hr', 'mgr', 'staff']);
    const reading = await upload(staff);
    await prisma.raw.foodSafetyReading.create({ data: { tenantId: t(), pointId: 'p', branchId: b2, value: 1, inRange: true, takenBy: staff.id, docId: reading } });
    await expectOpeners(reading, ['hr', 'mgr2', 'staff']);
  });

  it('listing a record shows only what the caller may open', async () => {
    const id = await upload({ id: T.ownerId, token: T.token });
    await prisma.raw.evidenceDocument.update({ where: { id }, data: { subjectType: 'PayrollRun', subjectId: 'run-x' } });
    const list = async (u: U) => (await http.get('/documents/by-subject/PayrollRun/run-x').set(auth(u.token)).expect(200)).body;
    expect(await list(fin)).toHaveLength(1);
    expect(await list(other)).toEqual([]);
  });

  it('a role limited to one legal entity opens only that entity’s files', async () => {
    const second = (await prisma.raw.legalEntity.create({ data: { tenantId: t(), name: 'Second Co' } })).id;
    const limited = async (key: string, roleKey: string, legalEntityId: string) => {
      const u = await makeUser(http, T, key, 'EMPLOYEE');
      const role = await prisma.raw.role.findFirstOrThrow({ where: { tenantId: t(), key: roleKey } });
      await prisma.raw.userRole.create({ data: { tenantId: t(), userId: u.id, roleId: role.id, legalEntityId } });
      return u;
    };
    const slip = await upload({ id: T.ownerId, token: T.token });
    const bank = await upload({ id: T.ownerId, token: T.token });
    const run = await prisma.raw.payrollRun.create({ data: { tenantId: t(), number: 'PR2', legalEntityId: T.legalEntityId, periodStart: new Date('2026-02-01'), periodEnd: new Date('2026-02-28'), ruleSetId: 'x', ruleVersion: 1, createdBy: T.ownerId, bankFileDocId: bank } });
    await prisma.raw.payrollRunLine.create({ data: { tenantId: t(), runId: run.id, employeeId: emp.id, branchId: b1, basic: 1, allowances: 0, overtimePay: 0, otherEarnings: 0, lateDeduction: 0, unpaidLeaveDeduction: 0, gross: 1, sscEmployee: 0, sscEmployer: 0, incomeTax: 0, advances: 0, net: 1, regularHours: 0, overtimeHours: 0, trace: {}, payslipDocId: slip } });
    const cases: [U, number][] = [[await limited('finSame', 'FINANCE', T.legalEntityId), 200], [await limited('finElse', 'FINANCE', second), 404], [await limited('ownElse', 'OWNER', second), 404]];
    for (const [u, status] of cases) for (const id of [slip, bank]) await http.get(`/documents/${id}`).set(auth(u.token)).expect(status);
  });

  it('a refused filing receipt leaves the tax return unfiled', async () => {
    const secret = await upload(hr);
    const period = await prisma.raw.taxPeriod.create({ data: { tenantId: t(), legalEntityId: T.legalEntityId, startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'), dueDate: new Date('2026-02-28'), label: 'Jan' } });
    const ret = await prisma.raw.taxReturn.create({ data: { tenantId: t(), periodId: period.id, legalEntityId: T.legalEntityId, version: 1, status: 'APPROVED', outputBase: 0, outputTax: 0, inputBase: 0, inputTaxRecoverable: 0, inputTaxNonRecoverable: 0, netPayable: 0, findings: [], workingPapers: {}, generatedBy: T.ownerId, packageDocId: await upload(fin) } });
    await http.post(`/tax/returns/${ret.id}/record-filing`).set(auth(fin.token)).send({ acknowledgmentRef: 'ACK-1234', evidenceDocumentId: secret }).expect(400);
    expect((await prisma.raw.taxReturn.findFirstOrThrow({ where: { id: ret.id } })).status).toBe('APPROVED');
  });

  it('nobody can attach a file they may not open', async () => {
    const secret = await upload(hr);
    const type = await prisma.raw.leaveType.findFirstOrThrow({ where: { tenantId: t() } });
    const asStaff = (path: string, body: object) => http.post(path).set(auth(staff.token)).send(body);
    const r = await asStaff('/me/leave/requests', { leaveTypeId: type.id, startDate: '2027-02-01', endDate: '2027-02-01', certificateDocId: secret }).expect(400);
    expect(r.body.message).toMatch(/Unknown/);
    await http.post('/ops/library').set(auth(mgr.token)).send({ kind: 'SOP', title: 'x', body: 'x', attachmentIds: [secret] });
    expect(await prisma.raw.libraryItem.count({ where: { tenantId: t() } })).toBe(0);
    await expectOpeners(secret, ['hr']);
  });
});
