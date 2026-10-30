import { RequestUser } from './tenant-context';

// Prisma OR-clauses restricting rows to roles the actor holds (directly or by delegation),
// honouring branch scope: an HQ-wide role sees every branch, a branch-limited role only its own.
export function roleVisibility(user: RequestUser, roleField: string, branchField: string | null = 'branchId') {
  const entries: { key: string; branchId: string | null }[] = [
    ...user.roles.map((r) => ({ key: r.key, branchId: r.branchId })),
    ...user.delegations.map((d) => ({ key: d.roleKey, branchId: d.branchId })),
  ];
  return entries.map((e) =>
    e.branchId === null || branchField === null
      ? { [roleField]: e.key }
      : { [roleField]: e.key, OR: [{ [branchField]: null }, { [branchField]: e.branchId }] },
  );
}
