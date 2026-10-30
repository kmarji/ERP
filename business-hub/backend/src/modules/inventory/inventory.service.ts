import { Injectable } from '@nestjs/common';
import { MovementType } from '@prisma/client';
import { Decimal, d, money, qty as roundQty, rate } from '../../common/money';
import { PrismaService, ScopedClient } from '../../common/prisma/prisma.service';
import { currentContext, currentTenantId } from '../../common/tenancy/tenant-context';

type Tx = ScopedClient | Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];

export interface MovementInput {
  productId: string;
  locationId: string;
  type: MovementType;
  qtyBase: Decimal; // signed, in the product base unit
  unitCost?: Decimal; // required for stock-increasing movements unless valueDelta is given
  valueDelta?: Decimal; // exact value for increases (e.g. a transfer-in must equal its transfer-out)
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  occurredAt?: Date;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // Weighted-average costing (ponytail: WAC only; FIFO/batch costing would need cost layers).
  // The balance row is locked for the duration of the transaction so concurrent movements serialize.
  async applyMovement(tx: Tx, m: MovementInput) {
    const tenantId = currentTenantId();
    const existing = await tx.stockMovement.findFirst({ where: { idempotencyKey: m.idempotencyKey } });
    if (existing) return existing;

    await tx.stockBalance.upsert({
      where: { tenantId_productId_locationId: { tenantId, productId: m.productId, locationId: m.locationId } },
      create: { tenantId, productId: m.productId, locationId: m.locationId },
      update: {},
    });
    // Raw lock query bypasses the tenant extension, so tenantId is filtered explicitly.
    await tx.$queryRaw`SELECT id FROM "StockBalance" WHERE "tenantId" = ${tenantId} AND "productId" = ${m.productId} AND "locationId" = ${m.locationId} FOR UPDATE`;
    const bal = await tx.stockBalance.findFirstOrThrow({ where: { productId: m.productId, locationId: m.locationId } });

    const q = roundQty(m.qtyBase);
    const oldQty = d(bal.qtyBase);
    const oldValue = d(bal.value);
    let unitCost: Decimal;
    let valueDelta: Decimal;
    if (q.gt(0)) {
      if (m.valueDelta !== undefined) {
        valueDelta = money(m.valueDelta);
        unitCost = rate(valueDelta.div(q));
      } else {
        if (m.unitCost === undefined) throw new Error('unitCost is required for stock-increasing movements');
        unitCost = rate(m.unitCost);
        valueDelta = money(q.times(unitCost));
      }
    } else {
      unitCost = d(bal.avgCost);
      // Issuing the whole remaining quantity clears the value exactly, so no rounding residue is left behind.
      valueDelta = oldQty.gt(0) && q.abs().equals(oldQty) ? oldValue.negated() : money(q.times(unitCost));
    }
    const newQty = oldQty.plus(q);
    const newValue = oldValue.plus(valueDelta);
    const avgCost = newQty.gt(0) ? rate(newValue.div(newQty)) : unitCost;

    const movement = await tx.stockMovement.create({
      data: {
        tenantId: '',
        productId: m.productId,
        locationId: m.locationId,
        type: m.type,
        qtyBase: q,
        unitCost,
        valueDelta,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        occurredAt: m.occurredAt ?? new Date(),
        idempotencyKey: m.idempotencyKey,
        correlationId: currentContext()?.correlationId ?? m.idempotencyKey,
        createdBy: currentContext()?.user?.id ?? 'system',
      },
    });
    await tx.stockBalance.updateMany({
      where: { id: bal.id },
      data: { qtyBase: newQty, value: newValue, avgCost },
    });
    return movement;
  }

  stock(filter: { locationId?: string; productId?: string }) {
    return this.prisma.db.stockBalance.findMany({ where: filter, orderBy: { updatedAt: 'desc' }, take: 1000 });
  }

  movements(filter: { productId?: string; locationId?: string; sourceType?: string; sourceId?: string; take?: number }) {
    const { take, ...where } = filter;
    return this.prisma.db.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(take ?? 100, 500) });
  }

  // Balances are derived data: they must always equal the sum of their movements.
  async reconcile() {
    const [bals, sums] = await Promise.all([
      this.prisma.db.stockBalance.findMany(),
      this.prisma.db.stockMovement.groupBy({ by: ['productId', 'locationId'], _sum: { qtyBase: true, valueDelta: true } }),
    ]);
    const key = (p: string, l: string) => `${p}|${l}`;
    const sumMap = new Map(sums.map((s) => [key(s.productId, s.locationId), s._sum]));
    const mismatches = bals
      .map((b) => {
        const s = sumMap.get(key(b.productId, b.locationId));
        return { productId: b.productId, locationId: b.locationId, balanceQty: d(b.qtyBase), movementQty: d(s?.qtyBase), balanceValue: d(b.value), movementValue: d(s?.valueDelta) };
      })
      .filter((r) => !r.balanceQty.equals(r.movementQty) || !r.balanceValue.equals(r.movementValue))
      .map((r) => ({ ...r, balanceQty: r.balanceQty.toString(), movementQty: r.movementQty.toString(), balanceValue: r.balanceValue.toString(), movementValue: r.movementValue.toString() }));
    return { checked: bals.length, mismatches, consistent: mismatches.length === 0 };
  }
}
