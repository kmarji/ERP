import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { DEFAULT_ROLES } from '../../common/roles';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { seedFinanceDefaults } from '../finance/defaults';
import { seedPolicyDefaults } from '../policy-engine/defaults';

@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  // Creates a tenant with default roles, a primary legal entity, an owner user and a machine identity.
  async bootstrap(input: { name: string; slug: string; ownerEmail: string; ownerName: string; ownerPassword: string; legalEntityName?: string }) {
    let tenant;
    try {
      tenant = await this.prisma.raw.tenant.create({ data: { name: input.name, slug: input.slug } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Tenant slug already exists');
      throw e;
    }
    const passwordHash = await bcrypt.hash(input.ownerPassword, 10);
    // The machine identity gets an unguessable password and is blocked from interactive login anyway.
    const systemHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    return runWithTenant(tenant.id, async () => {
      const db = this.prisma.db;
      await db.role.createMany({ data: DEFAULT_ROLES.map((r) => ({ tenantId: tenant.id, key: r.key, name: r.name, rank: r.rank })) });
      const roles = await db.role.findMany();
      const roleId = (k: string) => roles.find((r) => r.key === k)!.id;
      const le = await db.legalEntity.create({ data: { tenantId: tenant.id, name: input.legalEntityName ?? input.name } });
      const owner = await db.user.create({
        data: { tenantId: tenant.id, email: input.ownerEmail.toLowerCase(), name: input.ownerName, passwordHash },
      });
      await db.userRole.create({ data: { tenantId: tenant.id, userId: owner.id, roleId: roleId('OWNER') } });
      const sys = await db.user.create({
        data: { tenantId: tenant.id, email: `system@${tenant.slug}.internal`, name: 'System automation', passwordHash: systemHash, isSystem: true },
      });
      await db.userRole.create({ data: { tenantId: tenant.id, userId: sys.id, roleId: roleId('SYSTEM') } });
      await seedFinanceDefaults(db, tenant.id);
      await seedPolicyDefaults(db, tenant.id);
      return { tenantId: tenant.id, slug: tenant.slug, legalEntityId: le.id, ownerId: owner.id, systemUserId: sys.id };
    });
  }
}
