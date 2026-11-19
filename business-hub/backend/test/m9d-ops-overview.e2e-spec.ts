import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M9d operations: dashboard, reports, settings, notifications, offline', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, otherBranch: string;
  let mgr: { token: string }, otherMgr: { token: string }, hr: { token: string };
  let ana: { token: string; empId: string }, bob: { token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));

  async function employee(key: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm9d');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    otherBranch = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', otherBranch);
    hr = await makeUser(http, T, 'hr', 'HR');
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana');
    bob = await employee('bob');
  });
  afterAll(() => app.close());

  it('notifications reach the employee, and only the owner can mark one read', async () => {
    const tpl = (await post('/ops/checklist-templates', mgr.token, { name: 'Close', branchId, items: [{ label: 'Lights off' }] }).expect(201)).body;
    await post('/ops/checklist-runs', mgr.token, { templateId: tpl.id, employeeId: ana.empId, branchId, dueAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'tonight' }).expect(201);
    const mine = (await get('/notifications', ana.token).expect(200)).body;
    expect(mine.map((n: any) => n.title)).toContain('Checklist requested: Close');
    expect((await get('/notifications', bob.token).expect(200)).body).toEqual([]);
    const n = mine.find((x: any) => x.title.startsWith('Checklist requested'));
    await post(`/notifications/${n.id}/read`, bob.token).expect(201);
    expect((await prisma.raw.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull(); // not bob's
    await post(`/notifications/${n.id}/read`, ana.token).expect(201);
    expect((await prisma.raw.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull();
  });

  it('offline submissions keep the device time for lateness only when it is plausible', async () => {
    const tpl = (await post('/ops/checklist-templates', mgr.token, { name: 'Offline', branchId, items: [{ label: 'Done' }] }).expect(201)).body;
    const run = async () => {
      const r = (await post('/ops/checklist-runs', mgr.token, { templateId: tpl.id, employeeId: bob.empId, branchId, dueAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(201)).body;
      await prisma.raw.checklistRun.update({ where: { id: r.id }, data: { dueAt: new Date(r.createdAt.valueOf ? r.createdAt : new Date(r.createdAt).getTime() + 1000) } });
      return r;
    };
    const r1 = await run();
    await new Promise((res) => setTimeout(res, 1100)); // the server clock is now past the due time
    const itemId = (await get(`/me/checklists/${r1.id}`, bob.token).expect(200)).body.template.items[0].id;
    const ok = (await post(`/me/checklists/${r1.id}/submit`, bob.token, { answers: [{ itemId, ok: true }], completedAt: r1.createdAt }).expect(201)).body;
    expect(ok.completedLate).toBe(false); // done at the device time, before the due time
    const r2 = await run();
    await new Promise((res) => setTimeout(res, 1100));
    const late = (await post(`/me/checklists/${r2.id}/submit`, bob.token, { answers: [{ itemId, ok: true }], completedAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)).body;
    expect(late.completedLate).toBe(true); // a future timestamp is ignored
  });

  it('dashboard is branch-scoped and counts what the detail screens hold', async () => {
    await post('/ops/actions', mgr.token, { branchId, title: '=HYPERLINK("http://x")', severity: 'HIGH', dueAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
    const pt = (await post('/ops/food-safety/points', mgr.token, { branchId, name: 'Fridge', kind: 'FRIDGE', maxValue: 5 }).expect(201)).body;
    await post('/ops/food-safety/readings', mgr.token, { pointId: pt.id, value: 9 }).expect(201);
    const d = (await get('/ops/dashboard', mgr.token).expect(200)).body;
    expect(d.branches.map((b: any) => b.name)).toEqual(['Abdoun']);
    expect(d.branches[0].foodSafety.breaches7d).toBe(1);
    expect(d.branches[0].actions.open).toBe(2); // the manual one and the food-safety breach
    expect(d.totals.breaches7d).toBe(1);
    expect((await get('/ops/dashboard', otherMgr.token).expect(200)).body.branches.map((b: any) => b.name)).toEqual(['Irbid']);
    expect((await get('/ops/dashboard', hr.token).expect(200)).body.branches).toHaveLength(2);
    await get(`/ops/dashboard?branchId=${branchId}`, otherMgr.token).expect(403);
  });

  it('reports are scoped, exportable as CSV, and safe against spreadsheet formulas', async () => {
    await get('/ops/reports/nonsense', mgr.token).expect(400);
    const rows = (await get('/ops/reports/actions', mgr.token).expect(200)).body;
    expect(rows).toHaveLength(2);
    expect((await get('/ops/reports/actions', otherMgr.token).expect(200)).body).toEqual([]);
    await get(`/ops/reports/actions?branchId=${branchId}`, otherMgr.token).expect(403);
    const csv = (await get('/ops/reports/actions?format=csv', mgr.token).expect(200)).text;
    expect(csv.split('\n')[0]).toContain('number,branch,source');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`); // formula neutralised
    for (const k of ['checklists', 'audits', 'training', 'food-safety']) await get(`/ops/reports/${k}`, mgr.token).expect(200);
    expect((await get('/ops/reports/food-safety', mgr.token).expect(200)).body[0]).toMatchObject({ point: 'Fridge', inRange: false });
  });

  it('A60 settings: generated action due dates come from the ops.settings policy', async () => {
    await prisma.raw.policy.upsert({ where: { tenantId_key_version: { tenantId: T.tenantId, key: 'ops.settings', version: 1 } }, create: { tenantId: T.tenantId, key: 'ops.settings', version: 1, riskTier: 'LOW', rules: { criticalActionDays: 1, actionDays: 2, foodSafetyActionHours: 24 }, active: true }, update: { rules: { criticalActionDays: 1, actionDays: 2, foodSafetyActionHours: 24 }, active: true } });
    const tpl = (await post('/ops/audit-templates', mgr.token, { name: 'Quick', branchId, items: [{ label: 'Exit lit', critical: true }] }).expect(201)).body;
    const a = (await post('/ops/audits', mgr.token, { templateId: tpl.id, branchId }).expect(201)).body;
    await post(`/ops/audits/${a.id}/complete`, mgr.token, { answers: [{ itemId: tpl.items[0].id, result: 'FAIL', note: 'dark' }] }).expect(201);
    const act = await prisma.raw.correctiveAction.findFirstOrThrow({ where: { tenantId: T.tenantId, source: 'AUDIT', sourceId: a.id } });
    const days = (act.dueAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(0.9);
    expect(days).toBeLessThan(1.1); // 1 day, not the default 3
  });
});
