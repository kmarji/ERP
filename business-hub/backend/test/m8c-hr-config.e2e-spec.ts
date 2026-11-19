import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M8c configurable HR: schedule approval, discipline categories, clearance', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, mgr: { token: string }, mgr2: { token: string }, hr: { token: string }, ana: { empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm8c');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    mgr2 = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', branchId);
    hr = await makeUser(http, T, 'hr', 'HR');
    const position = await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    const u = await makeUser(http, T, 'ana', 'EMPLOYEE', branchId);
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: 'EMP-ana', legalEntityId: T.legalEntityId, userId: u.id, name: 'ana', phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    await prisma.raw.employmentContract.create({ data: { tenantId: T.tenantId, employeeId: e.id, version: 1, type: 'PERMANENT', startDate: new Date('2025-01-01'), salaryBasic: 600, weeklyHours: 48 } });
    ana = { empId: e.id };
  });
  afterAll(() => app.close());

  it('schedule approval is off by default and a company can switch it on', async () => {
    const shift = (d: string) => ({ employeeId: ana.empId, branchId, date: d, startAt: `${d}T06:00:00Z`, endAt: `${d}T12:00:00Z` });
    expect((await post('/schedules', mgr.token, shift(day(10))).expect(201)).body.status).toBe('PUBLISHED');
    await prisma.raw.policy.upsert({ where: { tenantId_key_version: { tenantId: T.tenantId, key: 'schedule.approval', version: 1 } }, create: { tenantId: T.tenantId, key: 'schedule.approval', version: 1, riskTier: 'LOW', rules: { required: true }, active: true }, update: { rules: { required: true }, active: true } });
    const s = (await post('/schedules', mgr.token, shift(day(11))).expect(201)).body;
    expect(s.status).toBe('PENDING_APPROVAL');
    await post(`/schedules/${s.id}/decide`, mgr.token, { approve: true }).expect(403); // not your own
    expect((await post(`/schedules/${s.id}/decide`, mgr2.token, { approve: true }).expect(201)).body.status).toBe('PUBLISHED');
    await post(`/schedules/${s.id}/decide`, mgr2.token, { approve: true }).expect(409); // already decided
    const r = (await post('/schedules', mgr.token, shift(day(12))).expect(201)).body;
    expect((await post(`/schedules/${r.id}/decide`, hr.token, { approve: false }).expect(201)).body.status).toBe('CANCELLED');
    expect(await prisma.raw.auditEvent.count({ where: { tenantId: T.tenantId, action: { in: ['schedule.submitted', 'schedule.approved', 'schedule.rejected'] } } })).toBe(4);
    // a manager's own open-shift assignment is already a decision
    const o = (await post('/open-shifts', mgr.token, { branchId, date: day(13), startAt: `${day(13)}T06:00:00Z`, endAt: `${day(13)}T12:00:00Z` }).expect(201)).body;
    expect((await post(`/open-shifts/${o.id}/assign`, mgr.token, { employeeId: ana.empId }).expect(201)).body.status).toBe('PUBLISHED');
  });

  it('discipline categories are company-defined, with default expiry', async () => {
    expect((await get('/discipline/categories', hr.token).expect(200)).body.map((c: any) => c.key).sort()).toEqual(['ATTENDANCE', 'CONDUCT', 'POLICY', 'SAFETY']);
    await post('/discipline/categories', mgr.token, { key: 'x', label: 'x' }).expect(403);
    await post('/discipline/categories', hr.token, { key: 'cash handling', label: 'Cash handling', expiryMonths: 6 }).expect(201);
    await post('/discipline/categories', hr.token, { key: 'safety', label: 'Safety', active: false }).expect(201);
    expect((await get('/discipline/categories', hr.token).expect(200)).body.map((c: any) => c.key)).not.toContain('SAFETY');
    const body = { employeeId: ana.empId, description: 'Till short twice', incidentDate: day(-1) };
    await post('/discipline/cases', mgr.token, { ...body, category: 'SAFETY' }).expect(400); // switched off
    const c = (await post('/discipline/cases', mgr.token, { ...body, category: 'CASH_HANDLING' }).expect(201)).body;
    await post(`/discipline/cases/${c.id}/review`, hr.token).expect(201);
    const d = (await post(`/discipline/cases/${c.id}/decide`, hr.token, { sanction: 'WRITTEN' }).expect(201)).body;
    const months = (new Date(d.expiresAt).getTime() - Date.now()) / (30.4 * 86_400_000);
    expect(months).toBeGreaterThan(5.5);
    expect(months).toBeLessThan(6.5);
  });

  it('exit clearance list is company-defined and copied onto new cases', async () => {
    expect((await get('/offboarding/clearance-items', hr.token).expect(200)).body).toHaveLength(4);
    await post('/offboarding/clearance-items', hr.token, { key: 'cash drawer', label: 'Cash drawer reconciled', sortOrder: 50 }).expect(201);
    await post('/offboarding/clearance-items', hr.token, { key: 'exit_interview', label: 'Exit interview held', active: false }).expect(201);
    const o = (await post('/offboarding', hr.token, { employeeId: ana.empId, reason: 'RESIGNATION', noticeDate: day(1), lastWorkingDay: day(20) }).expect(201)).body;
    const keys = o.checklist.map((c: any) => c.key);
    expect(keys).toContain('CASH_DRAWER');
    expect(keys).not.toContain('EXIT_INTERVIEW');
    expect(keys).toHaveLength(4);
  });
});
