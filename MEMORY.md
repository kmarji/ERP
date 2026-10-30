# Project memory: Business Hub

Source of truth for scope: `Business_Hub_Technical_Product_Brief_v3.docx.pdf`. Code: `business-hub/`. Plan: `~/.claude/plans/i-want-you-to-goofy-scroll.md`. No git repo yet; nothing committed.

## Decisions (user-confirmed)
- Build all 7 workflows (WF-01 purchasing, WF-02 POS, WF-03 recruitment, WF-04 payroll, WF-05 online orders, WF-06 inventory, WF-07 tax) with a React back-office; old scaffolding scrapped and rebuilt clean.

## Decisions (mine, keep unless told otherwise)
- NestJS modular monolith, Prisma/PostgreSQL, Redis/BullMQ; tenant scoping via AsyncLocalStorage + Prisma extension (fails closed).
- Ledger/stock/audit tables append-only (extension + DB triggers); corrections by reversal.
- Integrations stub-first behind adapters; never assume official API access (JoFotara, SSC, aggregators).
- AI interview is advice only, never rejects candidates.
- Payroll: DRAFT, CALCULATED, IN_REVIEW, FINALIZED, PAID. Preparer (HR) cannot review; FINANCE reviews; OWNER authorizes finalize and, separately, payment release. Finalization blocked while rules unverified. Bank files generated on demand and audited, never stored.
- Offboarding settlement approved by FINANCE; leave payout = basic/30 per day, no end-of-service gratuity (to confirm with legal).

## State (2026-10-30)
- Done: M0 platform, M1 to M7 backend, all UI (frontend, pos-app, storefront, careers), Dockerfiles + compose, README, docs/ (architecture, posting matrix, RBAC, integrations).
- Verified: tsc, lint:schema, 61 unit, 159 e2e, 4 vite builds. NOT verified: any browser run, Docker image builds, OpenRouter live API.

- POS native app: Capacitor 7 wrapper in `business-hub/pos-app` (`android/`, `ios/`, id `jo.businesshub.pos`, landscape only). Build needs an https `VITE_API_URL`; backend `CORS_ORIGIN` must include `https://localhost,capacitor://localhost`.
- Receipt printing: network ESC/POS (port 9100) via `capacitor-tcp-socket`; receipt drawn on a canvas and sent as a raster image (Arabic safe). Config in localStorage on the Branch screen. On demand only: no auto-print, no cash drawer.
- Card payments: standalone terminal; cashier keys the approval code (required for CARD/DIGITAL). Real vendor integration goes in the backend `PosTerminalAdapter` once a vendor is chosen.
- Native app, printer and terminal flow are NOT verified on hardware or built (no Android SDK or Xcode here); only tsc/vite build and an encoder check.

## Gotchas
- decimal.js `isPositive()` is true for zero: use `.gt(0)`.
- e2e: use `--forceExit`; never `pkill -f "jest --config"`; don't nest supertest calls in `.send(await ...)`.
- `migrate dev` may fail non-interactively on unique-constraint changes: `migrate diff --script` into a migration folder + `migrate deploy`.
- New policies/limits: edit `policy-engine/defaults.ts`, run `npm run defaults:sync`; existing tenants keep old limits (defaults only insert missing).
- Event emitter maxListeners set to 50 (many `approval.decided` listeners).
- Running e2e while the docker backend is up makes M5 tests time out (shared Redis queue): stop the backend container first.
- Backend image keeps devDependencies because `prisma migrate deploy` needs the CLI.

## Open items
- Legal verification of Jordan tax brackets, SSC rates, payroll rules, chart of accounts.
- Real integrations (JoFotara, SSC, aggregators, terminals, gateway, OCR).
- Browser testing of all UIs; Docker build test; build and run the native app and a real printer.
- Printer extras: auto-print, cash-drawer kick, Bluetooth/USB printers. Card terminal vendor integration.
- Leave: no public-holiday calendar (only Friday off), cross-year requests refused, leave types read-only.
- API gaps found by UI: no `/me/colleagues` (swap requests need typed employee ids), UI role gating is nav-only.
- Open questions from the brief: hardware specs for tablet POS, migration from Foodics/QuickBooks/ZenHR.
