# Employee File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editable sensitive details, allowances in the employee forms, nationality, and work permits with badges and expiry alerts.

**Architecture:** Plain columns on `Employee`; a pure function derives the badge state on the server. A `WorkPermitService` sends alerts through the existing `NotificationsService`, daily and on save. Screens are in `frontend/src/pages/People.tsx`.

**Tech Stack:** NestJS 10, Prisma 5, @nestjs/schedule, React.

**Spec:** `business-hub/docs/superpowers/specs/2026-11-26-employee-file-design.md`

## Global Constraints
- Paths below are relative to `business-hub/`; commands run from `business-hub/backend`.
- Alert stages are 60, 30, 7 and 0 days. Recipients: role `HR`, role `OWNER`, the employee's user.
- Badge copy: "Work permit incomplete", "Permit expired", "Permit expires in N days".
- Sensitive values never go into the audit trail or logs.
- Dates are Asia/Amman: use `ammanToday()` and `dateOnly()` from `src/common/time.ts`.
- No new dependencies. No commits unless the user asks.
- E2E must not touch the live demo database: use `DATABASE_URL=postgresql://hub:hub@localhost:5432/business_hub_test` (create it, `npx prisma migrate deploy` into it), stop the docker backend first and start it afterwards, run jest with `--forceExit`.

## Review Focus
- Saving only an IBAN must leave national ID, date of birth and address intact (Task 2).
- A permit expiring today reads "expires in 0 days", not "expired"; yesterday is expired (Task 1).
- Saving the same permit twice sends no second alert; a new expiry date restarts the stages (Task 3).
- Terminated employees get no badge and no alert (Tasks 1, 3).
- Unchecking the permit box clears number and expiry; values sent while unchecked are ignored (Task 3).

---

### Task 1: Columns and badge state

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `Employee`)
- Create: `backend/prisma/migrations/<timestamp>_employee_work_permit/migration.sql`, `backend/src/modules/people/work-permit.ts`
- Test: `backend/src/modules/people/work-permit.spec.ts`

**Interfaces:**
- Produces: columns `nationality String?`, `needsWorkPermit Boolean @default(false)`, `workPermitNumber String?`, `workPermitExpiry DateTime? @db.Date`, `workPermitAlertStage Int?`
- Produces: `permitStatus(e: { status: string; needsWorkPermit: boolean; workPermitNumber: string | null; workPermitExpiry: Date | null }, today: Date): { state: 'INCOMPLETE' | 'EXPIRED' | 'EXPIRING'; daysLeft: number | null } | null`
- Produces: `alertStage(daysLeft: number): 60 | 30 | 7 | 0 | null` (smallest stage >= daysLeft; negative gives 0; over 60 gives null)

- [ ] **Step 1: Failing test** covering, with `today = 2026-11-26`:
  - not needed, or status `TERMINATED` → `null`
  - needed, no number and no expiry → `INCOMPLETE`, `daysLeft: null`
  - expiry `2026-11-25`, no number → `EXPIRED`
  - expiry `2026-11-26`, with number → `EXPIRING`, `0`
  - expiry `2027-01-25` (60 days) with number → `EXPIRING`; `2027-01-26` with number → `null`
  - expiry in 10 days, no number → `INCOMPLETE` (precedence: EXPIRED, INCOMPLETE, EXPIRING)
  - `alertStage`: 61→null, 60→60, 31→60, 30→30, 8→30, 7→7, 1→7, 0→0, -3→0
- [ ] **Step 2:** `npx jest work-permit` → FAIL
- [ ] **Step 3:** Implement both functions; add the columns and migration (`prisma migrate diff --script` if `migrate dev` refuses), `npx prisma generate`.
- [ ] **Step 4:** `npx jest work-permit && npm run lint:schema` → PASS

### Task 2: Edit sensitive details

**Files:**
- Modify: `backend/src/modules/people/people.module.ts`, `people.service.ts`
- Test: `backend/test/m13-employee-file.e2e-spec.ts` (new; set up as in `m11-accounts.e2e-spec.ts`)

**Interfaces:**
- Produces: `PUT /employees/:id/sensitive` with `{ nationalId?, dateOfBirth?, address?, iban? }` → the merged object. `PeopleService.setSensitive(id, u, input)`.

Rules: roles HR/OWNER, company-wide only (403 for branch-scoped HR). Merge into the decrypted blob: omitted keeps, `""` removes. If decryption fails, let it throw (never overwrite). IBAN matches `/^[A-Za-z0-9 ]{10,40}$/`, stored without spaces, upper case. `dateOfBirth` is a date string; nationalId 5–30 chars; address max 300. Audit `employee.sensitive_changed`, `after: { fields, by }`.

- [ ] **Step 1: Failing tests:** save all four → GET returns them; PUT `{ iban }` only → other three unchanged; `{ address: '' }` removes address; `{ iban: 'x!' }` → 400; branch HR → 403; audit row contains `fields` and not the IBAN value.
- [ ] **Step 2:** run `m13` → FAIL (404)
- [ ] **Step 3:** Implement. `""` must skip format validators (`@ValidateIf(o => o.x !== '')`).
- [ ] **Step 4:** run `m13` → PASS

### Task 3: Nationality, work permit, alerts

**Files:**
- Create: `backend/src/modules/people/work-permit.service.ts`
- Modify: `people.module.ts`, `people.service.ts`, `accounts.service.ts`, `backend/test/m11-accounts.e2e-spec.ts` (add `nationality: 'Jordanian'` to `base()`)
- Test: `backend/test/m13-employee-file.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 columns and functions.
- Produces: `POST /employees` takes `nationality` (required, 2–60 chars), `needsWorkPermit?`, `workPermitNumber?`, `workPermitExpiry?`. `PATCH /employees/:id` takes the same, all optional; `null` clears number/expiry.
- Produces: `GET /employees` and `GET /employees/:id` include `permit: ReturnType<typeof permitStatus>`; non-HQ viewers get no `workPermitNumber` and no `workPermitAlertStage` is returned to anyone.
- Produces: `WorkPermitService.alert(employeeId?: string): Promise<number>` (number of employees alerted) and a `@Cron('0 7 * * *', { timeZone: 'Asia/Amman' })` sweep over tenants, as in `SscService.sweep`.

Rules: for non-terminated employees needing a permit with an expiry, claim the stage with a conditional `updateMany` (stage null or greater than the new one); only if one row changed, notify HR, OWNER and the user (if any). Title: `Work permit of <name> expires in <N> days` / `... expires today` / `... has expired`; body includes the expiry date. Changing expiry or unchecking resets the stage to null. Call `alert(id)` after create and patch. Add the new fields to the `employee.updated` audit `before`. Allowance rows: `name` 1–60 chars.

- [ ] **Step 1: Failing tests:** create without nationality → 400; flag with no details → `permit.state === 'INCOMPLETE'`, no notifications; patch expiry to today+20 with number → `EXPIRING`, exactly one notification each for HR, OWNER and the employee's user; same patch again and `alert()` → still one each; patch to today+5 → a second set; patch `needsWorkPermit:false` → number and expiry null, `permit` null; create with `needsWorkPermit:false` plus a number → stored null; terminated employee (set via `prisma.raw`) → `permit` null and `alert()` sends nothing; branch manager list has no `workPermitNumber`; create with `allowances:[{name:'Housing',amount:50}]` → on the contract.
- [ ] **Step 2:** run `m13` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run `m13` and `m11` → PASS

### Task 4: Screens

**Files:**
- Modify: `frontend/src/pages/People.tsx`

**Interfaces:**
- Consumes: Task 2 and 3 endpoints.

- [ ] **Step 1:** Add three small components in `People.tsx`:
  - `Allowances({ rows, onChange })`: name + amount rows with add/remove; used by `AddEmployee` and "New version" (prefilled from the active contract, always sent, so removing all saves none). Contracts table gains an "Allowances" column.
  - `PermitFields({ value, onChange })`: checkbox "Requires a work permit"; when checked, optional number and expiry. Used by `AddEmployee` and a new "Nationality and work permit" card on the file, which also edits nationality.
  - `PermitBadge({ permit })`: red for INCOMPLETE/EXPIRED, amber for EXPIRING, beside the name in the list and the file title.
- [ ] **Step 2:** Nationality input (required) on `AddEmployee`. Replace the JSON `<pre>` with a form for the four sensitive fields (view loads it, Save sends all four, Hide closes). The new cards appear only where `AccessCard` does and the viewer may edit.
- [ ] **Step 3:** `cd ../frontend && npm run build` → succeeds

### Task 5: Verify and deploy

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint:schema` → PASS
- [ ] **Step 2:** Full e2e against `business_hub_test` per Global Constraints → PASS
- [ ] **Step 3:** `cd ../docker && docker compose up -d --build backend backoffice`; confirm `\d "Employee"` in `business_hub` shows the new columns and the back-office answers 200.
