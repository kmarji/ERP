import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DAY, minutes } from './common';

// CONTRACT consumed by payroll. Implemented in the workforce module.
export interface AttendanceSummary {
  employeeId: string;
  scheduledMinutes: number;
  workedMinutes: number; // counted entries only (COMPLETE or APPROVED)
  regularMinutes: number;
  overtimeMinutes: number; // per the overtime rules in force
  lateMinutes: number;
  paidLeaveDays: number; // approved paid leave inside the period
  unpaidLeaveDays: number; // approved unpaid leave inside the period
  absentShifts: number; // scheduled shifts in the past with no time entry and no approved leave
  unresolvedEntries: number; // OPEN or NEEDS_FIX entries in the period: payroll must not be finalized over these
  missingPunches: number;
  flags: string[];
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  // Period is inclusive of both dates (date-only, UTC midnight).
  async summarize(employeeId: string, start: Date, end: Date): Promise<AttendanceSummary> {
    const from = new Date(start);
    const to = new Date(end.getTime() + DAY);
    const [entries, shifts, leaves] = await Promise.all([
      this.prisma.db.timeEntry.findMany({ where: { employeeId, clockIn: { gte: from, lt: to } } }),
      this.prisma.db.shiftSchedule.findMany({ where: { employeeId, status: 'PUBLISHED', date: { gte: start, lte: end } } }),
      this.prisma.db.leaveRequest.findMany({ where: { employeeId, status: 'APPROVED', startDate: { lte: end }, endDate: { gte: start } } }),
    ]);
    const types = new Map((await this.prisma.db.leaveType.findMany()).map((t) => [t.id, t.paid]));
    const counted = entries.filter((e) => e.status === 'COMPLETE' || e.status === 'APPROVED');
    const worked = counted.reduce((s, e) => s + (e.workedMinutes ?? 0), 0);
    const overtime = counted.reduce((s, e) => s + (e.overtimeMinutes ?? 0), 0);
    let paid = 0, unpaid = 0;
    for (const l of leaves) {
      const a = l.startDate > start ? l.startDate : start;
      const b = l.endDate < end ? l.endDate : end;
      let n = 0;
      for (let t = +a; t <= +b; t += DAY) if (new Date(t).getUTCDay() !== 5) n++;
      if (types.get(l.leaveTypeId) === false) unpaid += n; else paid += n;
    }
    const onLeave = (d: Date) => leaves.some((l) => l.startDate <= d && l.endDate >= d);
    const now = new Date();
    const absent = shifts.filter((s) => s.endAt < now && !onLeave(s.date) && !entries.some((e) => e.scheduleId === s.id)).length;
    const unresolved = entries.filter((e) => e.status === 'OPEN' || e.status === 'NEEDS_FIX').length;
    const missing = entries.filter((e) => ((e.flags as any[]) ?? []).some((f) => f.code === 'MISSING_PUNCH')).length;
    const flags: string[] = [];
    if (unresolved) flags.push('UNRESOLVED_ENTRIES');
    if (absent) flags.push('ABSENT_SHIFTS');
    if (counted.some((e) => e.status === 'COMPLETE')) flags.push('UNAPPROVED_TIME');
    return {
      employeeId,
      scheduledMinutes: shifts.reduce((s, x) => s + minutes(x.startAt, x.endAt), 0),
      workedMinutes: worked,
      regularMinutes: Math.max(0, worked - overtime),
      overtimeMinutes: overtime,
      lateMinutes: counted.reduce((s, e) => s + e.lateMinutes, 0),
      paidLeaveDays: paid,
      unpaidLeaveDays: unpaid,
      absentShifts: absent,
      unresolvedEntries: unresolved,
      missingPunches: missing,
      flags,
    };
  }
}
