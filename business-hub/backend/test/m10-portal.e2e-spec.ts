import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M10 employee portal: manager approves leave, certificate letters', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { token: string; id: string }, ana: { token: string; id: string }, boss: { token: string; id: string }, other: { token: string; id: string };
  let anaEmp: string, bossEmp: string;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const patch = (path: string, token: string, body: object = {}) => http.patch(path).set(auth(token)).send(body);
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm10');
    hr = await makeUser(http, T, 'hr', 'HR');
    const position = await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    const emp = async (key: string) => {
      const u = await makeUser(http, T, key, 'EMPLOYEE');
      const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
      await prisma.raw.employmentContract.create({ data: { tenantId: T.tenantId, employeeId: e.id, version: 1, type: 'PERMANENT', startDate: new Date('2025-01-01'), salaryBasic: 600, allowances: [{ name: 'Transport', amount: 50 }], weeklyHours: 48 } });
      return { u, id: e.id };
    };
    const a = await emp('ana'), b = await emp('boss'), o = await emp('other');
    ana = a.u; boss = b.u; other = o.u; anaEmp = a.id; bossEmp = b.id;
    await post('/leave/accrue', hr.token).expect(201);
  });
  afterAll(() => app.close());

  it('only HR sets the manager, and not to the employee themselves', async () => {
    await patch(`/employees/${anaEmp}`, ana.token, { managerId: bossEmp }).expect(403);
    const branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    const branchHr = await makeUser(http, T, 'bhr', 'HR', branchId);
    await patch(`/employees/${anaEmp}`, branchHr.token, { managerId: bossEmp }).expect(403); // branch-scoped roles cannot set managers
    await patch(`/employees/${anaEmp}`, hr.token, { managerId: anaEmp }).expect(400);
    await patch(`/employees/${anaEmp}`, hr.token, { managerId: bossEmp }).expect(200);
    await patch(`/employees/${bossEmp}`, hr.token, { managerId: anaEmp }).expect(400); // no loops
  });

  it("the line manager (an ordinary employee) approves a report's leave; others cannot", async () => {
    const annual = (await get('/leave/types', hr.token)).body.find((t: any) => t.key === 'ANNUAL');
    const req = (await post('/me/leave/requests', ana.token, { leaveTypeId: annual.id, startDate: day(30), endDate: day(30) }).expect(201)).body;
    expect((await get('/me/team/leave', boss.token).expect(200)).body.map((r: any) => r.id)).toContain(req.id);
    expect((await get('/me/team/leave', other.token).expect(200)).body).toEqual([]);
    await post(`/me/team/leave/${req.id}/decide`, other.token, { approve: true }).expect(403);
    await post(`/me/team/leave/${req.id}/decide`, ana.token, { approve: true }).expect(403);
    const done = (await post(`/me/team/leave/${req.id}/decide`, boss.token, { approve: true }).expect(201)).body;
    expect(done.status).toBe('APPROVED');
    expect(done.decidedBy).toBe(boss.id);
    await post(`/me/team/leave/${req.id}/decide`, boss.token, { approve: false }).expect(409); // already decided
  });

  it('a letter request is approved by HR and freezes the figures', async () => {
    await post('/me/letters', ana.token, { kind: 'SALARY', addressee: 'Arab Bank', purpose: 'Loan' }).expect(201);
    const l = (await post('/me/letters', ana.token, { kind: 'EMPLOYMENT', addressee: 'Embassy' }).expect(201)).body;
    await get(`/me/letters/${l.id}`, ana.token).expect(404); // not issued yet
    await get('/letters', ana.token).expect(403);
    await post(`/letters/${l.id}/decide`, ana.token, { approve: true }).expect(403);
    await post(`/letters/${l.id}/decide`, hr.token, { approve: false }).expect(400); // rejection needs a reason
    const ok = (await post(`/letters/${l.id}/decide`, hr.token, { approve: true }).expect(201)).body;
    expect(ok.status).toBe('APPROVED');
    await post(`/letters/${l.id}/decide`, hr.token, { approve: true }).expect(409);
    await get(`/me/letters/${l.id}`, other.token).expect(404); // someone else's letter
    const mine = (await get(`/me/letters/${l.id}`, ana.token).expect(200)).body;
    expect(mine.content).toMatchObject({ employeeName: 'ana', position: 'Barista', company: expect.any(String) });
    expect(mine.content.salary).toBeUndefined(); // employment letter carries no pay
    const sal = (await get('/letters?status=PENDING', hr.token).expect(200)).body[0];
    const issued = (await post(`/letters/${sal.id}/decide`, hr.token, { approve: true }).expect(201)).body;
    expect(issued.content.salary).toEqual({ basic: '600', allowances: '50.000', total: '650.000' });
  });

  it('hourly leave counts as a fraction of the working day and part-day requests may share a date', async () => {
    const annual = (await get('/leave/types', hr.token)).body.find((t: any) => t.key === 'UNPAID');
    const day2 = new Date(Date.now() + 41 * 86_400_000); const fri = day2.getUTCDay() === 5;
    const date = fri ? day(42) : day(41);
    const a = (await post('/me/leave/requests', other.token, { leaveTypeId: annual.id, startDate: date, endDate: date, startTime: '10:00', endTime: '12:00' }).expect(201)).body;
    expect(Number(a.hours)).toBe(2);
    expect(Number(a.days)).toBeCloseTo(0.25, 2); // 2 h of a 8 h day
    await post('/me/leave/requests', other.token, { leaveTypeId: annual.id, startDate: date, endDate: date, startTime: '11:00', endTime: '13:00' }).expect(409); // times overlap
    await post('/me/leave/requests', other.token, { leaveTypeId: annual.id, startDate: date, endDate: date, startTime: '13:00', endTime: '14:00' }).expect(201);
    await post('/me/leave/requests', other.token, { leaveTypeId: annual.id, startDate: date, endDate: date, startTime: '14:00', endTime: '13:00' }).expect(400);
    await post('/me/leave/requests', other.token, { leaveTypeId: annual.id, startDate: date, endDate: day(60), startTime: '09:00', endTime: '10:00' }).expect(400); // hours need a single date
  });

  it('leaving the branch geofence clocks an employee out; GPS noise does not', async () => {
    const branch = await prisma.raw.branch.create({ data: { tenantId: T.tenantId, legalEntityId: T.legalEntityId, code: 'GF', name: 'Fence', latitude: 31.95, longitude: 35.91, geofenceM: 100 } });
    const emp = await prisma.raw.employee.findFirstOrThrow({ where: { userId: other.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: emp.id, branchId: branch.id, isPrimary: true, validFrom: new Date('2025-01-01') } });
    await prisma.raw.timeEntry.create({ data: { tenantId: T.tenantId, employeeId: emp.id, branchId: branch.id, clockIn: new Date(Date.now() - 3_600_000), source: 'MOBILE', status: 'OPEN', createdBy: other.id } });
    expect((await post('/me/presence', other.token, { lat: 31.9503, lng: 35.91 }).expect(201)).body.clockedOut).toBe(false); // ~33 m: inside
    expect((await post('/me/presence', other.token, { lat: 31.9515, lng: 35.91, accuracy: 100 }).expect(201)).body.clockedOut).toBe(false); // ~166 m but +-100 m accuracy: not clearly outside
    const out = (await post('/me/presence', other.token, { lat: 31.96, lng: 35.91, accuracy: 10 }).expect(201)).body; // ~1.1 km
    expect(out.clockedOut).toBe(true);
    expect((await prisma.raw.timeEntry.findFirstOrThrow({ where: { employeeId: emp.id } })).status).not.toBe('OPEN');
  });
});
