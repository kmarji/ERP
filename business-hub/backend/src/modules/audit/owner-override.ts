import { ForbiddenException, HttpException } from '@nestjs/common';
import { isOwner, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from './audit.service';

// A separation-of-duties rule: refuses when blocked, except for the owner, whose bypass is recorded.
export async function ownDutyRule(blocked: boolean, user: RequestUser, audit: AuditService, entityType: string, entityId: string, rule: string, Refusal: new (message: string) => HttpException = ForbiddenException) {
  if (!blocked) return;
  if (!isOwner(user)) throw new Refusal(rule);
  await audit.record({ action: 'owner.override', entityType, entityId, after: { rule, by: user.id } });
}
