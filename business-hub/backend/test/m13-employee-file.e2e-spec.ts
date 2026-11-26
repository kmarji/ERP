import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { ammanToday } from '../src/common/time';
import { WorkPermitService } from '../src/modules/people/work-permit.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M13 employee file: sensitive details, allowances, nationality, work permits', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { token: string; id: string };
  let branchId: string, positionId: string;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const patch = (path: string, token: string, body: object) => http.patch(path).set(auth(token)).send(body);
  const put = (path: string, token: string, body: object) => http.put(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const base = (over: object = {}) => ({ name: 'Maria Santos', nationality: 'Filipino', phone: '0791234567', legalEntityId: T.legalEntityId, branchId, positionId, hireDate: '2026-01-01', salaryBasic: 450, ...over });
  const create = async (over: object = {}) => (await post('/employees', hr.token, base(over)).expect(201)).body;
  const inDays = (n: number) => new Date(ammanToday().getTime() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm13');
    hr = await makeUser(http, T, 'hr', 'HR');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Cashier', titleAr: 'كاشير', payBandMin: 300, payBandMax: 600 } })).id;
  });
  afterAll(() => app.close());

  it('sensitive details can be added and amended one field at a time, without values in the audit trail', async () => {
    const e = await create();
    const url = `/employees/${e.id}/sensitive`;
    const full = { nationalId: '9901234567', dateOfBirth: '1990-05-01', address: 'Amman', iban: 'JO94 CBJO 0010 0000 0000 0131 0003 02' };
    await put(url, hr.token, full).expect(200);
    expect((await get(url, hr.token).expect(200)).body).toEqual({ ...full, iban: 'JO94CBJO0010000000000131000302' });
    await put(url, hr.token, { iban: 'jo71cbjo0000000000001234567890' }).expect(200);
    expect((await get(url, hr.token)).body).toEqual({ ...full, iban: 'JO71CBJO0000000000001234567890' });
    await put(url, hr.token, { address: '' }).expect(200);
    expect((await get(url, hr.token)).body.address).toBeUndefined();
    await put(url, hr.token, { iban: 'x!' }).expect(400);
    const bhr = await makeUser(http, T, 'bhr', 'HR', branchId);
    await put(url, bhr.token, { address: 'x' }).expect(403);
    const audit = await prisma.raw.auditEvent.findMany({ where: { tenantId: T.tenantId, action: 'employee.sensitive_changed', entityId: e.id } });
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit.map((a) => a.after))).toContain('iban');
    expect(JSON.stringify(audit)).not.toMatch(/JO94|JO71|9901234567/);
  });

  it('nationality is required and allowances land on the contract', async () => {
    await post('/employees', hr.token, base({ nationality: undefined })).expect(400);
    await post('/employees', hr.token, base({ allowances: [{ name: '', amount: 5 }] })).expect(400);
    const e = await create({ allowances: [{ name: 'Housing', amount: 50 }] });
    expect((await get(`/employees/${e.id}/contracts`, hr.token)).body[0].allowances).toEqual([{ name: 'Housing', amount: 50 }]);
  });

  it('work permit: incomplete badge, one alert per stage to HR, owner and the employee', async () => {
    const e = await create({ needsWorkPermit: true, login: { email: 'maria@x.test', password: 'Maria-pass-12345' } });
    const url = `/employees/${e.id}`;
    const sent = async () => (await prisma.raw.notification.findMany({ where: { tenantId: T.tenantId, title: { startsWith: 'Work permit of Maria' } } })).map((n) => n.roleKey ?? n.userId).sort();
    const everyone = ['HR', 'OWNER', e.userId].sort();
    expect((await get(url, hr.token)).body.permit).toEqual({ state: 'INCOMPLETE', daysLeft: null });
    expect(await sent()).toEqual([]);

    const update = { workPermitNumber: 'WP-77', workPermitExpiry: inDays(20) };
    expect((await patch(url, hr.token, update).expect(200)).body.id).toBe(e.id);
    expect((await get(url, hr.token)).body.permit).toEqual({ state: 'EXPIRING', daysLeft: 20 });
    expect(await sent()).toEqual(everyone);
    await patch(url, hr.token, update).expect(200);
    await runWithTenant(T.tenantId, () => app.get(WorkPermitService).alert());
    expect(await sent()).toEqual(everyone);

    await patch(url, hr.token, { workPermitExpiry: inDays(5) }).expect(200);
    expect(await sent()).toEqual([...everyone, ...everyone].sort());

    await patch(url, hr.token, { needsWorkPermit: false, workPermitNumber: 'ignored' }).expect(200);
    expect((await get(url, hr.token)).body).toMatchObject({ needsWorkPermit: false, workPermitNumber: null, workPermitExpiry: null, permit: null });
  });

  it('ignores permit values without the checkbox, skips leavers and hides the number from branch managers', async () => {
    const none = await create({ needsWorkPermit: false, workPermitNumber: 'WP-0', workPermitExpiry: inDays(3) });
    expect((await get(`/employees/${none.id}`, hr.token)).body).toMatchObject({ workPermitNumber: null, workPermitExpiry: null, permit: null });

    const gone = await create({ name: 'Gone Person', needsWorkPermit: true });
    await prisma.raw.employee.update({ where: { id: gone.id }, data: { status: 'TERMINATED', workPermitExpiry: new Date(`${inDays(3)}T00:00:00.000Z`) } });
    expect((await get(`/employees/${gone.id}`, hr.token)).body.permit).toBeNull();
    expect(await runWithTenant(T.tenantId, () => app.get(WorkPermitService).alert(gone.id))).toBe(0);

    const held = await create({ name: 'Held Permit', needsWorkPermit: true, workPermitNumber: 'WP-SECRET', workPermitExpiry: inDays(200) });
    const mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    const seen = (await get(`/employees?branchId=${branchId}`, mgr.token).expect(200)).body;
    expect(JSON.stringify(seen)).not.toMatch(/WP-SECRET|workPermitAlertStage/);
    expect((await get(`/employees/${held.id}`, mgr.token).expect(200)).body.workPermitNumber).toBeUndefined();
    expect((await get(`/employees/${held.id}`, hr.token)).body.workPermitNumber).toBe('WP-SECRET');
  });

  it('branch-scoped HR cannot change or wipe a permit it cannot see', async () => {
    const e = await create({ name: 'Locked Permit', needsWorkPermit: true, workPermitNumber: 'WP-9' });
    const scoped = await makeUser(http, T, 'bhr2', 'HR', branchId);
    for (const body of [{ needsWorkPermit: false }, { workPermitNumber: 'X' }, { workPermitExpiry: null }]) await patch(`/employees/${e.id}`, scoped.token, body).expect(403);
    await patch(`/employees/${e.id}`, scoped.token, { phone: '0790000000' }).expect(200);
    expect((await get(`/employees/${e.id}`, hr.token)).body).toMatchObject({ needsWorkPermit: true, workPermitNumber: 'WP-9' });
  });

  it('an allowance change is recorded in the audit trail', async () => {
    const e = await create({ name: 'Pay Change', allowances: [{ name: 'Housing', amount: 50 }] });
    await post(`/employees/${e.id}/contracts`, hr.token, { effectiveDate: '2026-06-01', salaryBasic: 450, allowances: [{ name: 'Laundry', amount: 10 }] }).expect(201);
    const a = await prisma.raw.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: 'employee.contract_changed', entityId: e.id } });
    expect(a.before).toMatchObject({ allowances: [{ name: 'Housing', amount: 50 }] });
    expect(a.after).toMatchObject({ allowances: [{ name: 'Laundry', amount: 10 }] });
  });
});
