import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant, RequestUser } from '../src/common/tenancy/tenant-context';
import { IntegrationHandlers, IntegrationsService } from '../src/modules/integrations/integrations.service';
import { ApprovalService, APPROVAL_DECIDED } from '../src/modules/workflow-engine/approval.service';
import { ExceptionService } from '../src/modules/workflow-engine/exception.service';

const PASSWORD = 'correct-horse-battery';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(200);
  }
}

describe('M0 platform (AT-11, AT-12)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const A = { slug: `a-${randomUUID().slice(0, 8)}`, tenantId: '', token: '', ownerId: '' };
  const B = { slug: `b-${randomUUID().slice(0, 8)}`, tenantId: '', token: '' };

  const bootstrap = (slug: string) =>
    http
      .post('/tenants/bootstrap')
      .set('x-bootstrap-token', 'dev-bootstrap-token')
      .send({ name: slug, slug, ownerEmail: `owner@${slug}.test`, ownerName: 'Owner', ownerPassword: PASSWORD });
  const login = async (tenant: string, email: string, password = PASSWORD) =>
    (await http.post('/auth/login').send({ tenant, email, password })).body.accessToken as string;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeUser(tenant: typeof A, ownerToken: string, key: string, roleKey: string) {
    const email = `${key}@${tenant.slug}.test`;
    const u = await http.post('/users').set(auth(ownerToken)).send({ email, name: key, password: PASSWORD });
    await http.post(`/users/${u.body.id}/roles`).set(auth(ownerToken)).send({ roleKey });
    return { id: u.body.id as string, token: await login(tenant.slug, email) };
  }

  const asUser = (id: string, roleKeys: string[]): RequestUser => ({
    id,
    tenantId: A.tenantId,
    email: '',
    isSystem: false,
    roles: roleKeys.map((key) => ({ key, legalEntityId: null, branchId: null })),
    delegations: [],
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);

    const a = await bootstrap(A.slug);
    A.tenantId = a.body.tenantId;
    A.ownerId = a.body.ownerId;
    const b = await bootstrap(B.slug);
    B.tenantId = b.body.tenantId;
    A.token = await login(A.slug, `owner@${A.slug}.test`);
    B.token = await login(B.slug, `owner@${B.slug}.test`);
  });

  afterAll(() => app.close());

  describe('auth and tenancy', () => {
    it('rejects bootstrap without the platform token and unauthenticated calls', async () => {
      await http.post('/tenants/bootstrap').send({}).expect(403);
      await http.get('/org/branches').expect(401);
    });

    it('rejects wrong passwords and machine identities', async () => {
      await http.post('/auth/login').send({ tenant: A.slug, email: `owner@${A.slug}.test`, password: 'wrong-password' }).expect(401);
      await http.post('/auth/login').send({ tenant: A.slug, email: `system@${A.slug}.internal`, password: PASSWORD }).expect(401);
    });

    it('isolates tenants: B never sees A data (AT-12)', async () => {
      const le = (await http.get('/org/legal-entities').set(auth(A.token))).body[0];
      const br = await http.post('/org/branches').set(auth(A.token)).send({ legalEntityId: le.id, code: 'AMM1', name: 'Amman 1' }).expect(201);
      expect((await http.get('/org/branches').set(auth(A.token))).body).toHaveLength(1);
      expect((await http.get('/org/branches').set(auth(B.token))).body).toHaveLength(0);
      const bUsers = (await http.get('/users').set(auth(B.token))).body;
      expect(bUsers).toHaveLength(2); // owner + machine identity only
      expect(bUsers.map((u: any) => u.id)).not.toContain(A.ownerId);
      // Direct data-layer attempt: scoped client refuses to run without context and cannot read across tenants.
      await expect(prisma.db.branch.findMany()).rejects.toThrow(/tenant context/);
      const crossTenant = await runWithTenant(B.tenantId, () => prisma.db.branch.findFirst({ where: { id: br.body.id } }));
      expect(crossTenant).toBeNull();
      await expect(
        runWithTenant(B.tenantId, () => prisma.db.branch.create({ data: { tenantId: A.tenantId, legalEntityId: le.id, code: 'X', name: 'X' } })),
      ).rejects.toThrow(/Cross-tenant/);
    });

    it('enforces roles and scoped branch roles', async () => {
      const cashier = await makeUser(A, A.token, 'cashier1', 'CASHIER');
      await http.get('/dashboard/owner').set(auth(cashier.token)).expect(403);
      await http.post('/policies').set(auth(cashier.token)).send({ key: 'x', riskTier: 'LOW', rules: {} }).expect(403);
    });
  });

  describe('policy engine', () => {
    it('creates versions, evaluates decisions, rolls back and blocks when deactivated', async () => {
      const key = 'test.sample_policy'; // independent of the seeded default policies
      await http.post('/policies').set(auth(A.token)).send({ key, riskTier: 'LOW', rules: { maxAutoAmount: 100 } }).expect(201);
      await http.post('/policies/limits').set(auth(A.token)).send({ policyKey: key, roleKey: 'BRANCH_MANAGER', maxAmount: 500 }).expect(201);
      const ev = (amount: number) => http.post('/policies/evaluate').set(auth(A.token)).send({ policyKey: key, amount }).then((r) => r.body);

      expect((await ev(50)).decision).toBe('AUTO');
      expect(await ev(300)).toMatchObject({ decision: 'DELEGATED', approverRole: 'BRANCH_MANAGER', ownerEscalated: false });
      expect(await ev(9000)).toMatchObject({ decision: 'APPROVAL_REQUIRED', approverRole: 'OWNER', ownerEscalated: true });

      await http.post('/policies').set(auth(A.token)).send({ key, riskTier: 'HIGH', rules: {} }).expect(201);
      expect((await ev(50)).decision).toBe('APPROVAL_REQUIRED');
      await http.post(`/policies/${key}/activate/1`).set(auth(A.token)).expect(201);
      expect((await ev(50)).decision).toBe('AUTO');
      await http.post(`/policies/${key}/deactivate`).set(auth(A.token)).expect(201);
      expect((await ev(50)).decision).toBe('BLOCKED');

      const audit = await http.get('/audit').query({ entityType: 'Policy' }).set(auth(A.token)).expect(200);
      expect(audit.body.map((e: any) => e.action)).toEqual(expect.arrayContaining(['policy.version_created', 'policy.activated', 'policy.deactivated']));
    });
  });

  describe('exceptions and approvals (AT-11)', () => {
    let manager: { id: string; token: string };
    let finance1: { id: string; token: string };
    let finance2: { id: string; token: string };

    beforeAll(async () => {
      manager = await makeUser(A, A.token, 'manager1', 'BRANCH_MANAGER');
      finance1 = await makeUser(A, A.token, 'finance1', 'FINANCE');
      finance2 = await makeUser(A, A.token, 'finance2', 'FINANCE');
    });

    it('routes to the lowest authorized role and keeps the owner out of routine exceptions', async () => {
      const ex = app.get(ExceptionService);
      const routine = await runWithTenant(A.tenantId, () =>
        ex.raise({ code: 'PUR_PRICE_VARIANCE', reason: 'Price +3% vs PO', ownerRole: 'BRANCH_MANAGER', riskTier: 'MEDIUM', amount: 40 }),
      );
      expect(routine).toMatchObject({ status: 'NOTIFIED', ownerRole: 'BRANCH_MANAGER', ownerEscalated: false });
      expect(routine.history).toHaveLength(4);

      const material = await runWithTenant(A.tenantId, () =>
        ex.raise({ code: 'PAYROLL_FINALIZE', reason: 'Payroll run needs approval', ownerRole: 'OWNER', riskTier: 'HIGH', amount: 25000 }),
      );

      const owner = (await http.get('/dashboard/owner').set(auth(A.token)).expect(200)).body;
      expect(owner.decisions.map((d: any) => d.id)).toEqual([material.id]);
      expect(owner.decisions.map((d: any) => d.id)).not.toContain(routine.id);

      expect((await http.get('/exceptions').set(auth(manager.token))).body.map((e: any) => e.id)).toContain(routine.id);
      expect((await http.get('/exceptions').set(auth(manager.token))).body.map((e: any) => e.id)).not.toContain(material.id);
      await http.get(`/exceptions/${material.id}`).set(auth(manager.token)).expect(404);

      // Lifecycle is enforced in order.
      await http.post(`/exceptions/${routine.id}/actions`).set(auth(manager.token)).send({ action: 'verify' }).expect(400);
      await http.post(`/exceptions/${routine.id}/actions`).set(auth(manager.token)).send({ action: 'resolve', comment: 'Accepted' }).expect(201);
      await http.post(`/exceptions/${routine.id}/actions`).set(auth(manager.token)).send({ action: 'verify' }).expect(201);
      await http.post(`/exceptions/${routine.id}/actions`).set(auth(manager.token)).send({ action: 'archive' }).expect(201);
      expect((await http.get(`/exceptions/${routine.id}`).set(auth(manager.token))).body.status).toBe('ARCHIVED');
    });

    it('enforces separation of duties and role on approvals, then executes via event', async () => {
      const approvals = app.get(ApprovalService);
      const events = app.get(EventEmitter2);
      const seen: any[] = [];
      events.on(APPROVAL_DECIDED, (e) => seen.push(e));

      const a = await runWithTenant(
        A.tenantId,
        () => approvals.request({ subjectType: 'PurchaseOrder', subjectId: 'po-1', action: 'purchase_order.issue', approverRole: 'FINANCE', amount: 1200 }),
        asUser(finance1.id, ['FINANCE']),
      );

      await http.post(`/approvals/${a.id}/decide`).set(auth(finance1.token)).send({ approve: true }).expect(403); // own request
      await http.post(`/approvals/${a.id}/decide`).set(auth(manager.token)).send({ approve: true }).expect(403); // lacks role
      expect((await http.get('/approvals').set(auth(finance2.token))).body.map((x: any) => x.id)).toContain(a.id);
      await http.post(`/approvals/${a.id}/decide`).set(auth(finance2.token)).send({ approve: true, comment: 'ok' }).expect(201);
      await http.post(`/approvals/${a.id}/decide`).set(auth(finance2.token)).send({ approve: true }).expect(400); // already decided

      expect(seen).toEqual([expect.objectContaining({ approvalId: a.id, approved: true, action: 'purchase_order.issue', decidedBy: finance2.id })]);
    });

    it('supports temporary delegation and its revocation', async () => {
      const staff = await makeUser(A, A.token, 'staff1', 'EMPLOYEE');
      await http.get('/policies/limits').set(auth(staff.token)).expect(200);
      await http.post('/policies/limits').set(auth(staff.token)).send({ policyKey: 'k', roleKey: 'FINANCE', maxAmount: 1 }).expect(403);
      const d = await http
        .post('/delegations')
        .set(auth(A.token))
        .send({ toUserId: staff.id, roleKey: 'FINANCE', startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(201);
      await http.post('/policies/limits').set(auth(staff.token)).send({ policyKey: 'k', roleKey: 'FINANCE', maxAmount: 1 }).expect(201);
      await http.post(`/delegations/${d.body.id}/revoke`).set(auth(A.token)).expect(201);
      await http.post('/policies/limits').set(auth(staff.token)).send({ policyKey: 'k', roleKey: 'FINANCE', maxAmount: 1 }).expect(403);
    });
  });

  describe('idempotency (AT-03 foundation)', () => {
    it('replays the same key and rejects reuse with a different payload', async () => {
      const le = (await http.get('/org/legal-entities').set(auth(A.token))).body[0];
      const key = randomUUID();
      const body = { legalEntityId: le.id, code: 'IDEM1', name: 'Idem' };
      const first = await http.post('/org/branches').set(auth(A.token)).set('Idempotency-Key', key).send(body).expect(201);
      const second = await http.post('/org/branches').set(auth(A.token)).set('Idempotency-Key', key).send(body).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replay']).toBe('true');
      await http.post('/org/branches').set(auth(A.token)).set('Idempotency-Key', key).send({ ...body, code: 'OTHER' }).expect(422);
      const count = (await http.get('/org/branches').set(auth(A.token))).body.filter((b: any) => b.code === 'IDEM1').length;
      expect(count).toBe(1);
    });

    it('does not cache failures, so the client can correct and retry', async () => {
      const key = randomUUID();
      await http.post('/org/branches').set(auth(A.token)).set('Idempotency-Key', key).send({ legalEntityId: 'nope', code: 'F', name: 'F' }).expect(500);
      const le = (await http.get('/org/legal-entities').set(auth(A.token))).body[0];
      await http.post('/org/branches').set(auth(A.token)).set('Idempotency-Key', key).send({ legalEntityId: le.id, code: 'F', name: 'F' }).expect(201);
    });
  });

  describe('integration jobs: retry and dead-letter (AT-12)', () => {
    it('retries with backoff then succeeds, and never runs a duplicate key twice', async () => {
      const handlers = app.get(IntegrationHandlers);
      const integrations = app.get(IntegrationsService);
      let calls = 0;
      handlers.register('test', 'flaky', async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return { ok: true };
      });
      const key = randomUUID();
      const job = await runWithTenant(A.tenantId, () => integrations.enqueue({ adapter: 'test', operation: 'flaky', payload: {}, idempotencyKey: key }));
      const dup = await runWithTenant(A.tenantId, () => integrations.enqueue({ adapter: 'test', operation: 'flaky', payload: {}, idempotencyKey: key }));
      expect(dup.id).toBe(job.id);
      const done = await until(async () => {
        const j = await runWithTenant(A.tenantId, () => prisma.db.integrationJob.findFirst({ where: { id: job.id } }));
        return j?.status === 'SUCCEEDED' ? j : undefined;
      });
      expect(done.attempts).toBe(2);
      expect(calls).toBe(2);
    });

    it('dead-letters after max attempts, raises an exception and allows manual retry', async () => {
      const handlers = app.get(IntegrationHandlers);
      const integrations = app.get(IntegrationsService);
      let healthy = false;
      handlers.register('test', 'broken', async () => {
        if (!healthy) throw new Error('upstream down');
        return { ok: true };
      });
      const job = await runWithTenant(A.tenantId, () =>
        integrations.enqueue({ adapter: 'test', operation: 'broken', payload: {}, idempotencyKey: randomUUID(), maxAttempts: 2 }),
      );
      const dead = await until(async () => {
        const j = await runWithTenant(A.tenantId, () => prisma.db.integrationJob.findFirst({ where: { id: job.id } }));
        return j?.status === 'DEAD' ? j : undefined;
      });
      expect(dead.lastError).toContain('upstream down');
      const ex = await until(async () => {
        const list = await runWithTenant(A.tenantId, () => prisma.db.exception.findMany({ where: { code: 'INTEGRATION_DEAD_LETTER' } }));
        return list.find((e) => (e.evidence as any).integrationJobId === job.id);
      });
      expect(ex.ownerRole).toBe('FINANCE');

      healthy = true;
      await http.post(`/integrations/jobs/${job.id}/retry`).set(auth(A.token)).expect(201);
      await until(async () => {
        const j = await runWithTenant(A.tenantId, () => prisma.db.integrationJob.findFirst({ where: { id: job.id } }));
        return j?.status === 'SUCCEEDED';
      });
    });
  });

  describe('documents and evidence', () => {
    it('stores the original, extracts with confidence and provenance, and is tenant-isolated', async () => {
      const fixture = { qr: 'JO-QR-1', confidence: 0.97, fields: { invoiceNumber: 'INV-1', total: 118.5 }, lines: [{ sku: 'S1', qty: 2 }] };
      const buf = Buffer.from(JSON.stringify(fixture));
      const up = await http
        .post('/documents')
        .query({ subjectType: 'SupplierInvoice', subjectId: 'inv-1' })
        .set(auth(A.token))
        .attach('file', buf, { filename: 'invoice.json', contentType: 'application/json' })
        .expect(201);
      expect(up.body.sha256).toHaveLength(64);
      expect(Number(up.body.confidence)).toBeCloseTo(0.97);
      expect(up.body.extracted.fields.invoiceNumber).toEqual({ value: 'INV-1', confidence: 0.97, source: 'stub-json' });
      expect(up.body.extracted.qrPayload).toBe('JO-QR-1');

      const dl = await http.get(`/documents/${up.body.id}/download`).set(auth(A.token)).buffer(true).expect(200);
      expect(Buffer.from(dl.body.toString ? JSON.stringify(dl.body) : '')).toBeDefined();
      expect(JSON.stringify(dl.body)).toBe(JSON.stringify(fixture));
      await http.get(`/documents/${up.body.id}`).set(auth(B.token)).expect(404);

      const unreadable = await http
        .post('/documents')
        .set(auth(A.token))
        .attach('file', Buffer.from('%PDF-fake'), { filename: 'scan.pdf', contentType: 'application/pdf' })
        .expect(201);
      expect(Number(unreadable.body.confidence)).toBe(0);
    });
  });
});
