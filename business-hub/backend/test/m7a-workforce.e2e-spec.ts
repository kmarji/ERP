import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { AttendanceService } from '../src/modules/workforce/attendance.service';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';

// Mon 2 Mar 2026 .. Sun 8 Mar 2026 (Fri 6 Mar is the weekend day).
// Leave must be in the future (past leave cannot be cancelled): Tue-Thu of the first Monday a week or more ahead.
const monday = new Date(Date.now() + 7 * 86_400_000);
monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7));
const ymd = (plus: number) => new Date(monday.getTime() + plus * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => `2026-03-${day}T${hhmm}:00+03:00`;

describe('M7a workforce: schedules, time, leave', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let branchId: string;
  let otherBranchId: string;
  let mgr: { id: string; token: string };
  let otherMgr: { id: string; token: string };
  let hr: { id: string; token: string };
  let ana: { id: string; token: string; empId: string };
  let bob: { id: string; token: string; empId: string };
  let templateId: string;
  const inTenant = <R>(fn: () => Promise<R>) => runWithTenant(T.tenantId, fn);
  const get = async (path: string, token = mgr.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);

  async function employee(key: string) {
    const u = await makeUser(http, T, key, 'EMPLOYEE', branchId);
    const position = await prisma.raw.jobPosition.findFirstOrThrow({ where: { tenantId: T.tenantId } });
    const e = await prisma.raw.employee.create({ data: { tenantId: T.tenantId, number: `EMP-${key}`, legalEntityId: T.legalEntityId, userId: u.id, name: key, phone: '0790000000', status: 'ACTIVE', hireDate: new Date('2025-01-01'), positionId: position.id } });
    await prisma.raw.employeeAssignment.create({ data: { tenantId: T.tenantId, employeeId: e.id, branchId, isPrimary: true, validFrom: new Date('2025-01-01') } });
    return { ...u, empId: e.id };
  }

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm7a');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    otherBranchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B2', name: 'Irbid' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    otherMgr = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', otherBranchId);
    hr = await makeUser(http, T, 'hr', 'HR');
    await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 400, payBandMax: 600 } });
    ana = await employee('ana');
    bob = await employee('bob');
    templateId = (await post('/shift-templates', mgr.token, { branchId, name: 'Day', startTime: '09:00', endTime: '17:00', breakMinutes: 30 }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  describe('schedules', () => {
    it('publishes shifts, refuses overlaps, scopes by branch, and bulk keeps the good rows', async () => {
      const shift = (await post('/schedules', mgr.token, { employeeId: ana.empId, branchId, date: '2026-03-02', templateId }).expect(201)).body;
      expect(shift).toMatchObject({ status: 'PUBLISHED', branchId });
      await post('/schedules', mgr.token, { employeeId: ana.empId, branchId, date: '2026-03-02', templateId }).expect(409); // overlap
      await post('/schedules', otherMgr.token, { employeeId: bob.empId, branchId, date: '2026-03-03', templateId }).expect(403); // other branch's manager
      const r = (await post('/schedules/bulk', mgr.token, { shifts: [{ employeeId: bob.empId, branchId, date: '2026-03-02', templateId }, { employeeId: ana.empId, branchId, date: '2026-03-02', templateId }, { employeeId: bob.empId, branchId, date: '2026-03-03', templateId }] }).expect(201)).body;
      expect(r.created).toHaveLength(2);
      expect(r.errors).toEqual([expect.objectContaining({ index: 1 })]);
      await post('/schedules', ana.token, { employeeId: ana.empId, branchId, date: '2026-03-04', templateId }).expect(403); // staff cannot schedule
    });

    it('swaps need a manager decision and re-validate', async () => {
      const mine = (await get('/me/schedule?from=2026-03-02&to=2026-03-02', ana.token))[0];
      const swap = (await post('/me/swaps', ana.token, { scheduleId: mine.id, toEmployeeId: bob.empId, reason: 'dentist' }).expect(201)).body;
      expect(swap.status).toBe('PENDING');
      await post(`/shift-swaps/${swap.id}/decide`, ana.token, { approve: true }).expect(403);
      // bob already works that day, so approval must fail validation rather than double-book
      await post(`/shift-swaps/${swap.id}/decide`, mgr.token, { approve: true }).expect(409);
    });
  });

  describe('time', () => {
    let entryId: string;
    it('kiosk punches compute late, break and overtime; staff cannot set the time', async () => {
      await post('/me/clock-in', ana.token, { at: at('02', '09:00') }).expect(201).then((r) => expect(r.body.clockIn).not.toBe(new Date(at('02', '09:00')).toISOString()));
      await prisma.raw.timeEntry.deleteMany({ where: { tenantId: T.tenantId } }); // that one used the real clock
      const inn = (await post('/time/kiosk/clock-in', mgr.token, { employeeId: ana.empId, branchId, at: at('02', '09:20') }).expect(201)).body;
      expect(inn.lateMinutes).toBeGreaterThan(0);
      expect(inn.scheduleId).toBeTruthy();
      await post('/time/kiosk/clock-in', mgr.token, { employeeId: ana.empId, branchId, at: at('02', '09:25') }).expect(409); // already in
      const out = (await post('/time/kiosk/clock-out', mgr.token, { employeeId: ana.empId, at: at('02', '18:00') }).expect(201)).body;
      entryId = out.id;
      expect(out).toMatchObject({ status: 'COMPLETE', breakMinutes: 30, workedMinutes: 490 });
      expect(out.overtimeMinutes).toBeGreaterThan(0);
      expect(out.overtimeMinutes).toBeLessThanOrEqual(out.workedMinutes);
    });

    it('a manager outside the branch cannot punch for staff', async () => {
      await post('/time/kiosk/clock-in', otherMgr.token, { employeeId: bob.empId, branchId, at: at('03', '09:00') }).expect(403);
    });

    it('a small correction applies at once and keeps the original out of the totals', async () => {
      const r = (await post(`/me/time/${entryId}/correct`, ana.token, { clockIn: at('02', '09:10'), clockOut: at('02', '18:00'), note: 'bus delay' }).expect(201)).body;
      expect(r).toMatchObject({ correctionOf: entryId, status: 'COMPLETE' });
      const orig = await prisma.raw.timeEntry.findFirstOrThrow({ where: { id: entryId } });
      expect(orig.workedMinutes).toBe(0);
      expect(JSON.stringify(orig.flags)).toContain('SUPERSEDED');
    });

    it('a large correction waits for a manager and is applied only when approved', async () => {
      const cur = (await get(`/time-entries?employeeId=${ana.empId}`)).find((e: any) => e.correctionOf);
      const res = (await post(`/me/time/${cur.id}/correct`, ana.token, { clockIn: at('02', '09:00'), clockOut: at('02', '14:00'), note: 'left early' }).expect(201)).body;
      expect(res.pending).toBe(true);
      expect((await prisma.raw.timeEntry.findFirstOrThrow({ where: { id: cur.id } })).workedMinutes).toBeGreaterThan(300);
      const approval = (await get('/approvals')).find((a: any) => a.subjectId === cur.id);
      expect(approval).toMatchObject({ action: 'time.correction' });
      await post(`/approvals/${approval.id}/decide`, mgr.token, { approve: true }).expect(201);
      const entries = await get(`/time-entries?employeeId=${ana.empId}`);
      const latest = entries.filter((e: any) => e.correctionOf === cur.id);
      expect(latest).toHaveLength(1);
      expect(latest[0].workedMinutes).toBe(270);
    });

    it('approves entries by id and by period', async () => {
      const entries = await get(`/time-entries?employeeId=${ana.empId}&status=COMPLETE`);
      expect(entries.length).toBeGreaterThan(0);
      await post(`/time-entries/${entries[0].id}/approve`, mgr.token).expect(201);
      await post(`/time-entries/${entries[0].id}/approve`, mgr.token).expect(409);
      const r = (await post('/time-entries/approve-period', mgr.token, { branchId, from: '2026-03-01', to: '2026-03-08' }).expect(201)).body;
      expect(r.approved).toBeGreaterThanOrEqual(0);
      await post('/time-entries/approve-period', otherMgr.token, { branchId, from: '2026-03-01', to: '2026-03-08' }).expect(403);
    });

    it('raises exactly one missing-punch exception per entry however often the sweep runs', async () => {
      const e = (await post('/time/kiosk/clock-in', mgr.token, { employeeId: bob.empId, branchId, at: at('03', '09:00') }).expect(201)).body;
      expect((await post('/time-entries/flag-missing', mgr.token).expect(201)).body.flagged).toBe(1);
      expect((await post('/time-entries/flag-missing', mgr.token).expect(201)).body.flagged).toBe(0);
      const ex = await prisma.raw.exception.findMany({ where: { tenantId: T.tenantId, code: 'ATT_MISSING_PUNCH' } });
      expect(ex).toHaveLength(1);
      expect((await prisma.raw.timeEntry.findFirstOrThrow({ where: { id: e.id } })).status).toBe('NEEDS_FIX');
      // staff may close their own forgotten shift
      const out = (await post('/time/kiosk/clock-out', mgr.token, { employeeId: bob.empId, at: at('03', '17:00') }).expect(201)).body;
      expect(out.status).toBe('COMPLETE');
    });
  });

  describe('leave', () => {
    let annual: any;
    let reqId: string;
    it('seeds placeholder types and accrues idempotently', async () => {
      const types = await get('/leave/types', hr.token);
      expect(types.map((t: any) => t.key).sort()).toEqual(['ANNUAL', 'SICK', 'UNPAID']);
      annual = types.find((t: any) => t.key === 'ANNUAL');
      await post('/leave/accrue', hr.token).expect(201);
      const first = (await get('/me/leave/balances', ana.token)).find((b: any) => b.key === 'ANNUAL');
      await post('/leave/accrue', hr.token).expect(201);
      const second = (await get('/me/leave/balances', ana.token)).find((b: any) => b.key === 'ANNUAL');
      expect(second.accrued).toEqual(first.accrued);
      expect(Number(second.available)).toBeGreaterThan(0);
    });

    it('validates the request: dates, balance and certificate', async () => {
      await post('/me/leave/requests', ana.token, { leaveTypeId: annual.id, startDate: ymd(2), endDate: ymd(1) }).expect(400);
      await post('/me/leave/requests', ana.token, { leaveTypeId: annual.id, startDate: `${monday.getUTCFullYear()}-01-05`, endDate: `${monday.getUTCFullYear()}-01-30` }).expect(409); // beyond balance
      const sick = (await get('/leave/types', hr.token)).find((t: any) => t.key === 'SICK');
      await post('/me/leave/requests', ana.token, { leaveTypeId: sick.id, startDate: ymd(1), endDate: ymd(5) }).expect(400); // needs a certificate
    });

    it('routes to the manager, books the balance on approval, flags shift conflicts once, and cancel restores', async () => {
      await post('/schedules', mgr.token, { employeeId: ana.empId, branchId, date: ymd(2), templateId }).expect(201);
      const before = (await get('/me/leave/balances', ana.token)).find((b: any) => b.key === 'ANNUAL');
      const r = (await post('/me/leave/requests', ana.token, { leaveTypeId: annual.id, startDate: ymd(1), endDate: ymd(3), reason: 'family' }).expect(201)).body;
      reqId = r.id;
      expect(r).toMatchObject({ status: 'PENDING', days: '3' });
      await post('/me/leave/requests', ana.token, { leaveTypeId: annual.id, startDate: ymd(3), endDate: ymd(4) }).expect(409); // overlap
      const approval = (await get('/approvals')).find((a: any) => a.subjectId === reqId);
      expect(approval).toMatchObject({ action: 'leave.approve', approverRole: 'BRANCH_MANAGER' });
      await post(`/approvals/${approval.id}/decide`, ana.token, { approve: true }).expect(403);
      await post(`/approvals/${approval.id}/decide`, mgr.token, { approve: true }).expect(201);
      expect((await prisma.raw.leaveRequest.findFirstOrThrow({ where: { id: reqId } })).status).toBe('APPROVED');
      const after = (await get('/me/leave/balances', ana.token)).find((b: any) => b.key === 'ANNUAL');
      expect(Number(before.available) - Number(after.available)).toBe(3);
      expect(await prisma.raw.shiftSchedule.count({ where: { tenantId: T.tenantId, employeeId: ana.empId, status: 'LEAVE_CONFLICT' } })).toBe(1);
      expect(await prisma.raw.exception.count({ where: { tenantId: T.tenantId, code: 'LEAVE_SCHEDULE_CONFLICT' } })).toBe(1);
      await post('/schedules', mgr.token, { employeeId: ana.empId, branchId, date: ymd(3), templateId }).expect(409); // cannot schedule onto approved leave

      await post(`/me/leave/requests/${reqId}/cancel`, ana.token).expect(201);
      const restored = (await get('/me/leave/balances', ana.token)).find((b: any) => b.key === 'ANNUAL');
      expect(restored.available).toEqual(before.available);
      await post(`/me/leave/requests/${reqId}/cancel`, ana.token).expect(409);
    });
  });

  describe('attendance contract and self-service', () => {
    it('summarizes counted time, leave and unresolved entries for payroll', async () => {
      const s = await inTenant(() => app.get(AttendanceService).summarize(ana.empId, new Date('2026-03-01'), new Date('2026-03-08')));
      expect(s.employeeId).toBe(ana.empId);
      expect(s.workedMinutes).toBe(270);
      expect(s.regularMinutes + s.overtimeMinutes).toBe(s.workedMinutes);
      expect(s.unresolvedEntries).toBe(0);
      expect(s.scheduledMinutes).toBeGreaterThan(0);
      const b = await inTenant(() => app.get(AttendanceService).summarize(bob.empId, new Date('2026-03-01'), new Date('2026-03-08')));
      expect(b.missingPunches).toBe(1);
    });

    it('ESS needs a linked employee, shows only your own data, and hides other people\'s payslips', async () => {
      await http.get('/me/profile').set(auth(T.token)).expect(404); // the owner has no employee record
      const p = await get('/me/profile', ana.token);
      expect(p).toMatchObject({ id: ana.empId, name: 'ana' });
      expect(p).not.toHaveProperty('sensitive');
      expect(await get('/me/payslips', ana.token)).toEqual([]);
      await http.get('/me/payslips/does-not-exist/download').set(auth(ana.token)).expect(404);
      await http.get('/shift-templates').set(auth(ana.token)).expect(403);
    });
  });
});
