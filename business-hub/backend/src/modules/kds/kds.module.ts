import { BadRequestException, Controller, Get, Global, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TicketStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { NotificationsService } from '../notifications/notifications.module';
import { KdsService } from './kds.service';

const KDS_ROLES = ['KITCHEN', 'BRANCH_MANAGER', 'CASHIER', 'OWNER'] as const;
const ACTIVE: TicketStatus[] = ['NEW', 'IN_PROGRESS', 'READY'];

// action -> [allowed from, to]
const ACTIONS: Record<string, [TicketStatus[], TicketStatus]> = {
  start: [['NEW'], 'IN_PROGRESS'],
  ready: [['IN_PROGRESS'], 'READY'],
  bump: [['READY'], 'BUMPED'],
  recall: [['BUMPED', 'READY'], 'IN_PROGRESS'],
};

@ApiTags('kds')
@ApiBearerAuth()
@Roles(...KDS_ROLES)
@Controller('kds')
class KdsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
    private readonly audit: AuditService,
  ) {}

  @Get('stations') stations(@Query('branchId') branchId: string, @CurrentUser() u: RequestUser) {
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAccess(u, branchId, KDS_ROLES);
    return this.prisma.db.station.findMany({ where: { branchId }, orderBy: { key: 'asc' } });
  }

  @Get('tickets') async tickets(
    @CurrentUser() u: RequestUser,
    @Query('branchId') branchId: string,
    @Query('stationKey') stationKey?: string,
    @Query('status') status?: TicketStatus,
  ) {
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAccess(u, branchId, KDS_ROLES);
    const rows = await this.prisma.db.kitchenTicket.findMany({
      where: { branchId, status: status ?? { in: ACTIVE }, ...(stationKey ? { station: { key: stationKey } } : {}) },
      include: { station: true, order: { select: { number: true, channel: true } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], // 'RUSH' sorts after 'NORMAL', so desc puts rush first
      take: 200,
    });
    const now = Date.now();
    return rows.map(({ order, station, ...t }) => ({ ...t, stationKey: station.key, stationName: station.name, orderNumber: order.number, channel: order.channel, ageSeconds: Math.floor((now - t.createdAt.getTime()) / 1000) }));
  }

  @Post('tickets/:id/:action') async transition(@Param('id') id: string, @Param('action') action: string, @CurrentUser() u: RequestUser) {
    const rule = ACTIONS[action];
    if (!rule) throw new NotFoundException(`Unknown action ${action}`);
    const ticket = await this.prisma.db.kitchenTicket.findFirst({ where: { id }, include: { order: true } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    assertBranchAccess(u, ticket.branchId, KDS_ROLES);
    const [from, to] = rule;
    if (!from.includes(ticket.status)) throw new BadRequestException(`Cannot ${action} a ticket that is ${ticket.status}`);
    const now = new Date();
    const stamp = to === 'IN_PROGRESS' ? { startedAt: ticket.startedAt ?? now, readyAt: null, bumpedAt: null } : to === 'READY' ? { readyAt: now } : { bumpedAt: now };
    const res = await this.prisma.db.kitchenTicket.updateMany({ where: { id, status: ticket.status }, data: { status: to, ...stamp } });
    if (res.count !== 1) throw new BadRequestException('Ticket changed concurrently');
    await this.audit.record({ action: `kds.${action}`, entityType: 'KitchenTicket', entityId: id, before: { status: ticket.status }, after: { status: to } });
    if (to === 'READY') {
      await this.notifications.notify({ userId: ticket.order.createdBy, title: `Order ${ticket.order.number} ready`, body: `Ticket is ready for pickup` });
      this.events.emit('kds.ticket_ready', { ticketId: id, orderId: ticket.orderId, branchId: ticket.branchId });
    }
    return this.prisma.db.kitchenTicket.findFirstOrThrow({ where: { id } });
  }
}

@Global()
@Module({ controllers: [KdsController], providers: [KdsService], exports: [KdsService] })
export class KdsModule {}
