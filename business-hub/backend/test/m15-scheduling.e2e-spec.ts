import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

// Sat 7 Mar 2026 .. Fri 13 Mar 2026 is one week when the company starts on Saturday.
describe('M15 scheduling: week start, over-limit shifts, escalation', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string;
  let mgr: { id: string; token: string };
  let hr: { id: string; token: string };
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const patch = (path: string, token: string, body: object) => http.patch(path).set(auth(token)).send(body);
  const put = (path: string, token: string, body: object) => http.put(path).set(auth(token)).send(body);
  const get = async (path: string, token = mgr.token) => (await http.get(path).set(auth(token)).expect(200)).body;

  let n = 0;
  async function employee() {
    const key = `e${++n}`;
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return e.id;
  }
  const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;
  const shift = (employeeId: string, d: number, hours: number, extra: object = {}) =>
    ({ employeeId, branchId, date: day(d), startAt: `${day(d)}T08:00:00+03:00`, endAt: new Date(new Date(`${day(d)}T08:00:00+03:00`).getTime() + hours * 3_600_000).toISOString(), ...extra });
  const add = (employeeId: string, d: number, hours: number, extra: object = {}) => post('/schedules', mgr.token, shift(employeeId, d, hours, extra));
  // five 12 h shifts = exactly the 60 h limit
  const fill = async (employeeId: string, days: number[]) => { for (const d of days) await add(employeeId, d, 12).expect(201); };
  const openRows = async (employeeId: string) => ((await get('/schedule-escalations', hr.token)) as any[]).filter((x) => x.evidence.employeeId === employeeId);

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm15');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    hr = await makeUser(http, T, 'hr', 'HR');
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
  });
  afterAll(() => app.close());

  it('week start: Monday by default, changed by HR or owner only, and it moves the weekly limit', async () => {
    expect(await get('/schedule-settings')).toEqual({ weekStartsOn: 1, maxWeeklyMinutes: 3600 });
    await put('/schedule-settings', mgr.token, { weekStartsOn: 6 }).expect(403);
    await put('/schedule-settings', hr.token, { weekStartsOn: 7 }).expect(400);
    const e = await employee();
    await fill(e, [2, 3, 4, 5, 7]); // Mon week: 2,3,4,5,7 = 60 h
    await add(e, 8, 4).expect(409);
    await put('/schedule-settings', hr.token, { weekStartsOn: 6 }).expect(200);
    expect((await get('/schedule-settings')).weekStartsOn).toBe(6);
    await add(e, 8, 4).expect(201); // Sat week 7..13 holds only 12 + 4 h
  });

  it('clocked weekly overtime follows the week start', async () => {
    const e = await employee();
    const punch = async (d: number) => (await post('/time-entries/manual', mgr.token, { employeeId: e, branchId, clockIn: `${day(d)}T08:00:00+03:00`, clockOut: `${day(d)}T16:30:00+03:00` }).expect(201)).body;
    for (const d of [14, 15, 16, 17, 18, 19]) expect((await punch(d)).overtimeMinutes).toBe(0); // Sat..Thu: 6 x 8 h
    expect((await punch(20)).overtimeMinutes).toBe(480); // Friday closes the same week: all above 48 h
    await put('/schedule-settings', hr.token, { weekStartsOn: 1 }).expect(200);
  });

  it('over the limit needs a reason, raises one escalation and tells HR and the owner once', async () => {
    const e = await employee();
    await fill(e, [2, 3, 4, 5, 6]);
    const refused = await add(e, 7, 6).expect(409);
    expect(refused.body.message).toMatch(/weekly maximum of 60 hours.*66 h/);
    const first = (await add(e, 7, 6, { overLimitReason: 'Ramadan rush' }).expect(201)).body;
    expect(first).toMatchObject({ status: 'PUBLISHED', overLimitReason: 'Ramadan rush' });
    await add(e, 8, 4, { overLimitReason: 'Cover' }).expect(201);
    const rows = await openRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence).toMatchObject({ weekStart: day(2), minutes: 70 * 60, scheduledBy: [mgr.id], reasons: ['Ramadan rush', 'Cover'] });
    const notes = await prisma.raw.notification.findMany({ where: { tenantId: T.tenantId, body: { contains: `e${n}:` } } });
    expect(notes.map((x) => x.roleKey).sort()).toEqual(['HR', 'OWNER']);
  });

  it('reviewer instructs, then approves; more hours than approved escalate again', async () => {
    const e = await employee();
    await fill(e, [2, 3, 4, 5, 6]);
    const extra = (await add(e, 7, 6, { overLimitReason: 'Event' }).expect(201)).body;
    const id = (await openRows(e))[0].id;
    const decide = (token: string, body: object) => post(`/schedule-escalations/${id}/decide`, token, body);
    await decide(mgr.token, { action: 'approve' }).expect(403);
    await decide(hr.token, { action: 'instruct' }).expect(400);
    await decide(hr.token, { action: 'instruct', comment: 'Split with a colleague' }).expect(201);
    expect(await prisma.raw.notification.count({ where: { tenantId: T.tenantId, userId: mgr.id, body: { contains: 'Split with a colleague' } } })).toBe(1);
    expect(await openRows(e)).toHaveLength(1);
    await decide(T.token, { action: 'approve', minutes: 65 * 60 }).expect(409); // the hours changed since the reviewer saw them
    await decide(T.token, { action: 'approve', comment: 'ok', minutes: 66 * 60 }).expect(201);
    expect(await openRows(e)).toHaveLength(0);
    await decide(hr.token, { action: 'approve' }).expect(409);
    const change = (hours: number, more: object = {}) => { const { employeeId: _e, branchId: _b, ...body } = shift(e, 7, hours, more); return patch(`/schedules/${extra.id}`, mgr.token, body); };
    await change(4).expect(200); // within the approved 66 h
    expect(await openRows(e)).toHaveLength(0);
    await change(8).expect(409);
    await change(8, { overLimitReason: 'Longer event' }).expect(200);
    expect((await openRows(e))[0].evidence.minutes).toBe(68 * 60); // old hours not counted twice
  });

  it('the escalation closes by itself once the week is back within the limit', async () => {
    const e = await employee();
    await fill(e, [2, 3, 4, 5, 6]);
    const extra = (await add(e, 7, 6, { overLimitReason: 'Event' }).expect(201)).body;
    expect(await openRows(e)).toHaveLength(1);
    await post(`/schedules/${extra.id}/cancel`, hr.token).expect(201);
    expect(await openRows(e)).toHaveLength(0);
  });

  it('a pending shift over the limit can be approved, and pending hours count', async () => {
    const e = await employee();
    const setApproval = async (required: boolean) => {
      const { count } = await prisma.raw.policy.updateMany({ where: { tenantId: T.tenantId, key: 'schedule.approval' }, data: { rules: { required } } });
      if (!count) await prisma.raw.policy.create({ data: { tenantId: T.tenantId, key: 'schedule.approval', riskTier: 'LOW', rules: { required } } });
    };
    await setApproval(true);
    try {
      await fill(e, [2, 3, 4, 5, 6]);
      await add(e, 7, 6).expect(409);
      const s = (await add(e, 7, 6, { overLimitReason: 'Event' }).expect(201)).body;
      expect(s.status).toBe('PENDING_APPROVAL');
      expect((await post(`/schedules/${s.id}/decide`, hr.token, { approve: true }).expect(201)).body.status).toBe('PUBLISHED');
    } finally {
      await setApproval(false);
    }
  });

  it('summary counts the whole week, including days outside the requested range', async () => {
    const e = await employee();
    await fill(e, [2, 3, 4, 5, 6]);
    await add(e, 7, 6, { overLimitReason: 'Event' }).expect(201);
    const rows = ((await get(`/schedules/summary?from=${day(7)}&to=${day(8)}`)) as any[]).filter((x) => x.employeeId === e);
    // five 12 h days and one 6 h day, less 30 min planned break on shifts over 6 h
    expect(rows).toEqual([{ employeeId: e, weekStart: day(2), minutes: 66 * 60, overLimit: true, expectedOvertimeMinutes: 5 * 210 + 0 }]);
  });
});
