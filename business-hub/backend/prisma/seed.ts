// Demo data. Idempotent: re-running skips an existing demo tenant.
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { FieldCrypto } from '../src/common/crypto/field-crypto';
import { SequenceService } from '../src/common/prisma/sequence.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { TenancyService } from '../src/modules/tenancy/tenancy.service';

const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe-12345';

// Demo menu and one enrolled POS tablet for the first branch. Each part is skipped if it already exists.
async function seedMenuAndDevice(prisma: PrismaService, tenantId: string) {
  await runWithTenant(tenantId, async () => {
    const db = prisma.db;
    const vat = await db.taxCode.findFirst({ where: { code: 'S16' } }); // placeholder 16% standard rate
    if (!(await db.menuItem.count())) {
      const cats: [string, string, [string, string, string, number][]][] = [
        ['Hot Drinks', 'مشروبات ساخنة', [['ESP', 'Espresso', 'إسبريسو', 1.5], ['LAT', 'Latte', 'لاتيه', 2.5], ['CAP', 'Cappuccino', 'كابتشينو', 2.5], ['TEA', 'Mint Tea', 'شاي بالنعناع', 1.25]]],
        ['Cold Drinks', 'مشروبات باردة', [['ICE', 'Iced Latte', 'لاتيه مثلج', 3], ['LEM', 'Lemonade', 'ليموناضة', 2]]],
        ['Bakery', 'مخبوزات', [['CRO', 'Butter Croissant', 'كرواسون', 1.75], ['ZAA', 'Zaatar Manousheh', 'منقوشة زعتر', 1.5]]],
      ];
      for (const [i, [name, nameAr, items]] of cats.entries()) {
        const c = await db.menuCategory.create({ data: { tenantId, name, nameAr, sortOrder: i + 1 } });
        for (const [sku, n, ar, price] of items) await db.menuItem.create({ data: { tenantId, sku, name: n, nameAr: ar, categoryId: c.id, price, taxCodeId: vat?.id ?? null } });
      }
      console.log('seeded demo menu (8 items with tax code S16; no recipes)');
    }
    if (vat && (await db.menuItem.updateMany({ where: { taxCodeId: null }, data: { taxCodeId: vat.id } })).count) console.log('attached tax code S16 (placeholder 16%) to menu items');
    for (const [code, delivery] of [['AMM1', true], ['AMM2', false]] as const) {
      const b = await db.branch.findFirst({ where: { code } });
      if (b && !(await db.onlineStoreConfig.count({ where: { branchId: b.id } }))) {
        await db.onlineStoreConfig.create({ data: { tenantId, branchId: b.id, enabled: true, pickupEnabled: true, deliveryEnabled: delivery, deliveryFee: 1, minOrder: 3, serviceAreas: delivery ? ['Abdoun', 'Sweifieh', 'Jabal Amman'] : [], prepMinutes: 15 } });
        console.log(`enabled online ordering for ${code}${delivery ? ' (pickup + delivery)' : ' (pickup only)'}`);
      }
    }
    const branch = await db.branch.findFirst({ where: { code: 'AMM1' } });
    if (branch && !(await db.device.count({ where: { name: 'Demo Tablet 1' } }))) {
      const key = randomBytes(24).toString('hex');
      const owner = await db.user.findFirst({ where: { email: 'owner@demo.test' } });
      const d = await db.device.create({ data: { tenantId, branchId: branch.id, name: 'Demo Tablet 1', keyHash: createHash('sha256').update(key).digest('hex'), enrolledBy: owner?.id ?? 'seed' } });
      console.log(`enrolled POS device "Demo Tablet 1" (AMM1)\n  device id:  ${d.id}\n  device key: ${key}  (shown once)`);
    }
  });
}

// Suppliers with priced items, positions, an open vacancy and employees with contracts, so purchasing, careers and payroll demo
// without setup. Bank accounts are encrypted with DATA_ENCRYPTION_KEY: run the seed with the same key the backend uses
// (docker/.env), or payroll will show those employees as having no bank account.
async function seedPeopleAndSupply(prisma: PrismaService, tenantId: string) {
  const crypto = new FieldCrypto(new ConfigService());
  const sequences = new SequenceService(prisma);
  await runWithTenant(tenantId, async () => {
    const db = prisma.db;
    const owner = await db.user.findFirstOrThrow({ where: { email: 'owner@demo.test' } });
    const entity = await db.legalEntity.findFirstOrThrow();
    const branches = await db.branch.findMany({ orderBy: { code: 'asc' } });
    const b1 = branches.find((b) => b.code === 'AMM1')!;
    const b2 = branches.find((b) => b.code === 'AMM2')!;

    if (!(await db.supplier.count())) {
      const products: [string, string, string, string, string][] = [
        ['MILK-1L', 'Fresh milk 1L', 'حليب طازج', 'L', 'Dairy'],
        ['COF-1KG', 'Espresso beans 1kg', 'حبوب إسبريسو', 'kg', 'Coffee'],
        ['FLR-25KG', 'Flour 25kg sack', 'طحين', 'kg', 'Bakery'],
        ['CUP-12OZ', 'Paper cup 12oz', 'كوب ورقي', 'pc', 'Packaging'],
      ];
      const made = [];
      for (const [sku, name, nameAr, baseUnit, category] of products) made.push(await db.product.create({ data: { tenantId, sku, name, nameAr, baseUnit, category } }));
      const suppliers: [string, string, [number, string, number][]][] = [
        ['Jordan Dairy Co.', '9001001', [[0, 'JD-MILK', 0.85]]],
        ['Levant Coffee Roasters', '9001002', [[1, 'LCR-ESP', 14.5], [3, 'LCR-CUP', 0.04]]],
        ['Amman Mills', '9001003', [[2, 'AM-FLR25', 0.6]]],
      ];
      for (const [name, taxNumber, items] of suppliers) {
        const sup = await db.supplier.create({ data: { tenantId, name, taxNumber, paymentTermsDays: 30 } });
        for (const [pi, supplierSku, price] of items) await db.supplierItem.create({ data: { tenantId, supplierId: sup.id, productId: made[pi].id, supplierSku, unit: made[pi].baseUnit, agreedPrice: price, preferred: true } });
      }
      console.log('seeded 3 suppliers with 4 priced products');
    }

    if (!(await db.jobPosition.count())) {
      const barista = await db.jobPosition.create({ data: { tenantId, title: 'Barista', titleAr: 'باريستا', payBandMin: 350, payBandMax: 500, requiredSkills: ['coffee'], trainingModules: [{ title: 'Food safety', mandatory: true, dueDays: 14 }] } });
      const cashier = await db.jobPosition.create({ data: { tenantId, title: 'Cashier', titleAr: 'كاشير', payBandMin: 300, payBandMax: 420 } });
      await db.headcountBudget.create({ data: { tenantId, branchId: b1.id, positionId: barista.id, approved: 4 } });
      await db.headcountBudget.create({ data: { tenantId, branchId: b2.id, positionId: cashier.id, approved: 2 } });
      const number = await sequences.next('VAC', 'VAC');
      const v = await db.vacancy.create({ data: { tenantId, number, branchId: b1.id, legalEntityId: entity.id, positionId: barista.id, headcount: 1, payMin: 350, payMax: 500, status: 'OPEN', publicCode: randomBytes(6).toString('base64url'), requestedBy: owner.id } });
      console.log(`seeded open vacancy ${number}: /demo/${v.publicCode} on the careers site`);
    }

    if (!(await db.employee.count())) {
      const positions = await db.jobPosition.findMany();
      const pos = (t: string) => positions.find((p) => p.title === t)!.id;
      const staff: [string, string, string, string, number, string | null][] = [
        ['Omar Haddad', 'عمر حداد', 'Barista', b1.id, 450, 'JO94CBJO0010000000000131000301'],
        ['Lina Nasser', 'لينا ناصر', 'Barista', b1.id, 420, 'JO94CBJO0010000000000131000302'],
        ['Yousef Khalil', 'يوسف خليل', 'Cashier', b1.id, 380, 'JO94CBJO0010000000000131000303'],
        ['Rana Salem', 'رنا سالم', 'Cashier', b2.id, 360, 'JO94CBJO0010000000000131000304'],
        ['Tariq Mansour', 'طارق منصور', 'Barista', b2.id, 400, null], // no bank account: shows the payroll exception
      ];
      const hire = new Date('2025-01-01');
      for (const [i, [name, nameAr, title, branchId, basic, iban]] of staff.entries()) {
        const number = await sequences.next('EMP', 'EMP');
        await db.employee.create({
          data: {
            tenantId, number, legalEntityId: entity.id, name, nameAr, phone: `07900000${10 + i}`, status: 'ACTIVE', hireDate: hire, positionId: pos(title),
            sensitive: iban ? crypto.encrypt({ iban }) : null,
            contracts: { create: { tenantId, version: 1, type: 'PERMANENT', startDate: hire, salaryBasic: basic, allowances: [{ name: 'Transport', amount: 30 }], weeklyHours: 48 } },
            assignments: { create: { tenantId, branchId, isPrimary: true, validFrom: hire } },
          },
        });
      }
      console.log('seeded 5 employees with contracts (one without a bank account)');
    }
  });
}

async function main() {
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const existing = await prisma.raw.tenant.findUnique({ where: { slug: 'demo' } });
    if (existing) {
      console.log('demo tenant already exists');
      await seedMenuAndDevice(prisma, existing.id);
      await seedPeopleAndSupply(prisma, existing.id);
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
    await seedMenuAndDevice(prisma, t.tenantId);
    await seedPeopleAndSupply(prisma, t.tenantId);
    console.log(`seeded tenant "demo" (login: tenant=demo, owner@demo.test / ${PASSWORD})`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
