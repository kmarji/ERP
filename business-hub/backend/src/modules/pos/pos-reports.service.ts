import { Injectable } from '@nestjs/common';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class PosReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async sales(filter: { from?: Date; to?: Date; branchId?: string }) {
    const where = { status: 'COMPLETED' as const, branchId: filter.branchId, ...(filter.from || filter.to ? { completedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}) };
    const [orders, byChannel, tenders, refunds, top] = await Promise.all([
      this.prisma.db.order.aggregate({ where, _count: true, _sum: { subtotal: true, discountTotal: true, total: true, taxTotal: true, refundedTotal: true } }),
      this.prisma.db.order.groupBy({ by: ['channel'], where, _count: true, _sum: { total: true } }),
      this.prisma.db.tender.groupBy({ by: ['method'], where: { status: 'CAPTURED', order: where }, _sum: { amount: true } }),
      this.prisma.db.refund.aggregate({ where: { order: where }, _count: true, _sum: { total: true, tax: true } }),
      this.prisma.db.orderLine.groupBy({ by: ['menuItemId', 'name'], where: { voided: false, order: where }, _sum: { qty: true, total: true }, orderBy: { _sum: { total: 'desc' } }, take: 10 }),
    ]);
    const gross = money(orders._sum.subtotal ?? 0);
    const discounts = money(orders._sum.discountTotal ?? 0);
    const total = money(orders._sum.total ?? 0);
    const refunded = money(refunds._sum.total ?? 0);
    return {
      orders: orders._count,
      gross: gross.toString(),
      discounts: discounts.toString(),
      total: total.toString(),
      tax: money(orders._sum.taxTotal ?? 0).toString(),
      refunds: { count: refunds._count, total: refunded.toString() },
      netAfterRefunds: total.minus(refunded).toString(),
      averageOrder: orders._count ? money(d(total).div(orders._count)).toString() : '0',
      byChannel: byChannel.map((c) => ({ channel: c.channel, orders: c._count, total: money(c._sum.total ?? 0).toString() })),
      byTender: tenders.map((t) => ({ method: t.method, amount: money(t._sum.amount ?? 0).toString() })),
      topItems: top.map((t) => ({ menuItemId: t.menuItemId, name: t.name, qty: t._sum.qty ?? 0, total: money(t._sum.total ?? 0).toString() })),
    };
  }
}
