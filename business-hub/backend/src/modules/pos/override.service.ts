import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { loadRequestUser } from '../auth/request-user';
import { EvalResult } from '../policy-engine/policy-decision';

export interface ManagerOverride {
  email: string;
  password: string;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// POS "manager override": beyond policy limits an action needs someone with the approving role. They can either be the
// logged-in actor or enter their credentials at the terminal; the approver is recorded, the actor's shift is used.
@Injectable()
export class OverrideService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async elevate(actor: RequestUser, decision: EvalResult, branchId: string, what: string, override?: ManagerOverride): Promise<string | null> {
    if (decision.decision === 'AUTO') return null;
    if (decision.decision === 'BLOCKED') throw new BadRequestException(`${what} is blocked by policy`);
    const holdsRole = (u: RequestUser) => decision.escalationRoute.some((r) => actorHasRole(u, r, { branchId }));
    if (holdsRole(actor)) return actor.id;
    if (!override) throw new ForbiddenException(`${what} needs ${decision.approverRole} approval (${decision.reason}); a manager must sign in to approve it`);

    const user = await this.prisma.db.user.findFirst({ where: { email: override.email.toLowerCase() } });
    const ok = await bcrypt.compare(override.password, user?.passwordHash ?? DUMMY_HASH);
    const approver = ok && user && !user.isSystem ? await loadRequestUser(this.prisma, { id: user.id }) : null;
    if (!approver || approver.id === actor.id || !holdsRole(approver)) {
      await this.audit.record({ action: 'override.denied', entityType: 'User', entityId: user?.id ?? null, outcome: 'FAILURE', after: { what, claimedEmail: override.email } });
      throw new ForbiddenException('Manager override was not accepted');
    }
    await this.audit.record({ action: 'override.granted', entityType: 'User', entityId: approver.id, after: { what, requestedBy: actor.id } });
    return approver.id;
  }
}
