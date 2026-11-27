# Scheduling and social security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native), with one fresh reviewer at the end.

**Goal:** Social security on basic only; configurable week start; over-limit shifts with escalation; easier schedule screen.

**Architecture:** Small changes to the payroll engine and `workforce` module; escalations are `Exception` rows with their own decide endpoint (the generic list only shows a role its own items, so the Owner would not see HR's); the screen moves to `ScheduleBoard.tsx`.

**Tech Stack:** NestJS 10, Prisma 5, React.

**Spec:** `business-hub/docs/superpowers/specs/2026-11-27-scheduling-ssc-design.md`

## Global Constraints
- Paths relative to `business-hub/`; backend commands from `backend/`. No new dependencies. No commits unless the user asks.
- E2E only against `business_hub_test`, docker backend stopped, `--forceExit`.
- Limit = `rules.scheduling.maxWeeklyMinutes`; counts shift length including breaks, PUBLISHED and PENDING_APPROVAL, all branches.
- Overtime thresholds and multiplier unchanged. Custom period max 62 days. Week start default Monday.

## Review Focus
- A pending-approval shift saved over the limit with a reason can still be approved.
- Several over-limit shifts in one week give one escalation and one notification each to HR and Owner.
- Editing a shift does not count its old hours twice.
- A week starting Saturday counts Saturday to Friday, including shifts outside the viewed dates.
- After approval, a shift that raises the hours higher asks for a reason again.

### Task 1: Social security on basic only
**Files:** `backend/src/modules/payroll/payroll-engine.ts`, `payroll-engine.spec.ts`, `frontend/src/pages/EmployeeProfile.tsx`.
- [ ] Tests: basic 600 + allowances 100 → `sscEmployee` 45; fixed 5% → 30; ceiling and unpaid-leave cases updated. Run → FAIL; subject = `max(0, basic - unpaidLeaveDeduction)`; trace text "basic - unpaid leave"; PASS.
- [ ] Profile "Social security salary" shows basic.

### Task 2: Week start day
**Files:** `workforce/common.ts` (+ `common.spec.ts`), new `workforce/week.service.ts`, `time.service.ts`, `schedules.service.ts`, controller, module; test `test/m15-scheduling.e2e-spec.ts`.
**Produces:** `weekBounds(date: Date, startsOn = 1)` (0 = Sunday); `WeekService.startsOn(): Promise<number>` from `tenant.settings.weekStartsOn`; `GET /schedule-settings` (managers) → `{ weekStartsOn, maxWeeklyMinutes }`; `PUT /schedule-settings { weekStartsOn: 0..6 }` (company-wide OWNER/HR), audit `schedule.settings_changed`, other settings keys kept.
- [ ] Unit: Thursday 2026-11-26 with start 6 → 11-21..11-27; start 1 → 11-23..11-29; date equal to start day. E2E: default 1; branch manager PUT 403; 7 → 400; limit follows the new start; clocked weekly overtime follows it.

### Task 3: Over limit, edit, escalation
**Files:** schema + migration `20261127090000_shift_over_limit` (`ShiftSchedule.overLimitReason String?`), new `workforce/overtime.ts` (+ spec), new `workforce/over-hours.service.ts`, `schedules.service.ts`, controller, module.
**Produces:**
- `ShiftDto.overLimitReason?` (min 3). Over the limit without it → 409 `Exceeds the weekly maximum of 60 hours (this week would be N h)`. Not needed within an APPROVED total. `POST /open-shifts/:id/assign`, cover and swaps pass no reason, so they still refuse.
- `PATCH /schedules/:id` `{ date, templateId? | startAt+endAt, overrideRestReason?, overLimitReason? }`: PUBLISHED or PENDING_APPROVAL only; same checks and approval rule as create; clears `noShowAt`; audit `schedule.changed`.
- Exception `SCHEDULE_OVER_HOURS`, `ownerRole: 'HR'`, evidence `{ key: employeeId:weekStart, employeeId, employeeName, weekStart, minutes, limitMinutes, reasons[], scheduledBy[], approvedMinutes? }`; plus notify OWNER. One open row per key. `OverHoursService.sync(employeeId, date, by?: { userId, reason })` is called after create, patch, cancel, reject and swap: updates the open row, raises one, or resolves it once within the limit.
- `GET /schedule-escalations` (OWNER, HR; branch scope applies) → open rows. `POST /schedule-escalations/:id/decide { action: 'approve' | 'instruct', comment? }`: approve → APPROVED with `approvedMinutes`; instruct needs a comment, notifies each `scheduledBy`, stays open.
- `overtimeMinutes(worked: number[], rules): number[]` — per-entry overtime in order, used by `TimeService.compute` and the summary.
- `GET /schedules/summary?from&to` → `[{ employeeId, weekStart, minutes, overLimit, expectedOvertimeMinutes }]` for whole weeks touching the range; planned break = template's, else 30 if over 360.
- `GET /schedules` take 5000.
- [ ] Unit: five 600-min days → 120 each... `overtimeMinutes([600,600,600,600,600], {dailyThresholdMinutes:480, weeklyThresholdMinutes:2880})` = `[120,120,120,120,120]`; seven 480-min days → `[0,0,0,0,0,0,480]`.
- [ ] E2E: no reason → 409; with reason → 201, one escalation, HR and OWNER notified once after two shifts; branch manager decide → 403; instruct without comment → 400, with comment notifies scheduler and stays open; approve → closed, edit shorter needs no reason, longer needs one and escalates again; cancel back under → closed; pending-approval over-limit shift approvable; patch does not double count; summary counts days outside range. Existing `m7a` stays green.

### Task 4: Screens
**Files:** new `frontend/src/pages/ScheduleBoard.tsx`, `Scheduling.tsx` (tab "Week" → "Schedule", new tab "Over limit"), `TimeAttendance.tsx`, `lib/format.ts` (`weekStartOf(startsOn, d)` replaces `mondayOf`).
- [ ] Branch, start date, period (week, 2 weeks, month = one calendar month from start, custom ≤ 62 days), arrows move one period; week-start select (OWNER/HR).
- [ ] Search name/number; filters job role, department, section.
- [ ] Cell click → panel: template or own times (end ≤ start → next day), add/save/cancel shift; rest and over-limit messages ask for a reason and resubmit with both.
- [ ] Row shows period hours, over-limit weeks highlighted, expected overtime.
- [ ] Over limit tab: employee, week, hours, reasons, Approve, Instruct.
- [ ] `npm run build` passes.

### Task 5: Verify and deploy
- [ ] `npm test`, `typecheck`, `lint:schema`, full e2e; rebuild backend and backoffice **with `source ../.tunnel/env`** so public links keep working; HTTP 200.
