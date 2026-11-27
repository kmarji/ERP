import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';

// The company's week start day (0 = Sunday), used by the weekly hours limit and weekly overtime.
@Injectable()
export class WeekService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async settings() {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: currentTenantId() } });
    return t.settings as Record<string, unknown>;
  }

  async startsOn(): Promise<number> {
    return (await this.settings()).weekStartsOn as number ?? 1;
  }

  async setStartsOn(weekStartsOn: number, user: RequestUser) {
    const before = await this.settings();
    await this.prisma.raw.tenant.update({ where: { id: currentTenantId() }, data: { settings: { ...before, weekStartsOn } as any } });
    await this.audit.record({ action: 'schedule.settings_changed', entityType: 'Tenant', entityId: currentTenantId(), before: { weekStartsOn: before.weekStartsOn ?? 1 }, after: { weekStartsOn, by: user.id } });
  }
}
