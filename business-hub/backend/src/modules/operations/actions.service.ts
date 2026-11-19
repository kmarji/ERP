import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService, ScopedClient } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { ExceptionService } from '../workflow-engine/exception.service';
import { employeeOf, MANAGERS } from '../workforce/common';
import { branchFilter, isCompanyWide } from './scope';

type Tx = ScopedClient | Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];
const note = (by: string, event: string, text?: string) => ({ at: new Date().toISOString(), by, event, note: text });

// A59: assignment, monitoring, evidence and verified closure. Audits and food-safety breaches raise these.
@Injectable()
export class ActionsService {
  private readonly log = new Logger(ActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: SequenceService,
    private readonly audit: AuditService,
    private readonly exceptions: ExceptionService,
    private readonly notes: NotificationsService,
  ) {}

  async create(input: { branchId: string; source: 'AUDIT' | 'FOOD_SAFETY' | 'MANUAL'; sourceId?: string; title: string; description?: string; severity: string; dueAt?: Date }, by: string, tx: Tx = this.prisma.db) {
    const row = await tx.correctiveAction.create({ data: { tenantId: '', number: await this.seq.next('corrective_action', 'CA', tx), branchId: input.branchId, source: input.source, sourceId: input.sourceId ?? null, title: input.title, description: input.description ?? null, severity: input.severity, dueAt: input.dueAt ?? null, history: [note(by, 'created')], createdBy: by } });
    await this.audit.record({ action: 'corrective_action.created', entityType: 'CorrectiveAction', entityId: row.id, after: { number: row.number, source: input.source, severity: input.severity } }, tx as any);
    return row;
  }

  async manual(input: { branchId: string; title: string; description?: string; severity: string; dueAt?: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    return this.create({ ...input, source: 'MANUAL', dueAt: input.dueAt ? new Date(input.dueAt) : undefined }, user.id);
  }

  list(f: { branchId?: string; status?: string; source?: string }, user: RequestUser) {
    return this.prisma.db.correctiveAction.findMany({ where: { ...branchFilter(user, f.branchId), status: f.status, source: f.source }, orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }], take: 300 });
  }

  private async load(id: string, user?: RequestUser) {
    const a = await this.prisma.db.correctiveAction.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('Action not found');
    if (user) assertBranchAccess(user, a.branchId, MANAGERS);
    return a;
  }

  get(id: string, user: RequestUser) { return this.load(id, user); }

  private async move(a: { id: string; history: any }, from: string[], data: Record<string, unknown>, entry: ReturnType<typeof note>, auditAction: string) {
    const { count } = await this.prisma.db.correctiveAction.updateMany({ where: { id: a.id, status: { in: from } }, data: { ...data, history: [...(a.history as any[]), entry] } });
    if (!count) throw new ConflictException('The action changed; reload and retry');
    await this.audit.record({ action: auditAction, entityType: 'CorrectiveAction', entityId: a.id, after: data });
    return this.prisma.db.correctiveAction.findFirstOrThrow({ where: { id: a.id } });
  }

  async assign(id: string, input: { employeeId: string; dueAt?: string }, user: RequestUser) {
    const a = await this.load(id, user);
    if (!['OPEN', 'IN_PROGRESS'].includes(a.status)) throw new ConflictException(`Action is ${a.status}`);
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } });
    const now = new Date();
    const here = await this.prisma.db.employeeAssignment.findFirst({ where: { employeeId: input.employeeId, branchId: a.branchId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] } });
    if (!emp || emp.status !== 'ACTIVE' || !here) throw new BadRequestException('The assignee must be an active employee of this branch');
    const dueAt = input.dueAt ? new Date(input.dueAt) : a.dueAt;
    const row = await this.move(a, ['OPEN', 'IN_PROGRESS'], { status: 'IN_PROGRESS', assigneeEmployeeId: emp.id, dueAt, overdueAt: null }, note(user.id, 'assigned', emp.name), 'corrective_action.assigned');
    if (emp.userId) await this.notes.notify({ userId: emp.userId, title: `Corrective action ${a.number}: ${a.title}`, body: dueAt ? `Due ${dueAt.toISOString().slice(0, 10)}` : undefined });
    return row;
  }

  mine(user: RequestUser) {
    return employeeOf(this.prisma, user).then((me) => this.prisma.db.correctiveAction.findMany({ where: { assigneeEmployeeId: me.id, status: { in: ['IN_PROGRESS', 'PENDING_VERIFICATION'] } }, orderBy: { dueAt: 'asc' } }));
  }

  // The assignee reports the fix with evidence; a manager then verifies it.
  async complete(id: string, input: { note: string; docIds: string[] }, user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const a = await this.load(id);
    if (a.assigneeEmployeeId !== me.id) throw new ForbiddenException('This action is not assigned to you');
    if (a.status !== 'IN_PROGRESS') throw new ConflictException(`Action is ${a.status}`);
    if (!input.docIds.length) throw new BadRequestException('Attach evidence of the fix');
    if ((await this.prisma.db.evidenceDocument.count({ where: { id: { in: input.docIds } } })) !== new Set(input.docIds).size) throw new BadRequestException('Unknown evidence document');
    return this.move(a, ['IN_PROGRESS'], { status: 'PENDING_VERIFICATION', completionNote: input.note, evidenceDocIds: input.docIds, completedAt: new Date() }, note(user.id, 'completed', input.note), 'corrective_action.completed');
  }

  // Closure is authorized: a manager of the branch, never the assignee; CRITICAL needs a company-wide role.
  async verify(id: string, input: { approve: boolean; note?: string }, user: RequestUser) {
    const a = await this.load(id, user);
    if (a.status !== 'PENDING_VERIFICATION') throw new ConflictException(`Action is ${a.status}`);
    const assignee = a.assigneeEmployeeId ? await this.prisma.db.employee.findFirst({ where: { id: a.assigneeEmployeeId } }) : null;
    if (assignee?.userId === user.id) throw new ForbiddenException('The person who did the work cannot verify it');
    if (!input.approve) return this.move(a, ['PENDING_VERIFICATION'], { status: 'IN_PROGRESS', completedAt: null }, note(user.id, 'rejected', input.note), 'corrective_action.rejected');
    if (a.severity === 'CRITICAL' && !isCompanyWide(user)) throw new ForbiddenException('Closing a CRITICAL action needs a company-wide role');
    if (a.source === 'FOOD_SAFETY' && a.sourceId && !(await this.prisma.db.foodSafetyReading.findFirst({ where: { pointId: a.sourceId, inRange: true, takenAt: { gt: a.createdAt } } }))) {
      throw new ConflictException('Record an in-range reading for this point before closing');
    }
    return this.move(a, ['PENDING_VERIFICATION'], { status: 'CLOSED', verifiedBy: user.id, verifiedAt: new Date() }, note(user.id, 'closed', input.note), 'corrective_action.closed');
  }

  async cancel(id: string, reason: string, user: RequestUser) {
    const a = await this.load(id, user);
    if (['CLOSED', 'CANCELLED'].includes(a.status)) throw new ConflictException(`Action is ${a.status}`);
    // Cancelling is a way to make a finding disappear, so it follows the closing rules and is stricter for findings.
    const assignee = a.assigneeEmployeeId ? await this.prisma.db.employee.findFirst({ where: { id: a.assigneeEmployeeId } }) : null;
    if (assignee?.userId === user.id) throw new ForbiddenException('The assignee cannot cancel their own action');
    if ((a.severity === 'CRITICAL' || a.source !== 'MANUAL') && !isCompanyWide(user)) throw new ForbiddenException('Cancelling a critical action, or one raised by an audit or food-safety breach, needs a company-wide role');
    return this.move(a, [a.status], { status: 'CANCELLED' }, note(user.id, 'cancelled', reason), 'corrective_action.cancelled');
  }

  // Monitoring: past-due actions raise one exception each.
  async sweep(now: Date = new Date()) {
    const late = await this.prisma.db.correctiveAction.findMany({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now }, overdueAt: null } });
    let n = 0;
    for (const a of late) {
      const { count } = await this.prisma.db.correctiveAction.updateMany({ where: { id: a.id, overdueAt: null }, data: { overdueAt: now } });
      if (!count) continue;
      await this.exceptions.raise({ code: 'OPS_ACTION_OVERDUE', reason: `Corrective action ${a.number} "${a.title}" is past its due date`, evidence: { actionId: a.id, source: a.source }, impact: 'Open compliance risk', branchId: a.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: a.severity === 'CRITICAL' || a.severity === 'HIGH' ? 'HIGH' : 'LOW', availableActions: ['resolve'] });
      n++;
    }
    return n;
  }

  @Cron('*/10 * * * *')
  async cron() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.sweep()).catch((err) => this.log.error(`action sweep failed for ${t.id}: ${err.message}`));
  }
}
