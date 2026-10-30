import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { Decimal, d, money, qty as roundQty } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { ammanToday } from '../../common/time';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { FinancePostingService } from '../finance/finance-posting.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { InventoryService } from './inventory.service';

export const INVENTORY_ROLES = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'] as const;
export const WASTAGE_ROLES = [...INVENTORY_ROLES, 'KITCHEN'] as const;
const APPLY_COUNT = 'inventory.apply_count';

@Injectable()
export class InventoryOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly posting: FinancePostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  private async location(id: string) {
    const loc = await this.prisma.db.stockLocation.findFirst({ where: { id }, include: { branch: true } });
    if (!loc) throw new BadRequestException('Unknown stock location');
    return loc;
  }

  private async balance(productId: string, locationId: string) {
    return this.prisma.db.stockBalance.findFirst({ where: { productId, locationId } });
  }

  // ---------------------------------------------------------------- stock counts

  async createCount(input: { locationId: string; productIds?: string[] }, user: RequestUser) {
    const loc = await this.location(input.locationId);
    assertBranchAccess(user, loc.branchId, INVENTORY_ROLES);
    const productIds = input.productIds ?? (await this.prisma.db.stockBalance.findMany({ where: { locationId: input.locationId } })).map((b) => b.productId);
    if (!productIds.length) throw new BadRequestException('Nothing to count: no stock at this location and no productIds given');
    return this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('CNT', 'CNT', tx);
      const count = await tx.stockCount.create({
        data: { tenantId: '', number, locationId: input.locationId, createdBy: user.id, lines: { create: productIds.map((productId) => ({ tenantId: currentTenantId(), productId })) } },
        include: { lines: true },
      });
      await this.audit.record({ action: 'count.opened', entityType: 'StockCount', entityId: count.id, after: { number, lines: productIds.length } }, tx);
      return count;
    });
  }

  async saveCounts(id: string, entries: { productId: string; qty: number; unit?: string }[], user: RequestUser) {
    const count = await this.getCount(id);
    const loc = await this.location(count.locationId);
    assertBranchAccess(user, loc.branchId, INVENTORY_ROLES);
    if (count.status !== 'OPEN') throw new ConflictException(`Count is ${count.status}`);
    for (const e of entries) {
      const product = await this.prisma.db.product.findFirst({ where: { id: e.productId } });
      if (!product) throw new BadRequestException(`Unknown product ${e.productId}`);
      const factor = await this.catalog.unitFactor(e.productId, e.unit ?? product.baseUnit);
      const countedQtyBase = roundQty(d(e.qty).times(factor));
      const res = await this.prisma.db.stockCountLine.updateMany({ where: { countId: id, productId: e.productId }, data: { countedQtyBase } });
      if (res.count === 0) {
        await this.prisma.db.stockCountLine.create({ data: { tenantId: '', countId: id, productId: e.productId, countedQtyBase } });
      }
    }
    return this.getCount(id);
  }

  async getCount(id: string) {
    const c = await this.prisma.db.stockCount.findFirst({ where: { id }, include: { lines: true } });
    if (!c) throw new NotFoundException('Count not found');
    return c;
  }

  listCounts(status?: string) {
    return this.prisma.db.stockCount.findMany({ where: { status: status as any }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  // Variance is measured against the live balance at submit time. Large write-offs wait for a delegated approver.
  async submitCount(id: string, user: RequestUser) {
    const count = await this.getCount(id);
    const loc = await this.location(count.locationId);
    assertBranchAccess(user, loc.branchId, INVENTORY_ROLES);
    if (count.status !== 'OPEN') throw new ConflictException(`Count is ${count.status}`);
    const counted = count.lines.filter((l) => l.countedQtyBase !== null);
    if (!counted.length) throw new BadRequestException('Enter at least one counted quantity first');

    let totalAbs = d(0);
    let variancePct = 0;
    for (const l of counted) {
      const bal = await this.balance(l.productId, count.locationId);
      const expected = d(bal?.qtyBase);
      const variance = d(l.countedQtyBase).minus(expected);
      const value = money(variance.times(d(bal?.avgCost)));
      totalAbs = totalAbs.plus(value.abs());
      if (!variance.isZero()) variancePct = Math.max(variancePct, expected.isZero() ? 100 : variance.abs().div(expected.abs()).times(100).toNumber());
      await this.prisma.db.stockCountLine.updateMany({ where: { id: l.id }, data: { expectedQtyBase: expected, varianceQty: variance, varianceValue: value } });
    }
    await this.prisma.db.stockCount.updateMany({ where: { id }, data: { submittedAt: new Date() } });

    const decision = await this.policy.evaluate('inventory.count_adjustment', { amount: Number(totalAbs), variancePct, branchId: loc.branchId });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Count adjustments are blocked by policy');
    if (decision.decision === 'AUTO') return this.applyCount(id);

    await this.prisma.db.stockCount.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'PENDING_APPROVAL' } });
    const ex = await this.exceptions.raise({
      code: 'INV_COUNT_VARIANCE',
      reason: `Count ${count.number} at ${loc.name}: variance worth ${totalAbs} JOD (${variancePct.toFixed(1)}%) needs approval before stock is adjusted`,
      evidence: { countId: id, totalAbsValue: totalAbs.toString(), variancePct },
      impact: 'Stock and inventory value stay unchanged until approved',
      amount: Number(totalAbs),
      branchId: loc.branchId,
      policyKey: 'inventory.count_adjustment',
      riskTier: 'MEDIUM',
      availableActions: ['approve', 'reject'],
    });
    await this.approvals.request({ subjectType: 'StockCount', subjectId: id, action: APPLY_COUNT, approverRole: ex.ownerRole!, amount: Number(totalAbs), exceptionId: ex.id, branchId: loc.branchId });
    return this.getCount(id);
  }

  async applyCount(id: string) {
    const applied = await this.prisma.db.$transaction(async (tx) => {
      const count = await tx.stockCount.findFirst({ where: { id }, include: { lines: true } });
      if (!count) throw new NotFoundException('Count not found');
      if (count.status === 'APPLIED') return count;
      if (count.status === 'CANCELLED') throw new ConflictException('Count was cancelled');
      const loc = await tx.stockLocation.findFirstOrThrow({ where: { id: count.locationId }, include: { branch: true } });

      let net = d(0);
      for (const l of count.lines) {
        if (l.varianceQty === null || d(l.varianceQty).isZero()) continue;
        const bal = await tx.stockBalance.findFirst({ where: { productId: l.productId, locationId: count.locationId } });
        const m = await this.inventory.applyMovement(tx, {
          productId: l.productId,
          locationId: count.locationId,
          type: 'COUNT_ADJUSTMENT',
          qtyBase: d(l.varianceQty),
          unitCost: d(bal?.avgCost),
          sourceType: 'StockCount',
          sourceId: count.id,
          idempotencyKey: `count:${count.id}:${l.id}`,
        });
        net = net.plus(m.valueDelta);
      }
      let journalId: string | null = null;
      if (!net.isZero()) {
        const j = await this.posting.post(
          {
            sourceType: 'StockCount',
            sourceId: count.id,
            idempotencyKey: `count:${count.id}`,
            postingDate: ammanToday(),
            memo: `Stock count ${count.number} adjustment`,
            legalEntityId: loc.branch.legalEntityId,
            branchId: loc.branchId,
            lines: net.isNegative()
              ? [{ account: 'INVENTORY_ADJUSTMENT', debit: net.abs() }, { account: 'INVENTORY', credit: net.abs() }]
              : [{ account: 'INVENTORY', debit: net }, { account: 'INVENTORY_ADJUSTMENT', credit: net }],
          },
          tx,
        );
        journalId = j.id;
      }
      await tx.stockCount.updateMany({ where: { id }, data: { status: 'APPLIED', appliedAt: new Date(), journalId } });
      await this.audit.record({ action: 'count.applied', entityType: 'StockCount', entityId: id, after: { netValue: net.toString() } }, tx);
      return tx.stockCount.findFirstOrThrow({ where: { id }, include: { lines: true } });
    });
    await this.closeCountExceptions(id);
    return applied;
  }

  private async closeCountExceptions(countId: string) {
    const open = await this.prisma.db.exception.findMany({ where: { code: 'INV_COUNT_VARIANCE', status: 'APPROVED' } });
    for (const ex of open.filter((e) => (e.evidence as any)?.countId === countId)) {
      await this.exceptions.transition(ex.id, 'EXECUTED', 'Adjustment posted');
      await this.exceptions.transition(ex.id, 'VERIFIED', 'Stock and ledger adjusted together');
    }
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== APPLY_COUNT) return;
    await runWithTenant(e.tenantId, async () => {
      if (e.approved) await this.applyCount(e.subjectId);
      else await this.prisma.db.stockCount.updateMany({ where: { id: e.subjectId }, data: { status: 'CANCELLED' } });
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ---------------------------------------------------------------- wastage

  // Wastage already happened, so it is always recorded immediately; unusual amounts are flagged for review afterwards.
  async recordWastage(input: { locationId: string; productId: string; qty: number; unit?: string; reason: string; notes?: string }, user: RequestUser) {
    const loc = await this.location(input.locationId);
    assertBranchAccess(user, loc.branchId, WASTAGE_ROLES);
    const product = await this.prisma.db.product.findFirst({ where: { id: input.productId } });
    if (!product) throw new BadRequestException('Unknown product');
    const factor = await this.catalog.unitFactor(input.productId, input.unit ?? product.baseUnit);
    const qtyBase = roundQty(d(input.qty).times(factor));
    const bal = await this.balance(input.productId, input.locationId);
    const estimate = money(qtyBase.times(d(bal?.avgCost)));
    const decision = await this.policy.evaluate('inventory.wastage', { amount: Number(estimate), branchId: loc.branchId });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Wastage recording is blocked by policy');

    const id = randomUUID();
    const row = await this.prisma.db.$transaction(async (tx) => {
      const m = await this.inventory.applyMovement(tx, {
        productId: input.productId,
        locationId: input.locationId,
        type: 'WASTAGE',
        qtyBase: qtyBase.negated(),
        sourceType: 'Wastage',
        sourceId: id,
        idempotencyKey: `wastage:${id}`,
      });
      const value = d(m.valueDelta).abs();
      let journalId: string | null = null;
      if (!value.isZero()) {
        const j = await this.posting.post(
          {
            sourceType: 'Wastage',
            sourceId: id,
            idempotencyKey: `wastage:${id}`,
            postingDate: ammanToday(),
            memo: `Wastage (${input.reason}) ${product.sku}`,
            legalEntityId: loc.branch.legalEntityId,
            branchId: loc.branchId,
            lines: [{ account: 'INVENTORY_ADJUSTMENT', debit: value }, { account: 'INVENTORY', credit: value }],
          },
          tx,
        );
        journalId = j.id;
      }
      const w = await tx.wastage.create({
        data: { id, tenantId: '', locationId: input.locationId, productId: input.productId, qtyBase, reason: input.reason, notes: input.notes ?? null, value, status: decision.decision === 'AUTO' ? 'RECORDED' : 'UNDER_REVIEW', journalId, createdBy: user.id },
      });
      await this.audit.record({ action: 'wastage.recorded', entityType: 'Wastage', entityId: id, after: { reason: input.reason, value: value.toString() } }, tx);
      return w;
    });
    if (decision.decision !== 'AUTO') {
      await this.exceptions.raise({
        code: 'INV_WASTAGE_REVIEW',
        reason: `Wastage of ${product.name} (${input.reason}) worth ${row.value} JOD exceeds the auto-review limit`,
        evidence: { wastageId: id, productId: input.productId, reason: input.reason },
        impact: 'Already recorded in stock and ledger; review for causes and controls',
        amount: Number(row.value),
        branchId: loc.branchId,
        policyKey: 'inventory.wastage',
        riskTier: 'LOW',
        availableActions: ['resolve'],
      });
    }
    return row;
  }

  listWastage(filter: { locationId?: string }) {
    return this.prisma.db.wastage.findMany({ where: filter, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  // ---------------------------------------------------------------- transfers

  async transfer(input: { fromLocationId: string; toLocationId: string; lines: { productId: string; qty: number; unit?: string }[] }, user: RequestUser) {
    if (input.fromLocationId === input.toLocationId) throw new BadRequestException('Source and destination are the same location');
    const [from, to] = await Promise.all([this.location(input.fromLocationId), this.location(input.toLocationId)]);
    assertBranchAccess(user, from.branchId, INVENTORY_ROLES);
    // Cross-entity transfers are intercompany sales and need their own accounting (ponytail: not supported yet).
    if (from.branch.legalEntityId !== to.branch.legalEntityId) throw new BadRequestException('Transfers between legal entities are not supported');

    const prepared: { productId: string; qty: Decimal; unit: string; qtyBase: Decimal }[] = [];
    for (const l of input.lines) {
      const product = await this.prisma.db.product.findFirst({ where: { id: l.productId } });
      if (!product) throw new BadRequestException(`Unknown product ${l.productId}`);
      const unit = l.unit ?? product.baseUnit;
      const factor = await this.catalog.unitFactor(l.productId, unit);
      const qtyBase = roundQty(d(l.qty).times(factor));
      const bal = await this.balance(l.productId, input.fromLocationId);
      if (d(bal?.qtyBase).lt(qtyBase)) throw new BadRequestException(`Insufficient stock of ${product.sku} at the source: have ${d(bal?.qtyBase)}, need ${qtyBase}`);
      prepared.push({ productId: l.productId, qty: roundQty(l.qty), unit, qtyBase });
    }

    return this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('TRF', 'TRF', tx);
      const id = randomUUID();
      let total = d(0);
      const lineRows = [];
      for (const [i, l] of prepared.entries()) {
        const out = await this.inventory.applyMovement(tx, { productId: l.productId, locationId: from.id, type: 'TRANSFER_OUT', qtyBase: l.qtyBase.negated(), sourceType: 'StockTransfer', sourceId: id, idempotencyKey: `transfer:${id}:${i}:out` });
        const value = d(out.valueDelta).abs();
        await this.inventory.applyMovement(tx, { productId: l.productId, locationId: to.id, type: 'TRANSFER_IN', qtyBase: l.qtyBase, valueDelta: value, sourceType: 'StockTransfer', sourceId: id, idempotencyKey: `transfer:${id}:${i}:in` });
        total = total.plus(value);
        lineRows.push({ tenantId: currentTenantId(), productId: l.productId, qty: l.qty, unit: l.unit, qtyBase: l.qtyBase, unitCost: out.unitCost, value });
      }
      // Branch-level inventory moves between branches; at tenant level the inventory account is unchanged.
      let journalId: string | null = null;
      if (from.branchId !== to.branchId && !total.isZero()) {
        const j = await this.posting.post(
          {
            sourceType: 'StockTransfer',
            sourceId: id,
            idempotencyKey: `transfer:${id}`,
            postingDate: ammanToday(),
            memo: `Transfer ${number} ${from.branch.code} to ${to.branch.code}`,
            legalEntityId: from.branch.legalEntityId,
            lines: [{ account: 'INVENTORY', debit: total, branchId: to.branchId }, { account: 'INVENTORY', credit: total, branchId: from.branchId }],
          },
          tx,
        );
        journalId = j.id;
      }
      const t = await tx.stockTransfer.create({ data: { id, tenantId: '', number, fromLocationId: from.id, toLocationId: to.id, createdBy: user.id, journalId, lines: { create: lineRows } }, include: { lines: true } });
      await this.audit.record({ action: 'transfer.completed', entityType: 'StockTransfer', entityId: id, after: { number, from: from.code, to: to.code, value: total.toString() } }, tx);
      return t;
    });
  }

  listTransfers() {
    return this.prisma.db.stockTransfer.findMany({ include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  // ---------------------------------------------------------------- reports

  // Stock losses: wastage and negative count adjustments by product, valued at cost.
  async losses(from?: Date, to?: Date) {
    const rows = await this.prisma.db.stockMovement.groupBy({
      by: ['productId', 'type'],
      where: { type: { in: ['WASTAGE', 'COUNT_ADJUSTMENT'] }, occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
      _sum: { qtyBase: true, valueDelta: true },
    });
    const products = await this.prisma.db.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } } });
    const name = new Map(products.map((p) => [p.id, p]));
    const items = rows.map((r) => ({ productId: r.productId, sku: name.get(r.productId)?.sku, name: name.get(r.productId)?.name, type: r.type, qtyBase: d(r._sum.qtyBase).toString(), value: money(r._sum.valueDelta ?? 0).toString() }));
    const lossValue = rows.reduce((s, r) => (d(r._sum.valueDelta).isNegative() ? s.plus(d(r._sum.valueDelta).abs()) : s), d(0));
    return { items, totalLossValue: money(lossValue).toString() };
  }

  // Theoretical usage comes from recipes (sales), wastage and count variance are measured separately.
  // actualUsage = theoreticalUsage + wastage - countVariance; unexplained = -countVariance (positive = shrinkage
  // that neither sales nor recorded wastage account for). Quantities in base units, values in JOD at cost.
  async actualVsTheoretical(from?: Date, to?: Date, locationId?: string) {
    const rows = await this.prisma.db.stockMovement.groupBy({
      by: ['productId', 'type'],
      where: { type: { in: ['SALE_CONSUMPTION', 'WASTAGE', 'COUNT_ADJUSTMENT'] }, locationId, occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
      _sum: { qtyBase: true, valueDelta: true },
    });
    const products = await this.prisma.db.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } } });
    const byProduct = new Map<string, Record<string, { qty: Decimal; value: Decimal }>>();
    for (const r of rows) {
      const cur = byProduct.get(r.productId) ?? {};
      cur[r.type] = { qty: d(r._sum.qtyBase), value: d(r._sum.valueDelta) };
      byProduct.set(r.productId, cur);
    }
    const zero = { qty: d(0), value: d(0) };
    const items = products.map((p) => {
      const m = byProduct.get(p.id) ?? {};
      const sale = m.SALE_CONSUMPTION ?? zero;
      const waste = m.WASTAGE ?? zero;
      const count = m.COUNT_ADJUSTMENT ?? zero;
      const theoretical = sale.qty.negated();
      const unexplained = count.qty.negated();
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        baseUnit: p.baseUnit,
        theoreticalUsage: theoretical.toString(),
        wastage: waste.qty.negated().toString(),
        countVariance: count.qty.toString(),
        actualUsage: theoretical.plus(waste.qty.negated()).minus(count.qty).toString(),
        unexplained: unexplained.toString(),
        unexplainedPct: theoretical.isZero() ? null : unexplained.div(theoretical).times(100).toDecimalPlaces(2).toString(),
        theoreticalValue: money(sale.value.negated()).toString(),
        wastageValue: money(waste.value.negated()).toString(),
        countVarianceValue: money(count.value).toString(),
        actualUsageValue: money(sale.value.negated().plus(waste.value.negated()).minus(count.value)).toString(),
      };
    });
    return { items: items.sort((a, b) => a.sku.localeCompare(b.sku)) };
  }
}
