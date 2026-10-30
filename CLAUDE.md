# Business Hub

Multi-tenant F&B operating system (Jordan, 2-20 branches). Code lives in `business-hub/`; see `business-hub/README.md` and `business-hub/docs/`.

## Layout
- `backend/` NestJS 10 + Prisma 5 (PostgreSQL 16) + Redis/BullMQ. Modules in `src/modules/*`, shared code in `src/common/*`.
- `frontend/` back-office, `pos-app/` tablet POS (offline), `storefront/` customers, `careers/` candidates. React + Vite + Tailwind. `pos-app` also ships as an iOS/Android app (Capacitor 7); printer code is `pos-app/src/lib/printer.ts` + `escpos.ts`.
- `docker/` compose (postgres, redis, backend, the four web apps). `docs/` architecture, posting matrix, RBAC, integrations.

## Status
All 7 workflows built (backend + UI); backend 61 unit + 159 e2e green; four frontends build. No UI has been run in a browser; the native app, receipt printer and card flow are unverified on hardware. See `MEMORY.md` for decisions, gotchas and open items.

## Rules that are easy to break
- Tenant scoping is automatic via `prisma.db`; `prisma.raw` is unscoped (system jobs, tests). Create calls pass `tenantId: ''` (the extension overwrites); nested creates need `currentTenantId()`.
- Journals, journal lines, stock movements and audit events are append-only (extension + DB triggers). Correct by reversal.
- Money is `Decimal(18,3)`. Use `.gt(0)`, never `isPositive()`.
- All postings go through `FinancePostingService.post` with an idempotency key.
- Integrations are stub-first adapters; do not assume official API access.
- Payroll finalize/release approvals are OWNER-level; preparer, reviewer (FINANCE) and authorizer must be different people.
- Tax, SSC and payroll rule values are unverified placeholders; payroll finalization requires a verified rule set.
- Schema changes: `prisma migrate dev`; if it refuses non-interactively, use `migrate diff --script` into a migration folder, then `migrate deploy`. New policies/limits go in `policy-engine/defaults.ts`, then `npm run defaults:sync` for existing tenants.

## Commands (from `business-hub/backend`)
```bash
npm test                                                    # unit
npx jest --config ./test/jest-e2e.json --forceExit          # e2e (needs docker postgres + redis); hangs without --forceExit
npm run typecheck && npm run lint:schema
```
E2E shares Redis with the docker backend, whose queue worker steals test jobs (marketplace tests time out): `docker compose stop backend` before running e2e.
Do not `pkill -f "jest --config"` (kills the shell). In supertest, compute values before building the request; never nest requests inside `.send(await ...)`.
