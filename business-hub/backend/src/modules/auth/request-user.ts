import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';

// Loads roles and active delegations fresh, so a revoked role stops working immediately. Needs a tenant context.
export async function loadRequestUser(prisma: PrismaService, where: { id?: string; email?: string }): Promise<RequestUser | null> {
  const user = await prisma.db.user.findFirst({ where, include: { roles: { include: { role: true } } } });
  if (!user || !user.active) return null;
  const now = new Date();
  const delegations = await prisma.db.delegation.findMany({ where: { toUserId: user.id, startsAt: { lte: now }, endsAt: { gte: now }, revokedAt: null } });
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    isSystem: user.isSystem,
    roles: user.roles.map((r) => ({ key: r.role.key, legalEntityId: r.legalEntityId, branchId: r.branchId })),
    delegations: delegations.map((d) => ({ roleKey: d.roleKey, branchId: d.branchId })),
  };
}
