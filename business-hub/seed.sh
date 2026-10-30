#!/usr/bin/env bash
# Seeds the demo tenant (users, menu, POS tablet, online store, suppliers, vacancy, employees) into the database
# that docker compose is running. Safe to run again: existing data is left alone.
# Usage: ./seed.sh        (after: cd docker && cp .env.example .env && edit it && docker compose up -d --build)
set -euo pipefail
cd "$(dirname "$0")"

[ -f docker/.env ] || { echo "docker/.env is missing: copy docker/.env.example and fill it in first" >&2; exit 1; }
set -a; . docker/.env; set +a

# Wait for the backend (it applies database migrations on start).
echo -n "Waiting for the backend"
for _ in $(seq 1 60); do
  curl -fs -o /dev/null http://localhost:3000/docs && break
  echo -n "."; sleep 2
done
curl -fs -o /dev/null http://localhost:3000/docs || { echo; echo "Backend is not answering on :3000. Is docker compose up?" >&2; exit 1; }
echo " ready"

cd backend
[ -d node_modules ] || npm ci
npx prisma generate >/dev/null
# Same database as the containers (published on localhost:5432) and the same encryption key as the backend.
export DATABASE_URL="postgresql://hub:hub@localhost:5432/business_hub"
export JWT_SECRET DATA_ENCRYPTION_KEY
npx ts-node prisma/seed.ts 2>&1 | grep -v "DeprecationWarning\|trace-deprecation"
