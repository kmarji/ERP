import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { MANAGERS } from '../workforce/common';

// Branch-scoped managers see only their branches; a company-wide role (branchId null) sees all.
export function branchFilter(user: RequestUser, branchId?: string): { branchId?: string | { in: string[] } } {
  if (branchId) { assertBranchAccess(user, branchId, MANAGERS); return { branchId }; }
  const b = [...user.roles.filter((r) => MANAGERS.includes(r.key as any)).map((r) => r.branchId), ...user.delegations.filter((d) => MANAGERS.includes(d.roleKey as any)).map((d) => d.branchId)];
  return b.includes(null) ? {} : { branchId: { in: b as string[] } };
}

export const isCompanyWide = (user: RequestUser) => user.roles.some((r) => r.branchId === null && MANAGERS.includes(r.key as any));
