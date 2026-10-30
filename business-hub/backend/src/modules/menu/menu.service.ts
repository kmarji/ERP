import { BadRequestException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { Decimal, d, money, qty as roundQty } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';

export interface ResolvedLine {
  menuItemId: string;
  variantId: string | null;
  name: string;
  nameAr: string | null;
  unitPrice: Decimal; // tax-inclusive, after branch override, variant and modifiers
  modifiers: { id: string; name: string; priceDelta: string }[];
  taxRate: Decimal;
  stationKey: string | null;
}

const APPLY_PRICE = 'menu.apply_price';

// "HH:MM" in Jordan local time; windows may wrap midnight (22:00-02:00).
const ammanHHMM = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit', hour12: false }).format(at).replace(/^24/, '00');
const inWindow = (from: string | null, to: string | null, now: string) => (!from || !to ? true : from <= to ? now >= from && now <= to : now >= from || now <= to);

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
  ) {}

  private async taxRateOf(taxCodeId: string | null) {
    if (!taxCodeId) return d(0);
    const t = await this.prisma.db.taxCode.findFirst({ where: { id: taxCodeId } });
    return d(t?.rate);
  }

  private itemWithModifiers(id: string) {
    return this.prisma.db.menuItem.findFirst({
      where: { id },
      include: { variants: true, modifierGroups: { include: { group: { include: { modifiers: true } } } } },
    });
  }

  // Validates the item is active, inside its scheduled window (Asia/Amman) and available at the branch, and that
  // modifier selections respect each group's min/max. Throws BadRequestException otherwise.
  async resolveLine(input: { menuItemId: string; variantId?: string | null; modifierIds?: string[]; branchId: string; at?: Date }): Promise<ResolvedLine> {
    const item = await this.itemWithModifiers(input.menuItemId);
    if (!item) throw new BadRequestException('Unknown menu item');
    if (!item.active) throw new BadRequestException(`${item.name} is not active`);
    if (!inWindow(item.availableFrom, item.availableTo, ammanHHMM(input.at ?? new Date()))) {
      throw new BadRequestException(`${item.name} is only served ${item.availableFrom}-${item.availableTo}`);
    }
    const override = await this.prisma.db.branchMenuItem.findFirst({ where: { branchId: input.branchId, menuItemId: item.id } });
    if (override && !override.available) throw new BadRequestException(`${item.name} is unavailable at this branch (out of stock)`);

    let price = d(override?.price ?? item.price);
    let variantId: string | null = null;
    if (input.variantId) {
      const v = item.variants.find((x) => x.id === input.variantId);
      if (!v) throw new BadRequestException('Variant does not belong to this item');
      variantId = v.id;
      price = price.plus(v.priceDelta);
    }

    const picked = input.modifierIds ?? [];
    const modifiers: ResolvedLine['modifiers'] = [];
    const perGroup = new Map<string, number>();
    for (const mid of picked) {
      const group = item.modifierGroups.map((l) => l.group).find((g) => g.modifiers.some((m) => m.id === mid));
      const mod = group?.modifiers.find((m) => m.id === mid);
      if (!group || !mod) throw new BadRequestException('Modifier is not offered with this item');
      if (!mod.active) throw new BadRequestException(`Modifier ${mod.name} is not active`);
      perGroup.set(group.id, (perGroup.get(group.id) ?? 0) + 1);
      price = price.plus(mod.priceDelta);
      modifiers.push({ id: mod.id, name: mod.name, priceDelta: d(mod.priceDelta).toString() });
    }
    for (const { group } of item.modifierGroups) {
      const n = perGroup.get(group.id) ?? 0;
      if (n < group.minSelect) throw new BadRequestException(`Choose at least ${group.minSelect} of "${group.name}"`);
      if (n > group.maxSelect) throw new BadRequestException(`Choose at most ${group.maxSelect} of "${group.name}"`);
    }

    return { menuItemId: item.id, variantId, name: item.name, nameAr: item.nameAr, unitPrice: money(price), modifiers, taxRate: await this.taxRateOf(item.taxCodeId), stationKey: item.stationKey };
  }

  // Base-unit ingredient quantities consumed by selling `qty` of the item (recipe scaled by variant and yield,
  // plus modifier ingredients; combos explode into their components). No recipe means no consumption.
  async consumptionFor(input: { menuItemId: string; variantId?: string | null; modifierIds?: string[]; qty: number }): Promise<{ productId: string; qtyBase: Decimal }[]> {
    const totals = new Map<string, Decimal>();
    await this.accumulate(totals, input.menuItemId, input.variantId ?? null, input.modifierIds ?? [], d(input.qty), 0);
    return [...totals].map(([productId, qtyBase]) => ({ productId, qtyBase: roundQty(qtyBase) }));
  }

  private async accumulate(totals: Map<string, Decimal>, menuItemId: string, variantId: string | null, modifierIds: string[], qty: Decimal, depth: number) {
    if (depth > 3) throw new BadRequestException('Combo nesting is too deep');
    const add = (productId: string, q: Decimal) => totals.set(productId, (totals.get(productId) ?? d(0)).plus(q));
    const db = this.prisma.db;
    const item = await db.menuItem.findFirst({ where: { id: menuItemId }, include: { components: true } });
    if (!item) throw new BadRequestException('Unknown menu item');

    for (const c of item.components) await this.accumulate(totals, c.componentItemId, null, [], qty.times(c.qty), depth + 1);

    const own = variantId ? await db.recipe.findFirst({ where: { menuItemId, variantKey: variantId }, include: { ingredients: true } }) : null;
    const recipe = own ?? (await db.recipe.findFirst({ where: { menuItemId, variantKey: '' }, include: { ingredients: true } }));
    if (recipe) {
      // The variant's size factor only applies when it falls back to the base recipe; an explicit variant recipe is already sized.
      const scale = !own && variantId ? d((await db.menuItemVariant.findFirst({ where: { id: variantId, menuItemId } }))?.recipeScale ?? 1) : d(1);
      for (const i of recipe.ingredients) add(i.productId, d(i.qtyBase).times(qty).div(recipe.yield).times(scale));
    }
    if (modifierIds.length) {
      const ings = await db.modifierIngredient.findMany({ where: { modifierId: { in: modifierIds } } });
      for (const i of ings) add(i.productId, d(i.qtyBase).times(qty));
    }
  }

  // Everything an offline tablet needs to sell: items, variants, modifiers, effective branch prices, tax rates.
  async offlineBundle(branchId: string): Promise<Record<string, unknown>> {
    const [items, overrides, taxes, categories, tables] = await Promise.all([
      this.prisma.db.menuItem.findMany({
        where: { active: true },
        include: { variants: true, components: true, modifierGroups: { include: { group: { include: { modifiers: { where: { active: true } } } } } } },
        orderBy: { sku: 'asc' },
      }),
      this.prisma.db.branchMenuItem.findMany({ where: { branchId } }),
      this.prisma.db.taxCode.findMany(),
      this.prisma.db.menuCategory.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.db.diningTable.findMany({ where: { branchId }, orderBy: { name: 'asc' } }),
    ]);
    const rate = new Map(taxes.map((t) => [t.id, d(t.rate).toString()]));
    const ov = new Map(overrides.map((o) => [o.menuItemId, o]));
    const out = items.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      nameAr: i.nameAr,
      categoryId: i.categoryId,
      price: money(ov.get(i.id)?.price ?? i.price).toString(),
      available: ov.get(i.id)?.available ?? true,
      taxRate: i.taxCodeId ? rate.get(i.taxCodeId) ?? '0' : '0',
      stationKey: i.stationKey,
      isCombo: i.isCombo,
      availableFrom: i.availableFrom,
      availableTo: i.availableTo,
      variants: i.variants.map((v) => ({ id: v.id, name: v.name, nameAr: v.nameAr, priceDelta: d(v.priceDelta).toString() })),
      modifierGroups: i.modifierGroups.map((l) => ({
        id: l.group.id,
        name: l.group.name,
        minSelect: l.group.minSelect,
        maxSelect: l.group.maxSelect,
        modifiers: l.group.modifiers.map((m) => ({ id: m.id, name: m.name, priceDelta: d(m.priceDelta).toString() })),
      })),
    }));
    // A device compares this to know whether its cached menu is stale.
    const priceVersion = createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16);
    return {
      branchId,
      generatedAt: new Date().toISOString(),
      priceVersion,
      taxInclusive: true,
      categories: categories.map((c) => ({ id: c.id, name: c.name, nameAr: c.nameAr, sortOrder: c.sortOrder })),
      tables: tables.map((t) => ({ id: t.id, name: t.name, seats: t.seats })),
      items: out,
    };
  }

  // ---------------------------------------------------------------- policy-gated price changes

  async effectivePrice(menuItemId: string, branchId?: string | null): Promise<Decimal> {
    const item = await this.prisma.db.menuItem.findFirst({ where: { id: menuItemId } });
    if (!item) throw new BadRequestException('Unknown menu item');
    const ov = branchId ? await this.prisma.db.branchMenuItem.findFirst({ where: { branchId, menuItemId } }) : null;
    return d(ov?.price ?? item.price);
  }

  // Small changes apply at once; a larger move waits for the approver the policy names.
  async changePrice(menuItemId: string, newPrice: number, user: RequestUser, branchId?: string | null) {
    const oldPrice = await this.effectivePrice(menuItemId, branchId);
    const next = money(newPrice);
    const pct = oldPrice.isZero() ? 100 : next.minus(oldPrice).abs().div(oldPrice).times(100).toDecimalPlaces(4).toNumber();
    const decision = await this.policy.evaluate('menu.price_change', { variancePct: pct, branchId: branchId ?? undefined });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Price changes are blocked by policy');
    const auto = decision.decision === 'AUTO';
    const change = await this.prisma.db.priceChange.create({
      data: { tenantId: '', menuItemId, branchId: branchId ?? null, oldPrice, newPrice: next, pct, status: auto ? 'APPLIED' : 'PENDING', requestedBy: user.id },
    });
    if (auto) {
      await this.applyPrice(change.menuItemId, change.branchId, next);
      await this.audit.record({ action: 'menu.price_changed', entityType: 'MenuItem', entityId: menuItemId, policyVersion: decision.policyVersion, before: { price: oldPrice.toString() }, after: { price: next.toString(), branchId, pct } });
    } else {
      await this.approvals.request({ subjectType: 'PriceChange', subjectId: change.id, action: APPLY_PRICE, approverRole: decision.approverRole!, branchId: branchId ?? undefined });
      await this.audit.record({ action: 'menu.price_change_requested', entityType: 'PriceChange', entityId: change.id, policyVersion: decision.policyVersion, after: { menuItemId, oldPrice: oldPrice.toString(), newPrice: next.toString(), pct } });
    }
    return { change, applied: auto };
  }

  private async applyPrice(menuItemId: string, branchId: string | null, price: Decimal) {
    const db = this.prisma.db;
    if (!branchId) {
      await db.menuItem.updateMany({ where: { id: menuItemId }, data: { price } });
      return;
    }
    const res = await db.branchMenuItem.updateMany({ where: { branchId, menuItemId }, data: { price } });
    if (res.count === 0) await db.branchMenuItem.create({ data: { tenantId: currentTenantId(), branchId, menuItemId, price } });
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== APPLY_PRICE) return;
    await runWithTenant(e.tenantId, async () => {
      const change = await this.prisma.db.priceChange.findFirst({ where: { id: e.subjectId, status: 'PENDING' } });
      if (!change) return;
      if (e.approved) {
        await this.applyPrice(change.menuItemId, change.branchId, d(change.newPrice));
        await this.prisma.db.priceChange.updateMany({ where: { id: change.id }, data: { status: 'APPLIED' } });
        await this.audit.record({ action: 'menu.price_changed', entityType: 'MenuItem', entityId: change.menuItemId, before: { price: d(change.oldPrice).toString() }, after: { price: d(change.newPrice).toString(), branchId: change.branchId, approvedBy: e.decidedBy } });
      } else {
        await this.prisma.db.priceChange.updateMany({ where: { id: change.id }, data: { status: 'REJECTED' } });
        await this.audit.record({ action: 'menu.price_change_rejected', entityType: 'PriceChange', entityId: change.id });
      }
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ---------------------------------------------------------------- reports

  // Recipe cost per portion at the weighted-average cost of stock held across all locations.
  async costing(branchId?: string) {
    const items = await this.prisma.db.menuItem.findMany({ where: { active: true }, orderBy: { sku: 'asc' } });
    const [balances, taxes] = await Promise.all([this.prisma.db.stockBalance.findMany(), this.prisma.db.taxCode.findMany()]);
    const agg = new Map<string, { qty: Decimal; value: Decimal }>();
    for (const b of balances) {
      const cur = agg.get(b.productId) ?? { qty: d(0), value: d(0) };
      agg.set(b.productId, { qty: cur.qty.plus(b.qtyBase), value: cur.value.plus(b.value) });
    }
    const rate = new Map(taxes.map((t) => [t.id, d(t.rate)]));
    const rows = [];
    for (const i of items) {
      const price = await this.effectivePrice(i.id, branchId);
      const taxRate = i.taxCodeId ? rate.get(i.taxCodeId) ?? d(0) : d(0);
      const net = money(price.div(taxRate.plus(1)));
      let cost = d(0);
      let noCost = false;
      for (const c of await this.consumptionFor({ menuItemId: i.id, qty: 1 })) {
        const a = agg.get(c.productId);
        if (!a || !a.qty.gt(0)) noCost = true;
        else cost = cost.plus(c.qtyBase.times(a.value.div(a.qty)));
      }
      const margin = net.minus(money(cost));
      rows.push({
        menuItemId: i.id,
        sku: i.sku,
        name: i.name,
        price: money(price).toString(),
        taxRate: taxRate.toString(),
        netPrice: net.toString(),
        cost: money(cost).toString(),
        noCost,
        margin: margin.toString(),
        marginPct: net.isZero() ? null : margin.div(net).times(100).toDecimalPlaces(2).toString(),
      });
    }
    return rows;
  }
}
