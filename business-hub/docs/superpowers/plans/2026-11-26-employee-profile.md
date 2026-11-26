# Employee Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A readable full-width employee profile that also records photo, gender, marital status, work type, department, section, work location and probation months.

**Architecture:** Plain columns on `Employee`; calculated dates in a pure module; photo through its own guarded routes over `StorageAdapter`. The profile moves to a new `EmployeeProfile.tsx`.

**Tech Stack:** NestJS 10, Prisma 5, React, Tailwind.

**Spec:** `business-hub/docs/superpowers/specs/2026-11-26-employee-profile-design.md`

## Global Constraints
- Paths relative to `business-hub/`; backend commands from `backend/`.
- Gender `MALE|FEMALE`; marital `SINGLE|MARRIED|DIVORCED|WIDOWED`; work type `FULL_TIME|PART_TIME|TEMPORARY`; photo JPG/PNG, max 5 MB.
- Payroll rules do not change. No new dependencies.
- E2E only against `business_hub_test`, docker backend stopped, `--forceExit`.
- Never commit the screenshot. No commits unless the user asks.

## Review Focus
- A file named `.png` that is not an image is refused (content checked, not the declared type) (Task 2).
- A hire date of 31 January plus 1 month ends probation on the last day of February (Task 1).
- A new salary package does not move the probation end date (Task 2).
- Branch managers never receive gender, marital status or the photo's storage key (Task 2).
- Switching between employees never shows the previous person's photo or private details (Task 3).

---

### Task 1: Columns and calculated dates

**Files:** `backend/prisma/schema.prisma`, new migration `20261126120000_employee_profile`, new `backend/src/modules/people/profile.ts`, test `profile.spec.ts`.

**Produces:** nullable strings `gender, maritalStatus, workType, department, section, workLocation, photoKey, photoType`; `probationMonths Int @default(3)` backfilled from contract version 1. `addMonths(d: Date, n: number): Date` (clamps to month end); `employmentPeriod(from: Date, to: Date): { years: number; months: number; days: number }` (zeros when `to < from`).

- [ ] Failing test: `2026-08-09 + 3 → 2026-11-09`; `2026-01-31 + 1 → 2026-02-28`; period `2026-08-09..2026-11-26 → {0,3,17}`; `2025-01-31..2026-03-01 → {1,1,1}`; future hire → zeros.
- [ ] Run `npx jest profile` → FAIL; implement; migrate; → PASS.

### Task 2: API

**Files:** `people.module.ts`, `people.service.ts`, `accounts.service.ts`, `onboarding.service.ts` (copy `offer.probationMonths` to the employee), test `backend/test/m14-employee-profile.e2e-spec.ts`.

**Produces:**
- `POST /employees` and `PATCH /employees/:id` accept the six profile strings (optional; `null`/"" clears on PATCH) and `probationMonths` (int 0–24). PATCH also accepts `positionId`. `gender`, `maritalStatus`, `positionId` need `canEditSensitive` (403 otherwise).
- Employee responses add `hasPhoto`, `probationEnd` (date string), `employmentPeriod` (to `terminationDate` or today); never `photoKey`/`photoType`; `gender`/`maritalStatus` only for HQ viewers.
- `POST /employees/:id/photo` (multipart `file`, HR/OWNER, `canEditSensitive`), `DELETE` same, `GET` same path (READ roles + `assertCanSee`; 404 without photo; `nosniff`). Type decided from magic bytes; storage key `<tenantId>/photos/<employeeId>`; audit `employee.photo_changed` / `employee.photo_removed`.

- [ ] Failing tests: fields save on create and patch, `''` clears; invalid gender → 400; unknown position → 400; branch-scoped HR patching gender or uploading photo → 403; branch manager response lacks gender, maritalStatus, photoKey but has `hasPhoto`; PNG uploads and downloads byte-identical; text file named x.png → 400; 6 MB → 413; delete → 404 after; probationEnd unchanged after a new contract.
- [ ] Run `m14` → FAIL; implement; `m14`, `m11`, `m13` → PASS.

### Task 3: Screens

**Files:** new `frontend/src/pages/EmployeeProfile.tsx`; `People.tsx` (list full width; selecting or adding switches views; new optional inputs on Add); `lib/api.ts` (`blobUrl(path)`; `upload` already exists).

- [ ] Move the detail cards to `EmployeeProfile.tsx`. A shared `Section` (title, read view, Edit → form with Save/Cancel). Layout and card contents exactly as the spec's Layout section; two columns from `lg`.
- [ ] Department, section, work location inputs use `<datalist>` of values from the employee list.
- [ ] `npm run build` → succeeds.

### Task 4: Verify and deploy

- [ ] `npm test`, `typecheck`, `lint:schema`, full e2e → PASS.
- [ ] Rebuild backend and backoffice; check columns in `business_hub` and HTTP 200; screenshot the profile in a headless browser if one is available.
