import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { ActionsService } from '../src/modules/operations/actions.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M9c operations: audits, food safety, corrective actions', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, otherBranch: string;
  let mgr: { id: string; token: string }, mgrB: { token: string }, otherMgr: { token: string }, hr: { token: string };
  let ana: { id: string; token: string; empId: string }, zed: { id: string; token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const doc = (by: { id: string }) => prisma.raw.evidenceDocument.create({ data: { tenantId: T.tenantId, createdBy: by.id, storageKey: `k${Math.random()}`, filename: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1, sha256: `x${Math.random()}` } });

  async function employee(key: string, branch: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branch);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId: branch, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm9c');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    otherBranch = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    mgrB = await makeUser(http, T, 'mgrb', 'BRANCH_MANAGER', branchId);
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', otherBranch);
    hr = await makeUser(http, T, 'hr', 'HR');
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana', branchId);
    zed = await employee('zed', otherBranch);
  });
  afterAll(() => app.close());

  let tpl: any, audit: any;
  it('audit templates are scored, versioned and scoped', async () => {
    const items = [{ label: 'Hand-wash station stocked', weight: 2, critical: true }, { label: 'Floors clean', weight: 1 }, { label: 'Pest log signed', weight: 1, evidenceRequired: true }];
    await post('/ops/audit-templates', mgr.token, { name: 'Hygiene', items }).expect(403); // company-wide needs a company-wide role
    tpl = (await post('/ops/audit-templates', mgr.token, { name: 'Hygiene', branchId, passPercent: 70, items }).expect(201)).body;
    expect(tpl.version).toBe(1);
    expect((await get('/ops/audit-templates', otherMgr.token).expect(200)).body).toEqual([]);
    await post('/ops/audit-templates', otherMgr.token, { code: tpl.code, name: 'Hygiene', items }).expect(403); // cannot version another branch's template
    await post('/ops/audit-templates', mgr.token, { code: tpl.code, name: 'Hygiene', branchId: otherBranch, items }).expect(400); // nor move it
    const keep = (await post('/ops/audit-templates', mgr.token, { code: tpl.code, name: 'Hygiene', items }).expect(201)).body;
    expect(keep.branchId).toBe(branchId); // versioning without a branch keeps the scope
    tpl = keep;
    const wide = (await post('/ops/audit-templates', hr.token, { name: 'Company-wide', items }).expect(201)).body;
    await post('/ops/audit-templates', mgr.token, { code: wide.code, name: 'Company-wide', items }).expect(403); // branch manager cannot version a company-wide one
    await post('/ops/audits', otherMgr.token, { templateId: tpl.id, branchId }).expect(403);
  });

  it('completing an audit scores it, enforces evidence and turns each failure into a corrective action', async () => {
    audit = (await post('/ops/audits', mgr.token, { templateId: tpl.id, branchId }).expect(201)).body;
    const [wash, floor, pest] = tpl.items;
    await post(`/ops/audits/${audit.id}/complete`, mgrB.token, { answers: [] }).expect(403); // not the auditor
    await post(`/ops/audits/${audit.id}/complete`, mgr.token, { answers: [{ itemId: wash.id, result: 'PASS' }] }).expect(400); // incomplete
    await post(`/ops/audits/${audit.id}/complete`, mgr.token, { answers: [{ itemId: wash.id, result: 'FAIL' }, { itemId: floor.id, result: 'PASS' }, { itemId: pest.id, result: 'NA' }] }).expect(400); // fail needs a note
    await post(`/ops/audits/${audit.id}/complete`, mgr.token, { answers: [{ itemId: wash.id, result: 'PASS' }, { itemId: floor.id, result: 'PASS' }, { itemId: pest.id, result: 'PASS' }] }).expect(400); // evidence missing
    const d = await doc(mgr);
    const done = (await post(`/ops/audits/${audit.id}/complete`, mgr.token, { answers: [{ itemId: wash.id, result: 'FAIL', note: 'No soap' }, { itemId: floor.id, result: 'PASS' }, { itemId: pest.id, result: 'PASS', docId: d.id }] }).expect(201)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', scorePct: 50, passed: false, criticalFails: 1 }); // (1+1)/(2+1+1)
    expect(done.results.find((r: any) => r.itemId === wash.id).actionId).toBeTruthy();
    const { actions } = (await get(`/ops/audits/${audit.id}`, mgr.token).expect(200)).body;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ severity: 'CRITICAL', source: 'AUDIT', status: 'OPEN' });
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'OPS_AUDIT_CRITICAL' } })).toBe(1);
    await post(`/ops/audits/${audit.id}/complete`, mgr.token, { answers: [] }).expect(409);
  });

  it('corrective action: assign in-branch, evidence, independent and authorized closure', async () => {
    const act = (await get(`/ops/actions?source=AUDIT`, mgr.token).expect(200)).body[0];
    await post(`/ops/actions/${act.id}/assign`, mgr.token, { employeeId: zed.empId }).expect(400); // other branch
    await post(`/ops/actions/${act.id}/assign`, otherMgr.token, { employeeId: ana.empId }).expect(403);
    expect((await post(`/ops/actions/${act.id}/assign`, mgr.token, { employeeId: ana.empId }).expect(201)).body.status).toBe('IN_PROGRESS');
    await post(`/me/actions/${act.id}/complete`, zed.token, { note: 'done', docIds: [] }).expect(403); // not theirs
    await post(`/me/actions/${act.id}/complete`, ana.token, { note: 'Soap installed', docIds: [] }).expect(400); // no evidence
    const d = await doc(ana);
    expect((await post(`/me/actions/${act.id}/complete`, ana.token, { note: 'Soap installed', docIds: [d.id] }).expect(201)).body.status).toBe('PENDING_VERIFICATION');
    await post(`/ops/actions/${act.id}/cancel`, mgr.token, { reason: 'not needed' }).expect(403); // audit finding: company-wide role only
    await post(`/ops/actions/${act.id}/verify`, mgr.token, { approve: true }).expect(403); // CRITICAL: company-wide role only
    expect((await post(`/ops/actions/${act.id}/verify`, mgr.token, { approve: false, note: 'Photo unclear' }).expect(201)).body.status).toBe('IN_PROGRESS');
    await post(`/me/actions/${act.id}/complete`, ana.token, { note: 'Retaken', docIds: [d.id] }).expect(201);
    const closed = (await post(`/ops/actions/${act.id}/verify`, hr.token, { approve: true }).expect(201)).body;
    expect(closed.status).toBe('CLOSED');
    expect(closed.history.map((h: any) => h.event)).toEqual(['created', 'assigned', 'completed', 'rejected', 'completed', 'closed']);
  });

  let point: any;
  it('food safety: in-range is quiet, a breach raises one exception and one action, closure needs a good reading', async () => {
    await post('/ops/food-safety/points', mgr.token, { branchId, name: 'Fridge 1', kind: 'FRIDGE' }).expect(400); // needs a bound
    await post('/ops/food-safety/points', otherMgr.token, { branchId, name: 'xx', kind: 'FRIDGE', maxValue: 5 }).expect(403);
    point = (await post('/ops/food-safety/points', mgr.token, { branchId, name: 'Fridge 1', kind: 'FRIDGE', minValue: 0, maxValue: 5 }).expect(201)).body;
    expect((await get('/me/food-safety/points', ana.token).expect(200)).body.map((p: any) => p.id)).toEqual([point.id]);
    expect((await get('/me/food-safety/points', zed.token).expect(200)).body).toEqual([]);
    await post('/me/food-safety/readings', zed.token, { pointId: point.id, value: 3 }).expect(403); // other branch
    expect((await post('/me/food-safety/readings', ana.token, { pointId: point.id, value: 3.5 }).expect(201)).body.inRange).toBe(true);
    expect(await prisma.raw.correctiveAction.count({ where: { tenantId: T.tenantId, source: 'FOOD_SAFETY' } })).toBe(0);
    const bad = (await post('/me/food-safety/readings', ana.token, { pointId: point.id, value: 8.5, note: 'Door left open' }).expect(201)).body;
    expect(bad).toMatchObject({ inRange: false });
    await post('/me/food-safety/readings', ana.token, { pointId: point.id, value: 9 }).expect(201); // repeat
    expect(await prisma.raw.correctiveAction.count({ where: { tenantId: T.tenantId, source: 'FOOD_SAFETY' } })).toBe(1);
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'OPS_FOOD_SAFETY' } })).toBe(1);
    const act = await prisma.raw.correctiveAction.findFirstOrThrow({ where: { tenantId: T.tenantId, source: 'FOOD_SAFETY' } });
    expect((act.history as any[]).map((h) => h.event)).toEqual(['created', 'repeat_breach']);
    await post(`/ops/actions/${act.id}/assign`, mgr.token, { employeeId: ana.empId }).expect(201);
    const d = await doc(ana);
    await post(`/me/actions/${act.id}/complete`, ana.token, { note: 'Fridge serviced', docIds: [d.id] }).expect(201);
    await post(`/ops/actions/${act.id}/verify`, mgr.token, { approve: true }).expect(409); // no good reading yet
    await post('/me/food-safety/readings', ana.token, { pointId: point.id, value: 4 }).expect(201);
    expect((await post(`/ops/actions/${act.id}/verify`, mgr.token, { approve: true }).expect(201)).body.status).toBe('CLOSED');
    expect((await get(`/ops/food-safety/readings?outOfRange=1`, mgr.token).expect(200)).body).toHaveLength(2);
    expect((await get(`/ops/food-safety/readings`, otherMgr.token).expect(200)).body).toEqual([]);
  });

  it('overdue actions raise one exception', async () => {
    const a = (await post('/ops/actions', mgr.token, { branchId, title: 'Fix door seal', severity: 'MEDIUM', dueAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)).body;
    expect((await post(`/ops/actions/${a.id}/cancel`, mgr.token, { reason: 'duplicate' }).expect(201)).body.status).toBe('CANCELLED'); // manual, non-critical: a branch manager may
    const b = (await post('/ops/actions', mgr.token, { branchId, title: 'Fix door seal again', severity: 'MEDIUM', dueAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201)).body;
    await prisma.raw.correctiveAction.update({ where: { id: b.id }, data: { dueAt: new Date(Date.now() - 3_600_000) } });
    const sweep = () => runWithTenant(T.tenantId, () => app.get(ActionsService).sweep());
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'OPS_ACTION_OVERDUE' } })).toBe(1);
  });
});
