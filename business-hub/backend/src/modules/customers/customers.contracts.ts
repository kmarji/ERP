import { BadRequestException, Injectable } from '@nestjs/common';
import { Decimal, d, money } from '../../common/money';
import { PrismaService, ScopedTx } from '../../common/prisma/prisma.service';
import { currentTenantId } from '../../common/tenancy/tenant-context';

@Injectable()
export class VoucherService {
  constructor(private readonly prisma: PrismaService) {}

  // Read-only check; `discount` is tax-inclusive and capped at the subtotal.
  async validate(code: string, subtotal: Decimal, at: Date = new Date()): Promise<{ voucherId: string; kind: 'PERCENT' | 'AMOUNT'; discount: Decimal }> {
    const v = await this.prisma.db.voucher.findFirst({ where: { code: code.trim().toUpperCase() } });
    if (!v || !v.active) throw new BadRequestException('Unknown or inactive voucher');
    if ((v.validFrom && at < v.validFrom) || (v.validTo && at > v.validTo)) throw new BadRequestException('Voucher is not valid at this time');
    if (v.maxUses !== null && v.usedCount >= v.maxUses) throw new BadRequestException('Voucher has been fully used');
    if (subtotal.lt(v.minSubtotal)) throw new BadRequestException(`Voucher needs a minimum of ${v.minSubtotal} JOD`);
    const raw = v.kind === 'PERCENT' ? money(subtotal.times(v.value).div(100)) : money(v.value);
    return { voucherId: v.id, kind: v.kind, discount: Decimal.min(raw, subtotal) };
  }

  // Idempotent per order. The guarded UPDATE keeps usedCount from passing maxUses even under concurrency.
  async redeem(tx: ScopedTx, voucherId: string, orderId: string): Promise<void> {
    if (await tx.voucherRedemption.findFirst({ where: { orderId } })) return;
    const tenantId = currentTenantId();
    const n = await tx.$executeRaw`UPDATE "Voucher" SET "usedCount" = "usedCount" + 1 WHERE id = ${voucherId} AND "tenantId" = ${tenantId} AND active AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
    if (n !== 1) throw new BadRequestException('Voucher has been fully used');
    await tx.voucherRedemption.create({ data: { tenantId: '', voucherId, orderId } });
  }
}

@Injectable()
export class GiftCardService {
  async redeem(tx: ScopedTx, code: string, amount: Decimal): Promise<{ id: string; balance: Decimal }> {
    const c = code.trim().toUpperCase();
    const res = await tx.giftCard.updateMany({ where: { code: c, status: 'ACTIVE', balance: { gte: amount } }, data: { balance: { decrement: amount } } });
    if (res.count !== 1) {
      const card = await tx.giftCard.findFirst({ where: { code: c } });
      if (!card || card.status === 'VOID') throw new BadRequestException('Unknown or void gift card');
      throw new BadRequestException(`Insufficient gift card balance: ${card.balance} JOD available`);
    }
    const card = await tx.giftCard.findFirstOrThrow({ where: { code: c } });
    if (d(card.balance).isZero()) await tx.giftCard.updateMany({ where: { id: card.id, status: 'ACTIVE' }, data: { status: 'EXHAUSTED' } });
    return { id: card.id, balance: d(card.balance) };
  }

  async restore(tx: ScopedTx, code: string, amount: Decimal): Promise<void> {
    const c = code.trim().toUpperCase();
    const res = await tx.giftCard.updateMany({ where: { code: c, status: { in: ['ACTIVE', 'EXHAUSTED'] } }, data: { balance: { increment: amount }, status: 'ACTIVE' } });
    if (res.count !== 1) throw new BadRequestException('Unknown or void gift card');
  }
}

@Injectable()
export class LoyaltyService {
  // Idempotent per (order, EARN).
  async earn(tx: ScopedTx, customerId: string, orderId: string, points: number): Promise<void> {
    if (points <= 0 || (await tx.loyaltyTransaction.findFirst({ where: { orderId, customerId, reason: 'EARN' } }))) return;
    await tx.loyaltyTransaction.create({ data: { tenantId: '', customerId, orderId, points, reason: 'EARN' } });
    await tx.customer.updateMany({ where: { id: customerId }, data: { points: { increment: points } } });
  }

  // Takes back at most what the customer still holds, so the balance never goes negative.
  async clawback(tx: ScopedTx, customerId: string, orderId: string, points: number): Promise<void> {
    const c = await tx.customer.findFirst({ where: { id: customerId } });
    const take = Math.min(points, c?.points ?? 0);
    if (!c || take <= 0) return;
    await tx.customer.updateMany({ where: { id: customerId }, data: { points: { decrement: take } } });
    await tx.loyaltyTransaction.create({ data: { tenantId: '', customerId, orderId, points: -take, reason: 'CLAWBACK' } });
  }

  // 100 points = 1.000 JOD.
  async redeem(tx: ScopedTx, customerId: string, orderId: string, points: number): Promise<Decimal> {
    if (!Number.isInteger(points) || points <= 0) throw new BadRequestException('points must be a positive whole number');
    const res = await tx.customer.updateMany({ where: { id: customerId, points: { gte: points } }, data: { points: { decrement: points } } });
    if (res.count !== 1) throw new BadRequestException('Customer does not have enough points');
    await tx.loyaltyTransaction.create({ data: { tenantId: '', customerId, orderId, points: -points, reason: 'REDEEM' } });
    return money(d(points).div(100));
  }
}
