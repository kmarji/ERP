import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const DEFAULTS = { criticalActionDays: 3, actionDays: 14, foodSafetyActionHours: 24 };

// A60 settings live in the 'ops.settings' policy, so changes are versioned and audited like every other policy.
@Injectable()
export class OpsSettings {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const p = await this.prisma.db.policy.findFirst({ where: { key: 'ops.settings', active: true } });
    const r = (p?.rules ?? {}) as Record<string, unknown>;
    const n = (k: keyof typeof DEFAULTS) => (typeof r[k] === 'number' && (r[k] as number) > 0 ? (r[k] as number) : DEFAULTS[k]);
    return { criticalActionDays: n('criticalActionDays'), actionDays: n('actionDays'), foodSafetyActionHours: n('foodSafetyActionHours') };
  }
}
