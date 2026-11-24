import { Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { areaOf, LOCKED_AREAS, overridesFor } from '../../common/permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { ROLES_KEY } from '../auth/auth.decorators';

const HINT: Record<string, string> = {
  Workforce: 'Scheduling, time and attendance, leave', People: 'Employees, contracts, SSC, certificate letters', Payroll: 'Payroll runs and rules', Discipline: 'Discipline cases and corrective actions',
  Offboarding: 'Resignations and exits', Onboarding: 'Offers and hiring', Recruitment: 'Vacancies and candidates', Finance: 'Ledger and reports', Purchasing: 'Purchase orders', Receiving: 'Goods receipts',
  Inventory: 'Stock and products', Menu: 'Menu and recipes', Pos: 'Sales and POS devices', Tax: 'Tax filing', Operations: 'Checklists and tasks', Audits: 'Audits and food safety', Learning: 'Training and SOPs',
  OpsOverview: 'Operations dashboard', Customers: 'Customers', Commerce: 'Online store and orders', Documents: 'Documents', Integrations: 'Integrations', Dashboard: 'Owner dashboard',
  Users: 'Users and roles (fixed)', Tenancy: 'Organization structure (fixed)', Policy: 'Approval policies (fixed)', Workflow: 'Exceptions and approvals',
};
const label = (a: string) => a.replace(/([a-z])([A-Z])/g, '$1 $2');

@Injectable()
export class AccessService {
  private built: { area: string; label: string; hint: string; locked: boolean; defaults: string[] }[] | null = null;

  constructor(private readonly modules: ModulesContainer, private readonly prisma: PrismaService) {}

  // Every controller with @Roles, and the roles its code allows by default.
  catalog() {
    if (this.built) return this.built;
    const by = new Map<string, Set<string>>();
    for (const m of this.modules.values()) for (const w of m.controllers.values()) {
      const cls = w.metatype as (new () => object) | null;
      if (!cls) continue;
      const set = by.get(areaOf(cls)) ?? new Set<string>();
      for (const r of (Reflect.getMetadata(ROLES_KEY, cls) as string[] | undefined) ?? []) set.add(r);
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = (cls.prototype as Record<string, unknown>)[name];
        if (typeof fn === 'function') for (const r of (Reflect.getMetadata(ROLES_KEY, fn) as string[] | undefined) ?? []) set.add(r);
      }
      by.set(areaOf(cls), set);
    }
    this.built = [...by].filter(([, s]) => s.size).map(([area, s]) => ({ area, label: label(area), hint: HINT[area] ?? '', locked: LOCKED_AREAS.includes(area), defaults: [...s].sort() })).sort((a, b) => a.label.localeCompare(b.label));
    return this.built;
  }

  // Areas this user can reach, for hiding screens they cannot use.
  async areasFor(user: RequestUser) {
    const ov = await overridesFor(this.prisma, user.tenantId);
    const keys = [...user.roles.map((r) => r.key), ...user.delegations.map((d) => d.roleKey)];
    if (user.isSystem || keys.includes('OWNER')) return this.catalog().map((c) => c.area);
    return this.catalog().filter((c) => keys.some((k) => ov.get(`${k}|${c.area}`) !== false && (c.defaults.includes(k) || (!c.locked && ov.get(`${k}|${c.area}`) === true)))).map((c) => c.area);
  }
}
