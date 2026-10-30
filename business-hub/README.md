# Business Hub

Multi-tenant F&B operating system for Jordanian operators with 2-20 branches: capture once, validate, post to every module, auto-complete routine steps, escalate only exceptions. Implements the seven workflows of the technical brief (purchasing, POS, recruitment, payroll, online orders, inventory, tax).

## Run locally
```bash
cd docker && docker compose up -d postgres redis        # infra only
cd ../backend
cp .env.example .env && npm install
npx prisma migrate deploy && npm run prisma:seed       # demo tenant
npm run start:dev                                       # API :3000, Swagger at /docs
```
Apps (each `npm install && npm run dev`): `frontend` :5173 back-office, `pos-app` :5174, `storefront` :5175, `careers` :5176. Demo login: tenant `demo`, `owner@demo.test` (password `ChangeMe-12345` unless `SEED_PASSWORD` is set).

Tablet POS as an iOS/Android app with network receipt printing and standalone card terminal: see `pos-app/README.md`.

Full stack in containers: `cp docker/.env.example docker/.env`, fill it in, then `docker compose -f docker/docker-compose.yml up --build`. Back-office :8080, POS :8081, storefront :8082, careers :8083.

## Test
```bash
cd backend && npm test && npx jest --config ./test/jest-e2e.json --forceExit && npm run lint:schema
```

## Read this before using it for real
- **No UI has been exercised in a browser**; the four React apps are verified by type-check and build only. The native POS app, receipt printer and card flow have never run on a device.
- **Integrations are stubs** (JoFotara, tax filing, social security, aggregators, payment gateway, OCR; card payments are standalone with a keyed approval code). See `docs/INTEGRATIONS.md`.
- **Jordanian tax, social security and payroll values are placeholders.** Payroll cannot be finalized until a person verifies a rule set. The chart of accounts is a starting point for an accountant.
- The OpenRouter interview adapter is implemented but untested against the live API; the AI never rejects a candidate.

Docs: `docs/ARCHITECTURE.md`, `docs/POSTING_MATRIX.md`, `docs/POLICY_RBAC.md`, `docs/INTEGRATIONS.md`.
