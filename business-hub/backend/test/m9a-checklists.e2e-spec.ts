import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { ChecklistsService } from '../src/modules/operations/checklists.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M9a operations: checklists', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, mgr: { token: string }, otherMgr: { token: string }, ana: { id: string; token: string; empId: string }, bob: { id: string; token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const sweep = (at?: Date) => runWithTenant(T.tenantId, () => app.get(ChecklistsService).sweep(at));

  async function employee(key: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm9a');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    const b2 = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', b2);
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana');
    bob = await employee('bob');
  });
  afterAll(() => app.close());

  let tpl: any;
  it('templates are versioned and a branch manager cannot create company-wide ones', async () => {
    const items = [{ label: 'Fridge below 5C', critical: true }, { label: 'Photo of prep area', evidenceRequired: true }, { label: 'Floor clean' }];
    await post('/ops/checklist-templates', mgr.token, { name: 'Opening', items }).expect(403);
    tpl = (await post('/ops/checklist-templates', mgr.token, { name: 'Opening', branchId, items }).expect(201)).body;
    expect(tpl).toMatchObject({ version: 1, active: true });
    await post('/ops/checklist-templates', otherMgr.token, { code: tpl.code, name: 'Opening', items }).expect(403); // another branch's manager cannot version it
    const v2 = (await post('/ops/checklist-templates', mgr.token, { code: tpl.code, name: 'Opening', branchId, items }).expect(201)).body;
    expect(v2.version).toBe(2);
    const v3 = (await post('/ops/checklist-templates', mgr.token, { code: tpl.code, name: 'Opening', items }).expect(201)).body; // no branchId in the body
    expect(v3.branchId).toBe(branchId); // the branch scope is kept, never widened to company-wide
    expect((await get('/ops/checklist-templates', otherMgr.token).expect(200)).body).toEqual([]);
    tpl = v3;
    expect((await get('/ops/checklist-templates', mgr.token).expect(200)).body.map((t: any) => t.id)).toEqual([v3.id]);
    await post('/ops/checklist-templates', mgr.token, { name: 'Empty', branchId, items: [] }).expect(400);
  });

  it('recurring: one run per day, branch scope on assignment, overdue raises one exception', async () => {
    await post('/ops/checklist-assignments', otherMgr.token, { templateId: tpl.id, employeeId: ana.empId, branchId, recurrence: 'DAILY', dueTime: '23:59' }).expect(403);
    await post('/ops/checklist-assignments', mgr.token, { templateId: tpl.id, employeeId: ana.empId, branchId, recurrence: 'DAILY', dueTime: '23:59' }).expect(201);
    expect((await sweep()).created).toBe(1);
    expect((await sweep()).created).toBe(0); // idempotent per day
    const mine = (await get('/me/checklists', ana.token).expect(200)).body;
    expect(mine).toHaveLength(1);
    expect((await get('/me/checklists', bob.token).expect(200)).body).toHaveLength(0);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    expect((await sweep(tomorrow)).overdue).toBe(1); // yesterday's run is now late
    expect((await sweep(tomorrow)).overdue).toBe(0);
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'OPS_CHECKLIST_OVERDUE' } })).toBe(1);
  });

  it('execution needs every answer and evidence; a critical failure escalates; resubmits are idempotent', async () => {
    const run = (await post('/ops/checklist-runs', mgr.token, { templateId: tpl.id, employeeId: bob.empId, branchId, dueAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'spot check' }).expect(201)).body;
    const { template } = (await get(`/me/checklists/${run.id}`, bob.token).expect(200)).body;
    await get(`/me/checklists/${run.id}`, ana.token).expect(404); // someone else's
    const [fridge, photo, floor] = template.items;
    await post(`/me/checklists/${run.id}/submit`, bob.token, { answers: [{ itemId: fridge.id, ok: false }] }).expect(400); // incomplete
    await post(`/me/checklists/${run.id}/submit`, bob.token, { answers: [{ itemId: fridge.id, ok: false }, { itemId: photo.id, ok: true }, { itemId: floor.id, ok: true }] }).expect(400); // evidence missing
    const doc = await prisma.raw.evidenceDocument.create({ data: { tenantId: T.tenantId, createdBy: bob.id, storageKey: 'k', filename: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1, sha256: 'x' } });
    const answers = [{ itemId: fridge.id, ok: false, note: '9C' }, { itemId: photo.id, ok: true, docId: doc.id }, { itemId: floor.id, ok: true }];
    const done = (await post(`/me/checklists/${run.id}/submit`, bob.token, { answers, completedAt: new Date().toISOString() }).expect(201)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', criticalFailures: 1 });
    expect((await post(`/me/checklists/${run.id}/submit`, bob.token, { answers }).expect(201)).body.alreadySubmitted).toBe(true); // offline retry
    expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'OPS_CRITICAL_FAILURE' } })).toBe(1);
    await post(`/ops/checklist-runs/${run.id}/review`, otherMgr.token).expect(403);
    expect((await post(`/ops/checklist-runs/${run.id}/review`, mgr.token).expect(201)).body.status).toBe('REVIEWED');
  });

  it('assignments and templates are not visible across branches', async () => {
    expect((await get('/ops/checklist-assignments', mgr.token).expect(200)).body).toHaveLength(1);
    expect((await get('/ops/checklist-assignments', otherMgr.token).expect(200)).body).toEqual([]);
    await get(`/ops/checklist-assignments?branchId=${branchId}`, otherMgr.token).expect(403);
    expect((await get('/ops/checklist-templates', otherMgr.token).expect(200)).body).toEqual([]); // the Abdoun template is branch-only
    expect((await get('/ops/checklist-templates', mgr.token).expect(200)).body).toHaveLength(1);
  });

  it('monitor summarizes the branch and is branch-scoped', async () => {
    const m = (await get(`/ops/monitor?branchId=${branchId}`, mgr.token).expect(200)).body;
    expect(m).toMatchObject({ total: 3, overdue: 1, criticalFailures: 1 });
    await get(`/ops/monitor?branchId=${branchId}`, otherMgr.token).expect(403);
    expect((await get('/ops/monitor', otherMgr.token).expect(200)).body.total).toBe(0);
  });
});
