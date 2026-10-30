# Architecture

NestJS modular monolith on PostgreSQL (Prisma) with Redis/BullMQ for durable async work, plus four React apps: back-office (`frontend`), tablet POS with offline outbox (`pos-app`), customer storefront (`storefront`), candidate careers (`careers`).

## Platform
- **Tenancy:** JWT carries `tid`; middleware opens an `AsyncLocalStorage` context; a Prisma `$extends` extension injects `tenantId` on every tenant-scoped model and fails closed with no context. `prisma.db` is scoped, `prisma.raw` is not (system jobs, tests).
- **One workflow engine** (`WorkflowRegistry`): each workflow registers a transition table; exceptions follow DETECTED, CLASSIFIED, ASSIGNED, NOTIFIED, RESOLVED/APPROVED/REJECTED, EXECUTED/RETRIED, VERIFIED, ARCHIVED.
- **Policy engine:** pure `decide()` over versioned policies and approval limits.
- **Money:** `Decimal(18,3)` everywhere; `d/money/qty/rate` helpers. Use `.gt(0)`, never `isPositive()` (true for zero).
- **Idempotency:** `Idempotency-Key` header interceptor plus unique `(tenantId, idempotencyKey)` on business events.
- **Sensitive fields:** AES-256-GCM `FieldCrypto` (`DATA_ENCRYPTION_KEY`) for national id and bank details; bank files are generated on demand and audited, never stored.

## Workflows
| Id | Name | Modules |
|---|---|---|
| WF-01 | Purchase-to-Compliance | catalog, purchasing, receiving, inventory, finance, tax |
| WF-02 | Sale-to-Financial-Control | menu, pos, kds, customers, floor |
| WF-03 | Recruitment-to-Employment | recruitment, onboarding, people |
| WF-04 | Attendance-to-Payroll | workforce, payroll, offboarding |
| WF-05 | Order-to-Fulfillment | commerce (store, fulfilment, aggregators) |
| WF-06 | Inventory-to-Replenishment | inventory, replenishment |
| WF-07 | Transaction-to-Tax-Filing | tax, tax-returns, e-invoicing |

## Payroll sequence (WF-04)
```
HR creates run -> calculate (attendance + leave + contract + advances + adjustments, versioned rules, per-line trace)
  -> hard exceptions must be fixed at source and recalculated; soft ones acknowledged with a note
  -> HR submits -> FINANCE (not the preparer) reviews -> OWNER authorizes via Approval
  -> finalize: balanced journal per branch, payslips, SSC/tax obligations, advance balances reduced
  -> payment released by a second OWNER approval -> confirm with bank reference
```
Finalization is refused while the rule set is unverified. Payroll rules, SSC rates and tax brackets shipped are **placeholders**.

## Tests
`npm test` (unit), `npx jest --config ./test/jest-e2e.json --forceExit` (e2e, needs Postgres + Redis from `docker/docker-compose.yml`). E2E suites map to the brief's acceptance scenarios AT-01 to AT-12.
