import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { actorHasRole, currentContext, RequestUser } from '../../common/tenancy/tenant-context';
import { roleVisibility } from '../../common/tenancy/visibility';
import { AuditService } from '../audit/audit.service';
import { ExceptionService } from './exception.service';

export interface ApprovalDecidedEvent {
  approvalId: string;
  tenantId: string;
  subjectType: string;
  subjectId: string;
  action: string;
  approved: boolean;
  decidedBy: string;
}

export const APPROVAL_DECIDED = 'approval.decided';

@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exceptions: ExceptionService,
    private readonly events: EventEmitter2,
  ) {}

  async request(input: {
    subjectType: string;
    subjectId: string;
    action: string;
    approverRole: string;
    amount?: number;
    exceptionId?: string;
    branchId?: string;
  }) {
    const requestedBy = currentContext()?.user?.id ?? 'system';
    return this.prisma.db.$transaction(async (tx) => {
      const a = await tx.approval.create({
        data: {
          tenantId: '',
          exceptionId: input.exceptionId ?? null,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          action: input.action,
          amount: input.amount ?? null,
          requestedBy,
          approverRole: input.approverRole,
          branchId: input.branchId ?? null,
        },
      });
      await this.audit.record({ action: 'approval.requested', entityType: 'Approval', entityId: a.id, after: a }, tx);
      return a;
    });
  }

  list(user: RequestUser, status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING') {
    return this.prisma.db.approval.findMany({
      where: { status, OR: roleVisibility(user, 'approverRole') },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  async decide(id: string, approve: boolean, actor: RequestUser, comment?: string) {
    const a = await this.prisma.db.approval.findFirst({ where: { id }, include: { exception: true } });
    if (!a) throw new NotFoundException('Approval not found');
    if (a.status !== 'PENDING') throw new BadRequestException(`Approval already ${a.status}`);
    // Separation of duties: the requester can never decide their own request.
    if (a.requestedBy === actor.id) throw new ForbiddenException('Requester cannot approve their own request');

    const route = (a.exception?.escalationRoute as string[] | undefined) ?? [];
    const idx = route.indexOf(a.approverRole);
    const allowed = new Set([a.approverRole, 'OWNER', ...(idx >= 0 ? route.slice(idx + 1) : [])]);
    const branchId = a.branchId ?? a.exception?.branchId ?? null;
    if (![...allowed].some((r) => actorHasRole(actor, r, { branchId }))) {
      throw new ForbiddenException(`Requires role ${a.approverRole} or higher in the escalation route`);
    }

    const decided = await this.prisma.db.$transaction(async (tx) => {
      const res = await tx.approval.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: approve ? 'APPROVED' : 'REJECTED', approverUserId: actor.id, decidedAt: new Date(), comment },
      });
      if (res.count !== 1) throw new BadRequestException('Approval already decided');
      await this.audit.record(
        { action: approve ? 'approval.approved' : 'approval.rejected', entityType: 'Approval', entityId: id, before: { status: 'PENDING' }, after: { approverUserId: actor.id, comment } },
        tx,
      );
      return tx.approval.findFirstOrThrow({ where: { id } });
    });

    if (a.exceptionId) {
      await this.exceptions.transition(a.exceptionId, approve ? 'APPROVED' : 'REJECTED', comment, actor);
    }
    // The owning domain module executes the approved action by listening for this event.
    const evt: ApprovalDecidedEvent = {
      approvalId: id,
      tenantId: a.tenantId,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      action: a.action,
      approved: approve,
      decidedBy: actor.id,
    };
    await this.events.emitAsync(APPROVAL_DECIDED, evt);
    return decided;
  }
}
