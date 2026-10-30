// Prisma has no mixins, so the shared business-event shape (brief 4.1) is enforced here.
// Models tagged "// @businessEvent" must carry idempotency/correlation/audit fields and a tenant-scoped unique key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = ['tenantId', 'idempotencyKey', 'correlationId', 'createdAt', 'createdBy'];
const src = readFileSync(join(__dirname, 'schema.prisma'), 'utf8').split('\n');

const errors: string[] = [];
let checked = 0;
for (let i = 0; i < src.length; i++) {
  if (src[i].trim() !== '// @businessEvent') continue;
  const header = src[i + 1]?.match(/^model\s+(\w+)\s*\{/);
  if (!header) {
    errors.push(`line ${i + 1}: @businessEvent tag must be directly above a model`);
    continue;
  }
  const name = header[1];
  let j = i + 2;
  const body: string[] = [];
  while (j < src.length && src[j].trim() !== '}') body.push(src[j++]);
  const fields = new Set(body.map((l) => l.trim().split(/\s+/)[0]));
  for (const f of REQUIRED) if (!fields.has(f)) errors.push(`${name}: missing field ${f}`);
  if (!body.some((l) => /@@unique\(\[tenantId,\s*idempotencyKey\]\)/.test(l))) {
    errors.push(`${name}: missing @@unique([tenantId, idempotencyKey])`);
  }
  checked++;
}

// Every model except Tenant must be tenant-scoped, or the isolation extension cannot protect it.
let model: string | null = null;
let hasTenant = false;
for (const line of src) {
  const m = line.match(/^model\s+(\w+)\s*\{/);
  if (m) {
    model = m[1];
    hasTenant = false;
  } else if (model && /^\s+tenantId\s/.test(line)) {
    hasTenant = true;
  } else if (model && line.trim() === '}') {
    if (!hasTenant && model !== 'Tenant') errors.push(`${model}: no tenantId (not covered by tenant scoping)`);
    model = null;
  }
}

if (errors.length) {
  console.error(errors.map((e) => `schema lint: ${e}`).join('\n'));
  process.exit(1);
}
console.log(`schema lint ok (${checked} business-event model(s) checked)`);
