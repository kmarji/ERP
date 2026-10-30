import { ForbiddenException } from '@nestjs/common';
import { RequestUser } from './tenant-context';

// A role scoped to one branch only grants access to that branch; HQ-wide roles (branchId null) reach every branch.
// Only roles the endpoint accepts count, so a branch cashier role cannot widen access granted by another role.
export function assertBranchAccess(user: RequestUser, branchId: string, roleKeys: readonly string[]) {
  const ok =
    user.roles.some((r) => roleKeys.includes(r.key) && (r.branchId === null || r.branchId === branchId)) ||
    user.delegations.some((d) => roleKeys.includes(d.roleKey) && (d.branchId === null || d.branchId === branchId));
  if (!ok) throw new ForbiddenException('Your role does not cover this branch');
}
