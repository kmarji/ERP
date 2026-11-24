import { PrismaService } from './prisma/prisma.service';

// A module ("area") is a controller class. Defaults come from @Roles in code; a company can grant or remove a role's access per area (RolePermission).
export const areaOf = (cls: { name: string }) => cls.name.replace(/Controller$/, '');
// Granting these would let a role manage logins, org structure or approval policy, which is an escalation path: they stay as coded.
export const LOCKED_AREAS = ['Users', 'Tenancy', 'Policy'];

type Overrides = Map<string, boolean>; // `${roleKey}|${area}` -> allow
const cache = new Map<string, { at: number; map: Overrides }>();

export async function overridesFor(prisma: PrismaService, tenantId: string): Promise<Overrides> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 10_000) return hit.map;
  const rows = await prisma.raw.rolePermission.findMany({ where: { tenantId } });
  const map: Overrides = new Map(rows.map((r) => [`${r.roleKey}|${r.area}`, r.allow]));
  cache.set(tenantId, { at: Date.now(), map });
  return map;
}
export const invalidateOverrides = (tenantId: string) => cache.delete(tenantId);

// Does a user holding `keys` reach something that @Roles(required) protects, in `area`?
export function reaches(required: string[], area: string, keys: string[], ov: Overrides): boolean {
  const ownerOnly = required.length === 1 && required[0] === 'OWNER';
  return keys.some((k) => {
    if (k === 'OWNER') return required.includes('OWNER'); // matrix edits never apply to the owner role: it keeps exactly its coded access
    const o = LOCKED_AREAS.includes(area) ? undefined : ov.get(`${k}|${area}`);
    if (o === false) return false;
    if (required.includes(k)) return true;
    return o === true && !ownerOnly;
  });
}
