// Adds any default policies, limits, accounts and tax codes introduced since a tenant was created.
// Safe to re-run: only missing rows are inserted, existing configuration is never overwritten.
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { seedFinanceDefaults } from '../src/modules/finance/defaults';
import { seedPolicyDefaults } from '../src/modules/policy-engine/defaults';

async function main() {
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const tenants = await prisma.raw.tenant.findMany({ select: { id: true, slug: true } });
    for (const t of tenants) {
      await runWithTenant(t.id, async () => {
        await seedFinanceDefaults(prisma.db, t.id);
        await seedPolicyDefaults(prisma.db, t.id);
      });
      console.log(`synced defaults for ${t.slug}`);
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
