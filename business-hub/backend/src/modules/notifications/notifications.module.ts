import { Controller, Get, Global, Injectable, Logger, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, RequestUser, isOwner } from '../../common/tenancy/tenant-context';
import { CurrentUser } from '../auth/auth.decorators';

// Delivery channel adapter. Stub logs; email/SMS providers plug in here once chosen.
export abstract class NotificationChannelAdapter {
  abstract send(n: { tenantId: string; userId?: string | null; roleKey?: string | null; title: string; body?: string }): Promise<void>;
}

@Injectable()
export class LogNotificationChannel extends NotificationChannelAdapter {
  private readonly log = new Logger('Notification');
  async send(n: { title: string; roleKey?: string | null; userId?: string | null }) {
    this.log.log(`-> ${n.userId ?? n.roleKey}: ${n.title}`);
  }
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channel: NotificationChannelAdapter,
  ) {}

  async notify(n: { userId?: string; roleKey?: string; title: string; body?: string }, tx?: Pick<PrismaService['db'], 'notification'>) {
    const row = await (tx ?? this.prisma.db).notification.create({
      data: { tenantId: '', userId: n.userId ?? null, roleKey: n.roleKey ?? null, title: n.title, body: n.body ?? null },
    });
    await this.channel.send({ tenantId: currentTenantId(), ...n });
    return row;
  }

  // What the caller may read: their own plus their roles'. The owner reads every role's.
  private addressedTo(user: RequestUser) {
    const roleKeys = [...user.roles.map((r) => r.key), ...user.delegations.map((d) => d.roleKey)];
    return [{ userId: user.id }, { roleKey: isOwner(user) ? { not: null } : { in: roleKeys } }];
  }

  async mine(user: RequestUser, unreadOnly = false) {
    const rows = await this.prisma.db.notification.findMany({ where: { OR: this.addressedTo(user), ...(unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    if (!isOwner(user)) return rows;
    // One message sent to several roles shows once.
    return rows.filter((r, i) => rows.findIndex((x) => x.title === r.title && x.body === r.body && Math.abs(+x.createdAt - +r.createdAt) < 60_000) === i);
  }

  // Only a notification the caller may read can be marked read.
  markRead(id: string, user: RequestUser) {
    return this.prisma.db.notification.updateMany({ where: { id, OR: this.addressedTo(user) }, data: { readAt: new Date() } });
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get() mine(@CurrentUser() u: RequestUser) {
    return this.svc.mine(u);
  }

  @Post(':id/read') read(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.svc.markRead(id, u);
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, { provide: NotificationChannelAdapter, useClass: LogNotificationChannel }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
