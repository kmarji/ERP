import { INestApplication } from '@nestjs/common';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M12 role matrix: grant or remove a role\'s access per module', () => {
  let app: INestApplication;
  let http: Http;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { token: string; id: string }, cashier: { token: string; id: string }, mgr: { token: string; id: string };
  const send = (m: 'get' | 'post' | 'put' | 'delete', path: string, token: string, body?: object) => (http as any)[m](path).set(auth(token)).send(body);

  beforeAll(async () => {
    ({ app, http } = await createApp());
    T = await newTenant(http, 'm12');
    hr = await makeUser(http, T, 'hr', 'HR');
    cashier = await makeUser(http, T, 'cash', 'CASHIER');
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER');
  });
  afterAll(() => app.close());

  it('lists defaults from code; only the owner edits', async () => {
    const m = (await send('get', '/roles/matrix', hr.token).expect(200)).body;
    const wf = m.areas.find((a: any) => a.area === 'Workforce');
    expect(wf.defaults).toEqual(expect.arrayContaining(['BRANCH_MANAGER', 'HR', 'OWNER']));
    expect(m.areas.find((a: any) => a.area === 'Users').locked).toBe(true);
    await send('put', '/roles/permissions', hr.token, { roleKey: 'CASHIER', area: 'Workforce', allow: true }).expect(403);
  });

  it('a grant opens a module for a role, a removal closes it, and clearing restores the default', async () => {
    await send('get', '/schedules', cashier.token).expect(403);
    await send('put', '/roles/permissions', T.token, { roleKey: 'CASHIER', area: 'Workforce', allow: true }).expect(200);
    await send('get', '/schedules', cashier.token).expect(200);
    expect((await send('get', '/auth/me', cashier.token)).body.areas).toContain('Workforce');
    await send('put', '/roles/permissions', T.token, { roleKey: 'BRANCH_MANAGER', area: 'Workforce', allow: false }).expect(200);
    await send('get', '/schedules', mgr.token).expect(403);
    await send('get', '/schedules', T.token).expect(200); // the owner cannot be locked out
    await send('put', '/roles/permissions', T.token, { roleKey: 'BRANCH_MANAGER', area: 'Workforce' }).expect(200);
    await send('get', '/schedules', mgr.token).expect(200);
    await send('put', '/roles/permissions', T.token, { roleKey: 'CASHIER', area: 'Workforce', allow: false }).expect(200);
    await send('get', '/schedules', cashier.token).expect(403);
  });

  it('owner-only actions, owner role and locked modules cannot be granted', async () => {
    await send('put', '/roles/permissions', T.token, { roleKey: 'CASHIER', area: 'Users', allow: true }).expect(400);
    await send('put', '/roles/permissions', T.token, { roleKey: 'OWNER', area: 'Workforce', allow: false }).expect(400);
    await send('put', '/roles/permissions', T.token, { roleKey: 'CASHIER', area: 'Payroll', allow: true }).expect(200);
    await send('post', '/users', cashier.token, { email: 'x@y.test', name: 'x', password: 'long-password-12' }).expect(403); // Users stays locked
  });

  it('custom roles can be created, used and deleted', async () => {
    const r = (await send('post', '/roles', T.token, { name: 'Shift Supervisor', rank: 35 }).expect(201)).body;
    expect(r.key).toBe('SHIFT_SUPERVISOR');
    await send('post', '/roles', hr.token, { name: 'Nope' }).expect(403);
    await send('post', '/roles', T.token, { name: 'shift supervisor' }).expect(409);
    await send('put', '/roles/permissions', T.token, { roleKey: r.key, area: 'Workforce', allow: true }).expect(200);
    const sup = await makeUser(http, T, 'sup', r.key);
    await send('get', '/schedules', sup.token).expect(200);
    await send('delete', `/roles/${r.key}`, T.token).expect(409); // still assigned
    await send('delete', '/roles/HR', T.token).expect(400);
  });
});
