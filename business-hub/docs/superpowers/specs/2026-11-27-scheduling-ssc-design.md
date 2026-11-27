# Social security salary, over-limit scheduling, and an easier schedule screen

## Intent
Pay social security on basic salary only. Let a scheduler finish a schedule that goes over the weekly
limit, while someone senior is told and can step in. Make the schedule screen easy to use for any
dates.

Built in this order; each part works on its own.

## 1. Social security salary
- Subject wage = basic salary minus unpaid leave (never below zero), then the existing ceiling.
  No allowance counts. Overtime stays excluded, as today.
- Employee profile "Social security salary" shows basic salary.
- Applies to runs calculated from now on. Finalized and paid runs do not change. An existing draft or
  calculated run needs recalculating.
- Per-employee fixed ratios are unchanged.

## 2. Week start day
- Company setting, Monday by default, changed by Owner or HR on the Scheduling page.
- Used for the weekly hours limit, weekly overtime, and the default dates in Time and attendance.
- Changing it does not recalculate overtime already stored.

## 3. Scheduling over the weekly limit
- The limit stays 60 hours (payroll rule set).
- Adding or editing a shift that passes it asks for a reason, then saves and publishes (or waits for
  approval, if the approval policy is on).
- One open escalation per employee per week, owned by HR; HR and Owner are notified. More shifts in
  that week update the same escalation without new notifications.
- The reviewer (Owner or HR) can:
  - **Approve**: closes it, for the hours shown. Going higher than the approved hours asks for a
    reason and escalates again.
  - **Amend or cancel** shifts: the escalation closes by itself once the week is back within the limit.
  - **Instruct**: a message goes to whoever scheduled it; the escalation stays open.
- Overtime rules do not change: over 8 hours a day or 48 a week of clocked time, at 1.25x, paid after
  the time entry is approved.

## 4. Schedule screen
- Branch, start date (any day), period: 1 week, 2 weeks, month, or custom up to 62 days.
  Arrows move by one period.
- Search by name or employee number; filter by job role, department and section.
- Click an empty cell to add a shift: a template, or own start and end times (an end earlier than the
  start means next day). Click a shift to edit or cancel it.
- Each employee row shows scheduled hours for the period; any week over the limit is highlighted,
  with expected overtime (same thresholds as above, from planned times less breaks).
- Weekly figures count the whole week and every branch, even when the view starts mid-week.
- Rest-hours override works as today, inside the same panel.

## Approaches
- **Week definition.** A: company chooses the start day (**chosen**; predictable, matches payroll).
  B: any 7 days in a row (strictest, hard to follow). C: per branch (messy for shared staff).
- **Escalation.** Reuse the existing Exceptions list with schedule-specific actions (**chosen**; one
  place to look, deadlines already escalate). A separate approvals screen would duplicate it.

## Calls made by the builder (check these)
- The limit counts shift length including breaks, as today.
- HR or Owner may approve their own over-limit shift (same as shift approval today). Branch managers
  cannot approve.
- Shift swaps, open-shift assignment and no-show cover still refuse to pass the limit.
- No second over-limit threshold, no copy-week or repeat-shift tool.

## Check
Backend tests: allowances excluded from social security; week start moves the limit and weekly
overtime; over-limit needs a reason, raises one escalation, approve / amend / instruct behave as
above; branch manager cannot approve. Frontend builds.
