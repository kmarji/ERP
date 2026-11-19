import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M8b open shifts, no-show coverage, geofence, colleagues', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, mgr: { token: string }, ana: { token: string; empId: string }, bob: { token: string; empId: string }, carl: { token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const H = 3_600_000;

  async function employee(key: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm8b');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana');
    bob = await employee('bob');
    carl = await employee('carl');
  });
  afterAll(() => app.close());

  it('lists only branch colleagues, never self', async () => {
    const r = (await get('/me/colleagues', ana.token).expect(200)).body;
    expect(r.map((c: any) => c.id)).toEqual(expect.arrayContaining([bob.empId]));
  });

  it('geofence blocks a self punch from far away and needs a shift', async () => {
    await post(`/branches/${branchId}/geofence`, T.token, { latitude: 31.95, longitude: 35.91, radiusM: 100 }).expect(201);
    const now = new Date();
    await prisma.raw.shiftSchedule.create({ data: { tenantId: T.tenantId, employeeId: ana.empId, branchId, date: new Date(now.toISOString().slice(0, 10)), startAt: new Date(now.getTime() - H / 2), endAt: new Date(now.getTime() + 4 * H), createdBy: 'x' } });
    await post('/me/clock-in', ana.token, { branchId }).expect(400); // no location
    await post('/me/clock-in', ana.token, { branchId, lat: 32.5, lng: 35.9 }).expect(403); // ~60 km away
    await post('/me/clock-in', ana.token, { branchId, lat: 31.9501, lng: 35.9101 }).expect(201);
  });

  it('open shift: only eligible staff see it, the manager assigns one, the rest are rejected', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(6, 0, 0, 0);
    const o = (await post('/open-shifts', mgr.token, { branchId, date: start.toISOString(), startAt: start.toISOString(), endAt: new Date(start.getTime() + 8 * H).toISOString() }).expect(201)).body;
    expect((await get('/me/open-shifts', bob.token).expect(200)).body.map((x: any) => x.id)).toContain(o.id);
    const otherBranch = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B9', name: 'Irbid' }).expect(201)).body.id;
    const outsider = await makeUser(http, T, 'mgr9', 'BRANCH_MANAGER', otherBranch);
    expect((await get('/open-shifts', outsider.token).expect(200)).body).toEqual([]); // not this branch's shifts
    await get(`/open-shifts?branchId=${branchId}`, outsider.token).expect(403);
    expect((await get('/open-shifts', mgr.token).expect(200)).body.map((x: any) => x.id)).toContain(o.id);
    await post(`/me/open-shifts/${o.id}/request`, bob.token).expect(201);
    await post(`/me/open-shifts/${o.id}/request`, bob.token).expect(409); // duplicate
    await post(`/me/open-shifts/${o.id}/request`, ana.token).expect(201);
    await post(`/open-shifts/${o.id}/assign`, bob.token, { employeeId: bob.empId }).expect(403);
    await post(`/open-shifts/${o.id}/assign`, mgr.token, { employeeId: bob.empId }).expect(201);
    const rows = await prisma.raw.openShiftRequest.findMany({ where: { openShiftId: o.id } });
    expect(rows.find((r) => r.employeeId === ana.empId)?.status).toBe('REJECTED');
    await post(`/open-shifts/${o.id}/assign`, mgr.token, { employeeId: ana.empId }).expect(409); // already filled
    expect((await get('/me/open-shifts', ana.token).expect(200)).body.map((x: any) => x.id)).not.toContain(o.id);
  });

  it('no-show: flagged once, replacement suggested and authorized, original kept', async () => {
    const start = new Date(Date.now() - 2 * H);
    const s = await prisma.raw.shiftSchedule.create({ data: { tenantId: T.tenantId, employeeId: bob.empId, branchId, date: new Date(start.toISOString().slice(0, 10)), startAt: start, endAt: new Date(start.getTime() + 6 * H), createdBy: 'x' } });
    expect((await post('/schedules/flag-no-shows', mgr.token).expect(201)).body.flagged).toBeGreaterThanOrEqual(1);
    expect((await post('/schedules/flag-no-shows', mgr.token).expect(201)).body.flagged).toBe(0); // idempotent
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'ATT_NO_SHOW' } })).toBe(1);
    const cands = (await get(`/schedules/${s.id}/coverage-candidates`, mgr.token).expect(200)).body;
    expect(cands.map((c: any) => c.employeeId)).not.toContain(bob.empId);
    await post(`/schedules/${s.id}/cover`, mgr.token, { employeeId: bob.empId }).expect(400);
    expect(cands.map((c: any) => c.employeeId)).toContain(carl.empId);
    await post(`/schedules/${s.id}/cover`, mgr.token, { employeeId: carl.empId }).expect(201);
    expect((await prisma.raw.shiftSchedule.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('CANCELLED');
  });
});
