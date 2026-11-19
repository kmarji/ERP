import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M8d feedback: shift templates, rest override, warning ladder, deductions, attachments', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, mgr: { token: string; id: string }, hr: { token: string; id: string }, empId: string;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm8d');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    hr = await makeUser(http, T, 'hr', 'HR');
    const position = await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: 'EMP-d1', legalEntityId: T.legalEntityId, name: 'dana', phone: '0790000001', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    await prisma.raw.employmentContract.create({ data: { tenantId: T.tenantId, employeeId: e.id, version: 1, type: 'PERMANENT', startDate: new Date('2025-01-01'), salaryBasic: 600, weeklyHours: 48 } });
    empId = e.id;
  });
  afterAll(() => app.close());

  it('a branch sees its own shift templates and the company-wide ones', async () => {
    const all = (await post('/shift-templates', T.token, { name: 'All-day', startTime: '08:00', endTime: '16:00' }).expect(201)).body;
    const own = (await post('/shift-templates', mgr.token, { branchId, name: 'Abdoun-day', startTime: '09:00', endTime: '17:00' }).expect(201)).body;
    const other = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    const elsewhere = (await post('/shift-templates', T.token, { branchId: other, name: 'Irbid-day', startTime: '09:00', endTime: '17:00' }).expect(201)).body;
    const ids = (await get(`/shift-templates?branchId=${branchId}`, mgr.token).expect(200)).body.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining([all.id, own.id]));
    expect(ids).not.toContain(elsewhere.id);
  });

  it('short rest blocks a shift unless the manager overrides with a recorded reason', async () => {
    const d = day(20);
    const shift = (start: string, end: string, extra: object = {}) => ({ employeeId: empId, branchId, date: d, startAt: `${d}T${start}:00Z`, endAt: `${d}T${end}:00Z`, ...extra });
    await post('/schedules', mgr.token, shift('06:00', '12:00')).expect(201);
    const second = shift('16:00', '20:00');
    expect((await post('/schedules', mgr.token, second).expect(409)).body.message).toMatch(/hours of rest/);
    await post('/schedules', mgr.token, { ...second, overrideRestReason: 'x' }).expect(400);
    const row = (await post('/schedules', mgr.token, { ...second, overrideRestReason: 'Event cover, employee agreed' }).expect(201)).body;
    expect(row.restOverrideReason).toBe('Event cover, employee agreed');
    expect(await prisma.raw.auditEvent.count({ where: { tenantId: T.tenantId, action: 'schedule.published', entityId: row.id } })).toBe(1);
    // an overlap is still refused: only rest can be overridden
    await post('/schedules', mgr.token, { ...shift('18:00', '22:00'), overrideRestReason: 'Event cover again' }).expect(409);
  });

  it('the warning ladder is company-defined, suggests the next step, and any action can carry a deduction', async () => {
    expect((await get('/discipline/actions', hr.token).expect(200)).body.map((a: any) => a.key)).toEqual(expect.arrayContaining(['VERBAL', 'WRITTEN', 'FINAL', 'FINE']));
    await post('/discipline/actions', mgr.token, { key: 'x', label: 'x' }).expect(403);
    await post('/discipline/actions', hr.token, { key: 'last chance', label: 'Last chance letter', step: 4 }).expect(201);
    expect((await get(`/discipline/suggest?employeeId=${empId}`, hr.token).expect(200)).body).toMatchObject({ priorWarnings: 0, suggested: 'VERBAL' });
    const run = async (sanction: string, extra: object = {}, token = hr.token) => {
      const c = (await post('/discipline/cases', mgr.token, { employeeId: empId, category: 'CONDUCT', description: 'Late to the pass again', incidentDate: day(-1) }).expect(201)).body;
      await post(`/discipline/cases/${c.id}/review`, hr.token).expect(201);
      return { c, res: await post(`/discipline/cases/${c.id}/decide`, token, { sanction, ...extra }) };
    };
    expect((await run('MADE_UP')).res.status).toBe(400);
    expect((await run('VERBAL')).res.status).toBe(201);
    expect((await get(`/discipline/suggest?employeeId=${empId}`, hr.token).expect(200)).body).toMatchObject({ priorWarnings: 1, suggested: 'WRITTEN' });
    // a deduction on a warning: OWNER only, needs a basis, stays under the cap (600/30 = 20)
    expect((await run('WRITTEN', { fineAmount: 10, legalBasis: 'Policy 4.2' })).res.status).toBe(403);
    expect((await run('WRITTEN', { fineAmount: 10 }, T.token)).res.status).toBe(400);
    expect((await run('WRITTEN', { fineAmount: 25, legalBasis: 'Policy 4.2' }, T.token)).res.status).toBe(400);
    const ok = await run('WRITTEN', { fineAmount: 15, legalBasis: 'Policy 4.2' }, T.token);
    expect(ok.res.status).toBe(201);
    await post(`/discipline/cases/${ok.c.id}/notify`, hr.token).expect(201);
    const adj = await prisma.raw.payrollAdjustment.findFirst({ where: { tenantId: T.tenantId, sourceRef: `discipline:${ok.c.id}` } });
    expect(Number(adj?.amount)).toBe(15);
    expect((await get(`/discipline/suggest?employeeId=${empId}`, hr.token).expect(200)).body).toMatchObject({ priorWarnings: 2, suggested: 'FINAL' });
  });

  it('training material and checklists accept uploaded files of any format', async () => {
    const up = async (name: string, type: string) => (await http.post('/documents').set(auth(T.token)).attach('file', Buffer.from('content'), { filename: name, contentType: type }).expect(201)).body.id as string;
    const pdf = await up('onboarding.pdf', 'application/pdf');
    const vid = await up('barista.mp4', 'video/mp4');
    await post('/ops/library', T.token, { kind: 'TRAINING', title: 'Espresso', body: 'x', attachmentIds: ['nope'] }).expect(400);
    await post('/ops/library', T.token, { kind: 'TRAINING', title: 'Espresso', body: '' }).expect(400); // neither text nor file
    const v1 = (await post('/ops/library', T.token, { kind: 'TRAINING', title: 'Espresso', body: '', attachmentIds: [pdf, vid] }).expect(201)).body;
    expect(v1.attachments.map((a: any) => a.filename)).toEqual(['onboarding.pdf', 'barista.mp4']);
    const v2 = (await post('/ops/library', T.token, { code: v1.code, kind: 'TRAINING', title: 'Espresso', body: 'Grind, dose, tamp, pull.' }).expect(201)).body;
    expect(v2.attachments).toHaveLength(2); // a new version keeps the files unless replaced
    const t = (await post('/ops/checklist-templates', T.token, { name: 'Opening', attachmentIds: [pdf], items: [{ label: 'Unlock the door' }] }).expect(201)).body;
    expect(t.attachments[0].filename).toBe('onboarding.pdf');
    await post('/ops/checklist-templates', T.token, { name: 'Closing', attachmentIds: ['nope'], items: [{ label: 'Lock up' }] }).expect(400);
  });

  it('nobody handles a discipline case about themselves, and exam takers cannot read the answer key', async () => {
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const staff = async (name: string, userId: string) => {
      const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${name}`, legalEntityId: T.legalEntityId, userId, name, phone: `0790${Math.floor(Math.random() * 1e6)}`, status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
      await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
      await prisma.raw.employmentContract.create({ data: { tenantId: T.tenantId, employeeId: e.id, version: 1, type: 'PERMANENT', startDate: new Date('2025-01-01'), salaryBasic: 600, weeklyHours: 48 } });
      return e.id;
    };
    const hrEmp = await staff('hrself', hr.id);
    const c = (await post('/discipline/cases', mgr.token, { employeeId: hrEmp, category: 'CONDUCT', description: 'A case about the HR officer', incidentDate: day(-1) }).expect(201)).body;
    await post(`/discipline/cases/${c.id}/review`, hr.token).expect(403);
    await post(`/discipline/cases/${c.id}/review`, T.token).expect(201); // someone else handles it
    await post(`/discipline/cases/${c.id}/decide`, hr.token, { sanction: 'NONE' }).expect(403);

    const mgrEmp = await staff('mgrself', mgr.id);
    const item = (await post('/ops/library', T.token, { kind: 'TRAINING', title: 'Cash handling', body: 'Count the till twice.' }).expect(201)).body;
    const a = await prisma.raw.trainingAssignment.create({ data: { tenantId: T.tenantId, employeeId: mgrEmp, title: item.title, libraryItemId: item.id, itemCode: item.code, status: 'FAILED' } });
    await get(`/ops/library/${item.code}/questions`, mgr.token).expect(403); // sitting this exam
    await get(`/ops/library/${item.code}/questions`, T.token).expect(200);
    await post(`/ops/training/${a.id}/reset`, mgr.token).expect(403); // not for yourself
    await post(`/ops/training/${a.id}/reset`, T.token).expect(201);
    await get('/ops/evaluations', T.token).expect(400);
  });
});
