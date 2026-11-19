import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

const BODY = [
  'Always wash your hands thoroughly before handling any prepared food items.',
  'Refrigerated ingredients must remain below five degrees throughout every service period.',
  'Cleaning chemicals should never be stored beside uncovered ingredients or packaging materials.',
  'Cooked chicken must reach seventy five degrees measured with a calibrated thermometer probe.',
  'Report broken equipment immediately to the shift supervisor using the maintenance logbook.',
].join(' ');

describe('M9b operations: SOPs, training, exams, evaluations', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string, positionId: string;
  let mgr: { token: string }, otherMgr: { token: string }, hr: { token: string }, ana: { token: string; empId: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const get = (path: string, token: string) => http.get(path).set(auth(token));

  async function employee(key: string, userless = false) {
    const u = userless ? null : await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u?.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...(u ?? { token: '' }), empId: e.id };
  }
  // Answers an attempt using the stored key (the API never shows it to the employee).
  const answerAll = async (attemptId: string, correct: boolean) => {
    const at = await prisma.raw.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    return (at.questions as any[]).map((q) => ({ questionId: q.id, index: correct ? q.correctIndex : (q.correctIndex + 1) % q.options.length }));
  };

  let item: any;
  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm9b');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    const b2 = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', b2);
    hr = await makeUser(http, T, 'hr', 'HR');
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } })).id;
    ana = await employee('ana');
  });
  afterAll(() => app.close());

  it('library is versioned and only company-wide roles change it', async () => {
    await post('/ops/library', mgr.token, { kind: 'TRAINING', title: 'Food safety basics', body: BODY }).expect(403);
    item = (await post('/ops/library', hr.token, { kind: 'TRAINING', title: 'Food safety basics', body: BODY, passScore: 60, maxAttempts: 2, questionsPerAttempt: 3 }).expect(201)).body;
    expect(item.version).toBe(1);
  });

  it('an item with no approved exam cannot be assigned; AI drafts need approval', async () => {
    await post('/ops/training', hr.token, { employeeId: ana.empId, itemId: item.id }).expect(409);
    const g = (await post(`/ops/library/${item.code}/generate-questions`, hr.token, { count: 5 }).expect(201)).body;
    expect(g.drafts).toBeGreaterThanOrEqual(3);
    const drafts = (await get(`/ops/library/${item.code}/questions?status=DRAFT`, hr.token).expect(200)).body;
    await post('/ops/training', hr.token, { employeeId: ana.empId, itemId: item.id }).expect(409); // drafts do not count
    await post(`/ops/questions/${drafts[0].id}/decide`, mgr.token, { approve: true }).expect(403);
    for (const q of drafts.slice(0, 3)) await post(`/ops/questions/${q.id}/decide`, hr.token, { approve: true }).expect(201);
    await post(`/ops/library/${item.code}/questions`, hr.token, { text: 'Max fridge temperature?', options: ['5C', '9C'], correctIndex: 0 }).expect(201);
    await post(`/ops/library/${item.code}/questions`, hr.token, { text: 'bad', options: ['a', 'a'], correctIndex: 0 }).expect(400);
  });

  it('assign, read, fail, retry, pass; the answer key is never sent', async () => {
    const a = (await post('/ops/training', hr.token, { employeeId: ana.empId, itemId: item.id }).expect(201)).body;
    await post('/ops/training', hr.token, { employeeId: ana.empId, itemId: item.id }).expect(409); // still open
    await post('/ops/training', otherMgr.token, { employeeId: ana.empId, itemId: item.id }).expect(403);
    await post(`/me/learning/${a.id}/exam`, ana.token).expect(409); // read the material first
    expect((await post(`/me/learning/${a.id}/open`, ana.token).expect(201)).body.assignment.status).toBe('IN_PROGRESS');
    const ex1 = (await post(`/me/learning/${a.id}/exam`, ana.token).expect(201)).body;
    expect(ex1.questions).toHaveLength(3);
    expect(JSON.stringify(ex1)).not.toContain('correctIndex');
    expect((await post(`/me/learning/${a.id}/exam`, ana.token).expect(201)).body.attemptId).toBe(ex1.attemptId); // resumes
    const r1 = (await post(`/me/learning/attempts/${ex1.attemptId}/submit`, ana.token, { answers: await answerAll(ex1.attemptId, false) }).expect(201)).body;
    expect(r1).toMatchObject({ score: 0, passed: false, attemptsLeft: 1 });
    await post(`/training/${a.id}/complete`, hr.token).expect(403); // no completing by hand
    const ex2 = (await post(`/me/learning/${a.id}/exam`, ana.token).expect(201)).body;
    const r2 = (await post(`/me/learning/attempts/${ex2.attemptId}/submit`, ana.token, { answers: await answerAll(ex2.attemptId, true) }).expect(201)).body;
    expect(r2).toMatchObject({ score: 100, passed: true });
    expect((await post(`/me/learning/attempts/${ex2.attemptId}/submit`, ana.token, { answers: [] }).expect(201)).body.alreadySubmitted).toBe(true);
    const row = (await get('/me/learning', ana.token).expect(200)).body[0];
    expect(row).toMatchObject({ status: 'PASSED', attempts: 2, bestScore: 100 });
    expect((await get('/me/learning/results', ana.token).expect(200)).body.exams).toHaveLength(1);
  });

  it('attempts run out into FAILED and a manager can reset', async () => {
    const bob = await employee('bob');
    const a = (await post('/ops/training', hr.token, { employeeId: bob.empId, itemId: item.id }).expect(201)).body;
    await post(`/me/learning/${a.id}/open`, bob.token).expect(201);
    for (let i = 0; i < 2; i++) {
      const ex = (await post(`/me/learning/${a.id}/exam`, bob.token).expect(201)).body;
      await post(`/me/learning/attempts/${ex.attemptId}/submit`, bob.token, { answers: await answerAll(ex.attemptId, false) }).expect(201);
    }
    expect((await prisma.raw.trainingAssignment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('FAILED');
    await post(`/me/learning/${a.id}/exam`, bob.token).expect(409);
    expect((await post(`/ops/training/${a.id}/reset`, mgr.token).expect(201)).body).toMatchObject({ status: 'IN_PROGRESS', attempts: 0 });
  });

  it('the training overview is branch-scoped, also when asking for one employee', async () => {
    expect((await get('/ops/training', mgr.token).expect(200)).body.length).toBeGreaterThan(0);
    expect((await get('/ops/training', otherMgr.token).expect(200)).body).toEqual([]);
    await get(`/ops/training?employeeId=${ana.empId}`, otherMgr.token).expect(403);
    expect((await get(`/ops/training?employeeId=${ana.empId}`, mgr.token).expect(200)).body.length).toBeGreaterThan(0);
  });

  it('role rules assign automatically, once', async () => {
    await employee('cara');
    const r = (await post('/ops/training-rules', hr.token, { positionId, itemCode: item.code, dueDays: 14 }).expect(201)).body;
    expect(r.assigned).toBe(1); // cara only: ana and bob already have it
    expect((await post('/ops/training-rules/apply', hr.token).expect(201)).body.assigned).toBe(0);
    expect(await prisma.raw.trainingAssignment.count({ where: { tenantId: T.tenantId, source: 'AUTO' } })).toBe(1);
  });

  it('evaluations are branch-scoped and appear in the employee results', async () => {
    await post('/ops/evaluations', otherMgr.token, { employeeId: ana.empId, topic: 'Espresso', rating: 4 }).expect(403);
    await post('/ops/evaluations', mgr.token, { employeeId: ana.empId, topic: 'Espresso technique', rating: 4, notes: 'Good tamping' }).expect(201);
    expect((await get('/me/learning/results', ana.token).expect(200)).body.evaluations).toHaveLength(1);
    expect((await get(`/ops/evaluations?employeeId=${ana.empId}`, mgr.token).expect(200)).body).toHaveLength(1);
    await get(`/ops/evaluations?employeeId=${ana.empId}`, otherMgr.token).expect(403);
  });
});
