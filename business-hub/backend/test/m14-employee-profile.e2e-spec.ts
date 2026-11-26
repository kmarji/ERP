import { INestApplication } from '@nestjs/common';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('M14 employee profile: new fields and photo', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { token: string; id: string }, scoped: { token: string }, mgr: { token: string };
  let branchId: string, positionId: string, otherPosition: string;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const patch = (path: string, token: string, body: object) => http.patch(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const photo = (id: string, token: string, data: Buffer, name = 'me.png') => http.post(`/employees/${id}/photo`).set(auth(token)).attach('file', data, name);
  const base = (over: object = {}) => ({ name: 'Profile Person', nationality: 'Jordanian', phone: '0791234567', legalEntityId: T.legalEntityId, branchId, positionId, hireDate: '2026-01-31', salaryBasic: 450, ...over });
  const create = async (over: object = {}) => (await post('/employees', hr.token, base(over)).expect(201)).body.id as string;
  const read = async (id: string, token = hr.token) => (await get(`/employees/${id}`, token).expect(200)).body;
  const profile = { gender: 'FEMALE', maritalStatus: 'SINGLE', workType: 'FULL_TIME', department: 'Operations', section: 'Front of house', workLocation: 'Abdoun' };

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm14');
    hr = await makeUser(http, T, 'hr', 'HR');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    scoped = await makeUser(http, T, 'bhr', 'HR', branchId);
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    const position = async (title: string) => (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title, titleAr: title, payBandMin: 300, payBandMax: 600 } })).id;
    positionId = await position('Waiter');
    otherPosition = await position('Barista');
  });
  afterAll(() => app.close());

  it('saves the new fields on create and patch, and clears them', async () => {
    const id = await create({ ...profile, probationMonths: 1 });
    expect(await read(id)).toMatchObject({ ...profile, probationMonths: 1, probationEnd: '2026-02-28', hasPhoto: false, employmentPeriod: { years: 0 } });
    await patch(`/employees/${id}`, hr.token, { department: 'Kitchen', section: '', gender: null, positionId: otherPosition, probationMonths: 2 }).expect(200);
    expect(await read(id)).toMatchObject({ department: 'Kitchen', section: null, gender: null, maritalStatus: 'SINGLE', positionId: otherPosition, probationEnd: '2026-03-31' });
    await patch(`/employees/${id}`, hr.token, { gender: 'X' }).expect(400);
    await patch(`/employees/${id}`, hr.token, { positionId: 'nope' }).expect(404);
    await patch(`/employees/${id}`, hr.token, { probationMonths: null }).expect(400);
  });

  it('keeps probation end when a new salary package is added', async () => {
    const id = await create();
    expect((await read(id)).probationEnd).toBe('2026-04-30');
    await post(`/employees/${id}/contracts`, hr.token, { effectiveDate: '2026-06-01', salaryBasic: 500 }).expect(201);
    expect((await read(id)).probationEnd).toBe('2026-04-30');
  });

  it('limits gender, marital status and job role to company-wide HR and keeps them from branch managers', async () => {
    const id = await create(profile);
    for (const body of [{ gender: 'MALE' }, { maritalStatus: 'MARRIED' }, { positionId: otherPosition }]) await patch(`/employees/${id}`, scoped.token, body).expect(403);
    await patch(`/employees/${id}`, scoped.token, { department: 'Bar' }).expect(200);
    await photo(id, hr.token, PNG).expect(201);
    const seen = await read(id, mgr.token);
    expect(seen).toMatchObject({ hasPhoto: true, department: 'Bar' });
    for (const key of ['gender', 'maritalStatus', 'photoKey', 'photoType']) expect(seen).not.toHaveProperty(key);
    const list = (await get(`/employees?branchId=${branchId}`, mgr.token).expect(200)).body;
    expect(JSON.stringify(list)).not.toMatch(/maritalStatus|photoKey|"gender"/);
  });

  it('stores a photo, checks the content and removes it', async () => {
    const id = await create();
    const url = `/employees/${id}/photo`;
    await get(url, hr.token).expect(404);
    await photo(id, scoped.token, PNG).expect(403);
    await photo(id, hr.token, Buffer.from('<svg onload=alert(1)>'), 'x.png').expect(400);
    await photo(id, hr.token, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])).expect(413);
    await photo(id, hr.token, PNG).expect(201);
    const got = await get(url, mgr.token).buffer(true).expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(got.body, PNG)).toBe(0);
    await http.delete(url).set(auth(scoped.token)).expect(403);
    await http.delete(url).set(auth(hr.token)).expect(200);
    await get(url, hr.token).expect(404);
    expect((await read(id)).hasPhoto).toBe(false);
  });

  it('names the job role and manager for viewers who cannot list positions or all employees', async () => {
    const boss = await create({ name: 'The Boss', login: { email: 'boss@x.test', password: 'Boss-pass-12345' } });
    const id = await create({ name: 'Reports Up', managerId: boss });
    const finance = await makeUser(http, T, 'fin', 'FINANCE');
    for (const token of [finance.token, mgr.token]) expect(await read(id, token)).toMatchObject({ positionTitle: 'Waiter', managerName: 'The Boss' });
  });

  it('does not return gender, marital status or the photo key from the hiring record', async () => {
    const id = await create(profile);
    await photo(id, hr.token, PNG).expect(201);
    const hired = await runWithTenant(T.tenantId, () => (app.get(OnboardingService) as any).employeeView(id));
    expect(hired).toMatchObject({ id, department: 'Operations' });
    for (const key of ['gender', 'maritalStatus', 'photoKey', 'photoType', 'sensitive']) expect(hired).not.toHaveProperty(key);
  });

  it('refuses an offer with more probation than the employee file allows', async () => {
    await post('/applications/none/offer', hr.token, { startDate: '2026-01-01', salaryBasic: 400, probationMonths: 30 }).expect(400);
  });
});
