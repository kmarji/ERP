import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { Decimal, d, qty as roundQty } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { CatalogService } from '../catalog/catalog.service';
import { PurchasingService } from '../purchasing/purchasing.service';
import { ExceptionService } from '../workflow-engine/exception.service';

const USAGE_WINDOW_DAYS = 14;
const SYSTEM = { id: 'system', tenantId: '', email: 'system', isSystem: true, roles: [], delegations: [] } as RequestUser;

export interface Suggestion {
  ruleId: string;
  productId: string;
  locationId: string;
  branchId: string;
  onHandBase: string;
  onOrderBase: string;
  dailyUsageBase: string;
  reorderPointBase: string;
  suggestedBase: string;
  orderUnit: string | null;
  orderQty: string | null;
  supplierId: string | null;
  problem: 'NO_SUPPLIER' | null;
}

@Injectable()
export class ReplenishmentService {
  private readonly log = new Logger(ReplenishmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly purchasing: PurchasingService,
    private readonly exceptions: ExceptionService,
  ) {}

  listRules() {
    return this.prisma.db.replenishmentRule.findMany({ orderBy: { productId: 'asc' } });
  }

  async upsertRule(input: { productId: string; locationId: string; minQtyBase: number; maxQtyBase: number; leadTimeDays?: number; supplierId?: string; orderUnit?: string; active?: boolean }) {
    const tenantId = (await this.prisma.db.stockLocation.findFirstOrThrow({ where: { id: input.locationId } })).tenantId;
    const data = { minQtyBase: input.minQtyBase, maxQtyBase: input.maxQtyBase, leadTimeDays: input.leadTimeDays ?? 2, supplierId: input.supplierId ?? null, orderUnit: input.orderUnit ?? null, active: input.active ?? true };
    return this.prisma.db.replenishmentRule.upsert({
      where: { tenantId_productId_locationId: { tenantId, productId: input.productId, locationId: input.locationId } },
      create: { tenantId, productId: input.productId, locationId: input.locationId, ...data },
      update: data,
    });
  }

  // Reorder point = min + expected usage during the supplier lead time. Stock already on order counts as available.
  async suggestions(): Promise<Suggestion[]> {
    const rules = await this.prisma.db.replenishmentRule.findMany({ where: { active: true } });
    if (!rules.length) return [];
    const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000);
    const [balances, usage, locations] = await Promise.all([
      this.prisma.db.stockBalance.findMany({ where: { productId: { in: rules.map((r) => r.productId) } } }),
      this.prisma.db.stockMovement.groupBy({ by: ['productId', 'locationId'], where: { type: 'SALE_CONSUMPTION', occurredAt: { gte: since } }, _sum: { qtyBase: true } }),
      this.prisma.db.stockLocation.findMany({ where: { id: { in: rules.map((r) => r.locationId) } } }),
    ]);
    const onOrder = await this.onOrderBase(rules.map((r) => r.locationId));
    const out: Suggestion[] = [];
    for (const r of rules) {
      const onHand = d(balances.find((b) => b.productId === r.productId && b.locationId === r.locationId)?.qtyBase);
      const ordered = onOrder.get(`${r.productId}|${r.locationId}`) ?? d(0);
      const used = d(usage.find((u) => u.productId === r.productId && u.locationId === r.locationId)?._sum.qtyBase).abs();
      const daily = used.div(USAGE_WINDOW_DAYS);
      const reorderPoint = d(r.minQtyBase).plus(daily.times(r.leadTimeDays));
      const available = onHand.plus(ordered);
      if (available.gt(reorderPoint)) continue;
      const need = d(r.maxQtyBase).minus(available);
      if (!need.gt(0)) continue;

      const item = await this.prisma.db.supplierItem.findFirst({ where: r.supplierId ? { productId: r.productId, supplierId: r.supplierId } : { productId: r.productId, preferred: true } });
      const supplierId = r.supplierId ?? item?.supplierId ?? null;
      let orderUnit: string | null = null;
      let orderQty: Decimal | null = null;
      if (supplierId) {
        const product = await this.prisma.db.product.findFirstOrThrow({ where: { id: r.productId } });
        orderUnit = r.orderUnit ?? item?.unit ?? product.baseUnit;
        const factor = await this.catalog.unitFactor(r.productId, orderUnit);
        orderQty = need.div(factor).toDecimalPlaces(0, Prisma.Decimal.ROUND_UP); // whole order units, never short of par
      }
      out.push({
        ruleId: r.id,
        productId: r.productId,
        locationId: r.locationId,
        branchId: locations.find((l) => l.id === r.locationId)!.branchId,
        onHandBase: onHand.toString(),
        onOrderBase: ordered.toString(),
        dailyUsageBase: roundQty(daily).toString(),
        reorderPointBase: roundQty(reorderPoint).toString(),
        suggestedBase: roundQty(need).toString(),
        orderUnit,
        orderQty: orderQty?.toString() ?? null,
        supplierId,
        problem: supplierId ? null : 'NO_SUPPLIER',
      });
    }
    return out;
  }

  private async onOrderBase(locationIds: string[]) {
    const map = new Map<string, Decimal>();
    const add = async (productId: string, locationId: string, qty: Prisma.Decimal, unit: string) => {
      const f = await this.catalog.unitFactor(productId, unit);
      const k = `${productId}|${locationId}`;
      map.set(k, (map.get(k) ?? d(0)).plus(d(qty).times(f)));
    };
    const poLines = await this.prisma.db.purchaseOrderLine.findMany({ where: { order: { stockLocationId: { in: locationIds }, status: { in: ['PENDING_APPROVAL', 'ISSUED', 'PARTIALLY_RECEIVED'] } } }, include: { order: true } });
    for (const l of poLines) {
      const remaining = d(l.qty).minus(d(l.qtyReceived));
      if (remaining.gt(0)) await add(l.productId, l.order.stockLocationId, remaining, l.unit);
    }
    const prLines = await this.prisma.db.purchaseRequestLine.findMany({ where: { request: { stockLocationId: { in: locationIds }, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } } }, include: { request: true } });
    for (const l of prLines) await add(l.productId, l.request.stockLocationId, l.qty, l.unit);
    return map;
  }

  // Turns suggestions into purchase requests per location. The normal purchasing policy then decides
  // whether each request auto-issues a PO or waits for a delegated approver.
  async run(opts: { dryRun?: boolean } = {}) {
    const suggestions = await this.suggestions();
    if (opts.dryRun) return { suggestions, requests: [] as unknown[] };

    for (const s of suggestions.filter((x) => x.problem === 'NO_SUPPLIER')) {
      const open = await this.prisma.db.exception.findMany({ where: { code: 'REPL_NO_SUPPLIER', status: 'NOTIFIED' } });
      if (open.some((e) => (e.evidence as any)?.ruleId === s.ruleId)) continue;
      await this.exceptions.raise({
        code: 'REPL_NO_SUPPLIER',
        reason: 'Stock is below its reorder point but the product has no supplier to order from',
        evidence: { ruleId: s.ruleId, productId: s.productId, locationId: s.locationId },
        impact: `Suggested order of ${s.suggestedBase} (base units) cannot be created`,
        branchId: s.branchId,
        ownerRole: 'PROCUREMENT',
        riskTier: 'LOW',
        availableActions: ['resolve'],
      });
    }

    const byLocation = new Map<string, Suggestion[]>();
    for (const s of suggestions.filter((x) => !x.problem)) byLocation.set(s.locationId, [...(byLocation.get(s.locationId) ?? []), s]);
    const requests = [];
    for (const [locationId, list] of byLocation) {
      const pr = await this.purchasing.createRequest(
        { branchId: list[0].branchId, stockLocationId: locationId, source: 'REPLENISHMENT', notes: 'Generated by replenishment rules', lines: list.map((s) => ({ productId: s.productId, qty: Number(s.orderQty), unit: s.orderUnit!, supplierId: s.supplierId! })) },
        SYSTEM,
      );
      requests.push(await this.purchasing.submitRequest(pr.id));
    }
    return { suggestions, requests };
  }

  @Cron('0 5 * * *', { timeZone: 'Asia/Amman' })
  async nightlyRun() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) {
      await runWithTenant(t.id, () => this.run()).catch((e) => this.log.error(`replenishment failed for ${t.id}: ${e.message}`));
    }
  }
}
