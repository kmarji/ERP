import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface ScopedRole {
  key: string;
  legalEntityId: string | null;
  branchId: string | null;
}

export interface RequestUser {
  id: string;
  tenantId: string;
  email: string;
  isSystem: boolean;
  roles: ScopedRole[];
  // Active temporary delegations, resolved per request.
  delegations: { roleKey: string; branchId: string | null }[];
}

export interface TenantContext {
  tenantId: string;
  user?: RequestUser;
  correlationId: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(
  tenantId: string,
  fn: () => T,
  user?: RequestUser,
  correlationId: string = randomUUID(),
): T {
  return storage.run({ tenantId, user, correlationId }, () => {
    const result = fn();
    // Prisma queries are lazy: they only start on .then(). Subscribe inside the scope so the query
    // runs with this tenant context even if the caller awaits it later.
    if (result && typeof (result as any).then === 'function') {
      return new Promise((resolve, reject) => (result as any).then(resolve, reject)) as T;
    }
    return result;
  });
}

export function currentContext(): TenantContext | undefined {
  return storage.getStore();
}

export function currentTenantId(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No tenant context: operation must run inside runWithTenant()');
  return ctx.tenantId;
}

export function currentUser(): RequestUser | undefined {
  return storage.getStore()?.user;
}

export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}

// Does the actor hold roleKey for the given scope? HQ-wide roles match any branch.
export function actorHasRole(
  user: RequestUser,
  roleKey: string,
  scope: { branchId?: string | null; legalEntityId?: string | null } = {},
): boolean {
  const direct = user.roles.some(
    (r) =>
      r.key === roleKey &&
      (r.branchId === null || !scope.branchId || r.branchId === scope.branchId) &&
      (r.legalEntityId === null || !scope.legalEntityId || r.legalEntityId === scope.legalEntityId),
  );
  if (direct) return true;
  return user.delegations.some(
    (d) => d.roleKey === roleKey && (d.branchId === null || !scope.branchId || d.branchId === scope.branchId),
  );
}
