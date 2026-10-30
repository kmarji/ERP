// Demo data. Idempotent: re-running skips an existing demo tenant.
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { TenancyService } from '../src/modules/tenancy/tenancy.service';

const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe-12345';

async function main() {
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    if (await prisma.raw.tenant.findUnique({ where: { slug: 'demo' } })) {
      console.log('demo tenant already exists, skipping');
      return;
    }
    const t = await new TenancyService(prisma).bootstrap({
      name: 'Demo Cafe Group',
      slug: 'demo',
      ownerEmail: 'owner@demo.test',
      ownerName: 'Demo Owner',
      ownerPassword: PASSWORD,
    });

    await runWithTenant(t.tenantId, async () => {
      const db = prisma.db;
      const branches = await Promise.all(
        [
          ['AMM1', 'Amman - Abdoun'],
          ['AMM2', 'Amman - Sweifieh'],
          ['IRB1', 'Irbid'],
        ].map(([code, name]) => db.branch.create({ data: { tenantId: t.tenantId, legalEntityId: t.legalEntityId, code, name } })),
      );
      for (const b of branches) {
        await db.stockLocation.create({ data: { tenantId: t.tenantId, branchId: b.id, code: `${b.code}-MAIN`, name: `${b.name} store` } });
        await db.costCenter.create({ data: { tenantId: t.tenantId, branchId: b.id, code: b.code, name: b.name } });
      }

      const roles = await db.role.findMany();
      const hash = await bcrypt.hash(PASSWORD, 10);
      const staff: [string, string, string, number][] = [
        ['finance@demo.test', 'Demo Finance', 'FINANCE', -1],
        ['procurement@demo.test', 'Demo Procurement', 'PROCUREMENT', -1],
        ['hr@demo.test', 'Demo HR', 'HR', -1],
        ['manager.amm1@demo.test', 'Manager Abdoun', 'BRANCH_MANAGER', 0],
        ['cashier.amm1@demo.test', 'Cashier Abdoun', 'CASHIER', 0],
      ];
      for (const [email, name, roleKey, branchIdx] of staff) {
        const u = await db.user.create({ data: { tenantId: t.tenantId, email, name, passwordHash: hash } });
        await db.userRole.create({
          data: {
            tenantId: t.tenantId,
            userId: u.id,
            roleId: roles.find((r) => r.key === roleKey)!.id,
            branchId: branchIdx >= 0 ? branches[branchIdx].id : null,
          },
        });
      }
    });
    console.log(`seeded tenant "demo" (login: tenant=demo, owner@demo.test / ${PASSWORD})`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
