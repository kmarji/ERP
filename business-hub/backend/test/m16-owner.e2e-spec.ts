import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

describe('M16 owner bypasses separation of duties and sees every alert', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { id: string; token: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = async (path: string, token: string) => (await http.get(path).set(auth(token)).expect(200)).body;
  const draftRules = async (token: string) => (await post('/payroll/rules', token, { effectiveFrom: '2027-01-01', rules: {} }).expect(201)).body.id as string;

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm16');
    hr = await makeUser(http, T, 'hr', 'HR');
  });
  afterAll(() => app.close());

  it('the owner may verify rules they wrote, and the bypass is recorded', async () => {
    const id = await draftRules(T.token);
    await post(`/payroll/rules/${id}/verify`, T.token, { note: 'checked against law' }).expect(201);
    const [a] = await prisma.raw.auditEvent.findMany({ where: { tenantId: T.tenantId, action: 'owner.override' } });
    expect(a).toMatchObject({ actorId: T.ownerId, entityId: id });
    expect(JSON.stringify(a.after)).toContain('cannot be the one who verifies');
  });

  it('everyone else stays restricted', async () => {
    const fin = await makeUser(http, T, 'fin', 'FINANCE');
    await prisma.raw.userRole.create({ data: { tenantId: T.tenantId, userId: fin.id, roleId: (await prisma.raw.role.findFirstOrThrow({ where: { tenantId: T.tenantId, key: 'HR' } })).id } });
    const id = await draftRules(fin.token);
    await post(`/payroll/rules/${id}/verify`, fin.token, { note: 'checked against law' }).expect(409);
  });

  it('the owner passes role gates', async () => {
    // Only FINANCE is listed on this route: the owner gets as far as looking the return up.
    await post('/tax/returns/00000000-0000-0000-0000-000000000000/submit-review', T.token).expect(404);
    await post('/tax/returns/00000000-0000-0000-0000-000000000000/submit-review', hr.token).expect(403);
  });

  it('the owner sees alerts, exceptions and tasks addressed to other roles; others do not', async () => {
    const ex = await prisma.raw.exception.create({ data: { tenantId: T.tenantId, code: 'ATT_NO_SHOW', reason: 'x did not clock in', status: 'NOTIFIED', ownerRole: 'BRANCH_MANAGER' } });
    await prisma.raw.task.create({ data: { tenantId: T.tenantId, title: 'call x', assigneeRole: 'BRANCH_MANAGER' } });
    for (const roleKey of ['BRANCH_MANAGER', 'OWNER']) await prisma.raw.notification.create({ data: { tenantId: T.tenantId, roleKey, title: 'No show', body: 'same message' } });
    expect((await get('/exceptions?open=true', T.token)).map((x: any) => x.id)).toContain(ex.id);
    await get(`/exceptions/${ex.id}`, T.token);
    expect((await get('/tasks', T.token)).map((x: any) => x.title)).toContain('call x');
    const mine = (await get('/notifications', T.token)).filter((n: any) => n.title === 'No show');
    expect(mine).toHaveLength(1); // the same message to two roles shows once
    expect((await get('/exceptions?open=true', hr.token)).map((x: any) => x.id)).not.toContain(ex.id);
    expect((await get('/notifications', hr.token)).filter((n: any) => n.title === 'No show')).toHaveLength(0);
  });
});
