import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ammanToday } from '../../common/time';
import { NotificationsService } from '../notifications/notifications.module';
import { alertStage, permitStatus } from './work-permit';

@Injectable()
export class WorkPermitService {
  private readonly log = new Logger('WorkPermit');
  constructor(private readonly prisma: PrismaService, private readonly notes: NotificationsService) {}

  // Tells HR, the owner and the employee once per expiry stage. Returns how many employees were alerted.
  async alert(employeeId?: string) {
    const today = ammanToday();
    const rows = await this.prisma.db.employee.findMany({ where: { id: employeeId, needsWorkPermit: true, workPermitExpiry: { not: null }, status: { not: 'TERMINATED' } } });
    let alerted = 0;
    for (const e of rows) {
      const days = permitStatus(e, today)?.daysLeft;
      const stage = days == null ? null : alertStage(days);
      if (days == null || stage === null) continue;
      const when = days < 0 ? 'has expired' : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
      const note = { title: `Work permit of ${e.name} ${when}`, body: `Expiry date: ${e.workPermitExpiry!.toISOString().slice(0, 10)}` };
      await this.prisma.db.$transaction(async (tx) => {
        // Claiming the stage first keeps the daily sweep and a save from both sending it.
        const claim = await tx.employee.updateMany({ where: { id: e.id, workPermitExpiry: e.workPermitExpiry, OR: [{ workPermitAlertStage: null }, { workPermitAlertStage: { gt: stage } }] }, data: { workPermitAlertStage: stage } });
        if (!claim.count) return;
        for (const to of [{ roleKey: 'HR' }, { roleKey: 'OWNER' }, ...(e.userId ? [{ userId: e.userId }] : [])]) await this.notes.notify({ ...to, ...note }, tx);
        alerted++;
      });
    }
    return alerted;
  }

  // After a save: the save already succeeded, so a failed alert is only logged and the daily sweep retries it.
  async alertAfterSave(employeeId: string) {
    await this.alert(employeeId).catch((e) => this.log.error(`Alert failed for ${employeeId}: ${e.message}`));
  }

  @Cron('0 7 * * *', { timeZone: 'Asia/Amman' })
  async sweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.alert()).catch((e) => this.log.error(`Sweep failed for ${t.id}: ${e.message}`));
  }
}
