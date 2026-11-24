import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M11 employee accounts: create employee with login, roles, password reset', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { token: string; id: string };
  let branchId: string, positionId: string;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));
  const signIn = (email: string, password: string) => http.post('/auth/login').send({ tenant: T.slug, email, password });
  const base = () => ({ name: 'Sara Nasser', phone: '0791234567', legalEntityId: T.legalEntityId, branchId, positionId, hireDate: '2026-01-01', salaryBasic: 450 });

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm11');
    hr = await makeUser(http, T, 'hr', 'HR');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Cashier', titleAr: 'كاشير', payBandMin: 300, payBandMax: 600 } })).id;
  });
  afterAll(() => app.close());

  it('HR creates an employee with a working login, and the portal profile resolves', async () => {
    const e = (await post('/employees', hr.token, { ...base(), login: { email: 'sara@x.test', password: 'Sara-pass-12345' } }).expect(201)).body;
    expect(e).toMatchObject({ name: 'Sara Nasser', status: 'ACTIVE', userId: expect.any(String) });
    const tok = (await signIn('sara@x.test', 'Sara-pass-12345').expect(200)).body.accessToken;
    expect((await get('/me/profile', tok).expect(200)).body.id).toBe(e.id);
    expect((await get('/employees', tok)).status).toBe(403); // plain employee role
    await post('/employees', hr.token, { ...base(), name: 'Dup', login: { email: 'SARA@x.test', password: 'Another-pass-123' } }).expect(409);
  });

  it('only company-wide HR/owner may create employees or logins', async () => {
    const bhr = await makeUser(http, T, 'bhr', 'HR', branchId);
    await post('/employees', bhr.token, base()).expect(403);
    const emp = (await post('/employees', hr.token, { ...base(), name: 'No Login' }).expect(201)).body;
    expect(emp.userId).toBeNull();
    await post(`/employees/${emp.id}/login`, bhr.token, { email: 'nl@x.test', password: 'Nologin-pass-123' }).expect(403);
    await post(`/employees/${emp.id}/login`, hr.token, { email: 'nl@x.test', password: 'Nologin-pass-123', roleKey: 'OWNER' }).expect(403); // HR cannot mint an owner
    await post(`/employees/${emp.id}/login`, hr.token, { email: 'nl@x.test', password: 'Nologin-pass-123', roleKey: 'BRANCH_MANAGER' }).expect(201);
    const roles = (await get(`/employees/${emp.id}/access`, hr.token).expect(200)).body.roles.map((r: any) => r.key).sort();
    expect(roles).toEqual(['BRANCH_MANAGER', 'EMPLOYEE']);
    await post(`/employees/${emp.id}/login`, hr.token, { email: 'nl2@x.test', password: 'Nologin-pass-123' }).expect(409); // already has one
  });

  it('password reset works, an owner password cannot be reset by HR, and roles can be removed', async () => {
    const emp = (await post('/employees', hr.token, { ...base(), name: 'Reset Me', login: { email: 'reset@x.test', password: 'Original-pass-123' } }).expect(201)).body;
    await post(`/employees/${emp.id}/password`, hr.token, { password: 'Brand-new-pass-1' }).expect(201);
    await signIn('reset@x.test', 'Original-pass-123').expect(401);
    await signIn('reset@x.test', 'Brand-new-pass-1').expect(200);
    const acc = (await get(`/employees/${emp.id}/access`, hr.token)).body;
    await http.delete(`/users/${acc.user.id}/roles/${acc.roles[0].id}`).set(auth(hr.token)).expect(200);
    expect((await get(`/employees/${emp.id}/access`, hr.token)).body.roles).toEqual([]);
    // an employee record whose login is an owner
    const ownerEmp = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: 'EMP-OWN', legalEntityId: T.legalEntityId, userId: (await prisma.raw.user.findFirstOrThrow({ where: { tenantId: T.tenantId, email: `owner@${T.slug}.test` } })).id, name: 'Boss', phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId } });
    await post(`/employees/${ownerEmp.id}/password`, hr.token, { password: 'Takeover-pass-123' }).expect(403);
  });
});
