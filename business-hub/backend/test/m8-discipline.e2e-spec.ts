import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M8 discipline', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let otherMgr: { token: string }, mgr: { token: string }, hr: { token: string }, ana: { token: string; empId: string }, bob: { token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);

  async function employee(key: string, branchId: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    await prisma.raw.employmentContract.create({ data: { tenantId: T.tenantId, employeeId: e.id, version: 1, type: 'PERMANENT', startDate: new Date('2025-01-01'), salaryBasic: 600, weeklyHours: 48 } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm8');
    const branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    const b2 = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', b2);
    hr = await makeUser(http, T, 'hr', 'HR');
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana', branchId);
    bob = await employee('bob', branchId);
  });
  afterAll(() => app.close());

  it('runs report to appeal; a fine becomes exactly one payroll deduction', async () => {
    const c = (await post('/discipline/cases', mgr.token, { employeeId: ana.empId, category: 'ATTENDANCE', description: 'Late three times', incidentDate: '2026-03-01' }).expect(201)).body;
    expect(c.status).toBe('REPORTED');
    await post('/discipline/cases', ana.token, { employeeId: bob.empId, category: 'CONDUCT', description: 'staff cannot report' }).expect(403);
    await post('/discipline/cases', otherMgr.token, { employeeId: ana.empId, category: 'CONDUCT', description: 'other branch', incidentDate: '2026-03-01' }).expect(403);
    await http.get(`/me/warnings`).set(auth(ana.token)).expect(200).expect([]); // hidden until HR asks for a response
    await post(`/discipline/cases/${c.id}/review`, hr.token).expect(201);
    await post(`/discipline/cases/${c.id}/request-response`, hr.token).expect(201);
    await post(`/me/warnings/${c.id}/respond`, bob.token, { text: 'not mine' }).expect(404); // someone else's case
    await post(`/me/warnings/${c.id}/respond`, ana.token, { text: 'Bus was late' }).expect(201);
    // fine rules: OWNER only, basis required, capped at 1 day's basic (600/30 = 20)
    await post(`/discipline/cases/${c.id}/decide`, hr.token, { sanction: 'FINE', fineAmount: 10, legalBasis: 'Policy 4.2' }).expect(403);
    await post(`/discipline/cases/${c.id}/decide`, T.token, { sanction: 'FINE', fineAmount: 10 }).expect(400);
    await post(`/discipline/cases/${c.id}/decide`, T.token, { sanction: 'FINE', fineAmount: 25, legalBasis: 'Policy 4.2' }).expect(400);
    await post(`/discipline/cases/${c.id}/decide`, T.token, { sanction: 'FINE', fineAmount: 10, legalBasis: 'Policy 4.2' }).expect(201);
    await post(`/discipline/cases/${c.id}/notify`, hr.token).expect(201);
    await post(`/discipline/cases/${c.id}/notify`, hr.token).expect(409); // no second deduction
    const adj = await prisma.raw.payrollAdjustment.findMany({ where: { tenantId: T.tenantId, employeeId: ana.empId } });
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ kind: 'DEDUCTION', sourceRef: `discipline:${c.id}` });
    await post(`/me/warnings/${c.id}/acknowledge`, ana.token).expect(201);
    await post(`/me/warnings/${c.id}/appeal`, ana.token, { text: 'Bus strike' }).expect(201);
    await post(`/discipline/cases/${c.id}/appeal-decision`, hr.token, { outcome: 'OVERTURNED' }).expect(201);
    expect(await prisma.raw.payrollAdjustment.count({ where: { tenantId: T.tenantId, employeeId: ana.empId } })).toBe(0); // not yet in a run: removed
  });

  it('dismissal creates no payroll effect', async () => {
    const c = (await post('/discipline/cases', mgr.token, { employeeId: bob.empId, category: 'CONDUCT', description: 'Alleged rudeness', incidentDate: '2026-03-02' }).expect(201)).body;
    await post(`/discipline/cases/${c.id}/review`, hr.token).expect(201);
    await post(`/discipline/cases/${c.id}/decide`, hr.token, { sanction: 'NONE', note: 'No evidence' }).expect(201);
    expect(await prisma.raw.payrollAdjustment.count({ where: { tenantId: T.tenantId, employeeId: bob.empId } })).toBe(0);
  });
});
