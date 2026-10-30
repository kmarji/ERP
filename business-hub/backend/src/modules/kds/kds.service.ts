import { Injectable } from '@nestjs/common';
import { PrismaService, ScopedTx } from '../../common/prisma/prisma.service';
import { currentTenantId } from '../../common/tenancy/tenant-context';

export interface TicketLine {
  id: string;
  name: string;
  qty: number;
  modifiers: { id: string; name: string }[];
  notes?: string | null;
  stationKey: string | null;
}

const RUSH_CHANNELS = new Set(['DELIVERY', 'ONLINE', 'AGGREGATOR']);
const DEAD = ['CANCELLED', 'BUMPED'] as const;

@Injectable()
export class KdsService {
  constructor(private readonly prisma: PrismaService) {}

  // One ticket per station (null stationKey routes to 'KITCHEN'); stations are created on demand per branch.
  async createTickets(tx: ScopedTx, order: { id: string; branchId: string; channel: string }, lines: TicketLine[]): Promise<void> {
    const tenantId = currentTenantId();
    const byStation = new Map<string, TicketLine[]>();
    for (const l of lines) {
      const key = l.stationKey ?? 'KITCHEN';
      byStation.set(key, [...(byStation.get(key) ?? []), l]);
    }
    for (const [key, items] of byStation) {
      const station = await tx.station.upsert({
        where: { tenantId_branchId_key: { tenantId, branchId: order.branchId, key } },
        create: { tenantId, branchId: order.branchId, key, name: key.charAt(0) + key.slice(1).toLowerCase() },
        update: {},
      });
      await tx.kitchenTicket.create({
        data: {
          tenantId: '',
          branchId: order.branchId,
          orderId: order.id,
          stationId: station.id,
          priority: RUSH_CHANNELS.has(order.channel) ? 'RUSH' : 'NORMAL',
          items: items.map((l) => ({ lineId: l.id, name: l.name, qty: l.qty, modifiers: l.modifiers, notes: l.notes ?? null, cancelled: false })),
        },
      });
    }
  }

  // Marks lines cancelled on live tickets; a ticket with every line cancelled becomes CANCELLED.
  async cancelLines(tx: ScopedTx, orderId: string, lineIds: string[]): Promise<void> {
    const ids = new Set(lineIds);
    const tickets = await tx.kitchenTicket.findMany({ where: { orderId, status: { notIn: [...DEAD] } } });
    for (const t of tickets) {
      const items = (t.items as any[]).map((i) => (ids.has(i.lineId) ? { ...i, cancelled: true } : i));
      const all = items.every((i) => i.cancelled);
      await tx.kitchenTicket.updateMany({ where: { id: t.id }, data: { items, ...(all ? { status: 'CANCELLED' as const } : {}) } });
    }
  }

  async cancelOrder(tx: ScopedTx, orderId: string): Promise<void> {
    const tickets = await tx.kitchenTicket.findMany({ where: { orderId, status: { notIn: [...DEAD] } } });
    for (const t of tickets) {
      const items = (t.items as any[]).map((i) => ({ ...i, cancelled: true }));
      await tx.kitchenTicket.updateMany({ where: { id: t.id }, data: { items, status: 'CANCELLED' } });
    }
  }
}
