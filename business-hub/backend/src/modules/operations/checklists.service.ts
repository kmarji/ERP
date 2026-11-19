import { Attachment, attachmentSnapshot } from './attachments';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { ExceptionService } from '../workflow-engine/exception.service';
import { atLocal, employeeOf, MANAGERS } from '../workforce/common';
import { branchFilter, isCompanyWide } from './scope';

export interface Item { id: string; label: string; critical?: boolean; evidenceRequired?: boolean }
export interface Answer { itemId: string; ok: boolean; note?: string; docId?: string; value?: string }

const AMMAN = 3 * 3_600_000; // no DST
const localDate = (d: Date) => new Date(d.getTime() + AMMAN).toISOString().slice(0, 10);

@Injectable()
export class ChecklistsService {
  private readonly log = new Logger(ChecklistsService.name);

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly exceptions: ExceptionService, private readonly notes: NotificationsService) {}

  // ---------------------------------------------------------------- A48 templates

  // Company-wide templates plus the ones for the caller's own branches.
  templates(user: RequestUser, includeOld = false) {
    const own = this.scope(user);
    return this.prisma.db.checklistTemplate.findMany({ where: { ...(includeOld ? {} : { active: true }), ...('branchId' in own ? { OR: [{ branchId: null }, { branchId: own.branchId as any }] } : {}) }, orderBy: [{ name: 'asc' }, { version: 'desc' }] });
  }

  // New code -> v1; existing code -> next version, previous version retired (old runs keep theirs).
  async saveTemplate(input: { code?: string; name: string; branchId?: string; attachmentIds?: string[]; items: Omit<Item, 'id'>[] }, user: RequestUser) {
    if (!input.items.length) throw new BadRequestException('A checklist needs at least one item');
    const prev = input.code ? await this.prisma.db.checklistTemplate.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } }) : null;
    if (input.code && !prev) throw new NotFoundException('Unknown template code');
    // A new version is authorized against the template's own scope, never the request's.
    const scope = prev ? prev.branchId : input.branchId ?? null;
    if (prev && input.branchId && input.branchId !== prev.branchId) throw new BadRequestException('A template cannot move to another branch');
    if (scope) assertBranchAccess(user, scope, MANAGERS);
    else if (!isCompanyWide(user)) throw new ForbiddenException('Only a company-wide role can create or change a template for all branches');
    const items: Item[] = input.items.map((i) => ({ id: randomUUID(), label: i.label, critical: !!i.critical, evidenceRequired: !!i.evidenceRequired }));
    const code = input.code ?? randomUUID().slice(0, 8);
    const last = await this.prisma.db.checklistTemplate.findFirst({ where: { code }, orderBy: { version: 'desc' } });
    if (input.code && !last) throw new NotFoundException('Unknown template code');
    const attachments = input.attachmentIds ? await attachmentSnapshot(this.prisma, input.attachmentIds) : ((last?.attachments as unknown as Attachment[]) ?? []);
    const row = await this.prisma.db.$transaction(async (tx) => {
      if (last) await tx.checklistTemplate.updateMany({ where: { code }, data: { active: false } });
      return tx.checklistTemplate.create({ data: { tenantId: currentTenantId(), code, version: (last?.version ?? 0) + 1, name: input.name, branchId: scope, items: items as any, attachments: attachments as any, createdBy: user.id } });
    });
    await this.audit.record({ action: 'checklist.template_saved', entityType: 'ChecklistTemplate', entityId: row.id, after: { code, version: row.version, items: items.length } });
    return row;
  }

  private async template(id: string) {
    const t = await this.prisma.db.checklistTemplate.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  private async assertAssignable(templateBranch: string | null, employeeId: string, branchId: string, user: RequestUser) {
    assertBranchAccess(user, branchId, MANAGERS);
    if (templateBranch && templateBranch !== branchId) throw new BadRequestException('This template is for a different branch');
    const now = new Date();
    const ok = await this.prisma.db.employeeAssignment.findFirst({ where: { employeeId, branchId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] } });
    if (!ok) throw new BadRequestException('Employee is not assigned to this branch');
    if ((await this.prisma.db.employee.findFirst({ where: { id: employeeId } }))?.status !== 'ACTIVE') throw new BadRequestException('Employee is not active');
  }

  private async tell(employeeId: string, title: string, body?: string) {
    const e = await this.prisma.db.employee.findFirst({ where: { id: employeeId } });
    if (e?.userId) await this.notes.notify({ userId: e.userId, title, body });
  }

  // ---------------------------------------------------------------- A49 assignment

  async assign(input: { templateId: string; employeeId: string; branchId: string; recurrence: 'DAILY' | 'WEEKLY'; weekday?: number; dueTime: string; startDate?: string; endDate?: string }, user: RequestUser) {
    const t = await this.template(input.templateId);
    if (!t.active) throw new BadRequestException('That template version is retired');
    if (input.recurrence === 'WEEKLY' && input.weekday == null) throw new BadRequestException('WEEKLY needs a weekday');
    await this.assertAssignable(t.branchId, input.employeeId, input.branchId, user);
    const row = await this.prisma.db.checklistAssignment.create({ data: { tenantId: '', templateId: t.id, employeeId: input.employeeId, branchId: input.branchId, recurrence: input.recurrence, weekday: input.recurrence === 'WEEKLY' ? input.weekday! : null, dueTime: input.dueTime, startDate: new Date(`${(input.startDate ?? localDate(new Date())).slice(0, 10)}T00:00:00Z`), endDate: input.endDate ? new Date(`${input.endDate.slice(0, 10)}T00:00:00Z`) : null, createdBy: user.id } });
    await this.tell(input.employeeId, `Checklist assigned: ${t.name}`, `${input.recurrence === 'DAILY' ? 'Daily' : 'Weekly'}, due by ${input.dueTime}`);
    await this.audit.record({ action: 'checklist.assigned', entityType: 'ChecklistAssignment', entityId: row.id, after: { employeeId: input.employeeId, recurrence: input.recurrence } });
    return row;
  }

  assignments(user: RequestUser, branchId?: string) { return this.prisma.db.checklistAssignment.findMany({ where: { ...this.scope(user, branchId), active: true }, orderBy: { createdAt: 'desc' }, take: 200 }); }

  async stop(id: string, user: RequestUser) {
    const a = await this.prisma.db.checklistAssignment.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('Assignment not found');
    assertBranchAccess(user, a.branchId, MANAGERS);
    await this.prisma.db.checklistAssignment.updateMany({ where: { id }, data: { active: false } });
    return { stopped: true };
  }

  // W16: a manager asks for a checklist now, outside any schedule.
  async request(input: { templateId: string; employeeId: string; branchId: string; dueAt: string; note?: string }, user: RequestUser) {
    const t = await this.template(input.templateId);
    await this.assertAssignable(t.branchId, input.employeeId, input.branchId, user);
    const dueAt = new Date(input.dueAt);
    if (!(dueAt > new Date())) throw new BadRequestException('dueAt must be in the future');
    const row = await this.prisma.db.checklistRun.create({ data: { tenantId: '', templateId: t.id, forDate: new Date(`${localDate(dueAt)}T00:00:00Z`), employeeId: input.employeeId, branchId: input.branchId, dueAt, note: input.note ?? null, createdBy: user.id } });
    await this.tell(input.employeeId, `Checklist requested: ${t.name}`, `Due ${dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${input.note ? `. ${input.note}` : ''}`);
    await this.audit.record({ action: 'checklist.requested', entityType: 'ChecklistRun', entityId: row.id, after: { employeeId: input.employeeId } });
    return row;
  }

  // ---------------------------------------------------------------- W15 generation and overdue (cron)

  // Creates today's run for each due assignment (one per assignment per day), then marks late ones.
  async sweep(now: Date = new Date()) {
    const today = localDate(now);
    const day = new Date(`${today}T00:00:00Z`);
    const weekday = day.getUTCDay();
    const due = await this.prisma.db.checklistAssignment.findMany({ where: { active: true, startDate: { lte: day }, OR: [{ endDate: null }, { endDate: { gte: day } }] } });
    let created = 0;
    for (const a of due) {
      if (a.recurrence === 'WEEKLY' && a.weekday !== weekday) continue;
      try {
        await this.prisma.db.checklistRun.create({ data: { tenantId: '', templateId: a.templateId, assignmentId: a.id, forDate: day, employeeId: a.employeeId, branchId: a.branchId, dueAt: atLocal(today, a.dueTime), createdBy: 'system' } });
        created++;
      } catch { /* unique (assignment, date): already generated */ }
    }
    const late = await this.prisma.db.checklistRun.findMany({ where: { status: 'PENDING', dueAt: { lt: now } } });
    let overdue = 0;
    for (const r of late) {
      const { count } = await this.prisma.db.checklistRun.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'OVERDUE' } });
      if (!count) continue; // exactly one exception per run
      const [t, e] = await Promise.all([this.template(r.templateId), this.prisma.db.employee.findFirst({ where: { id: r.employeeId } })]);
      await this.exceptions.raise({ code: 'OPS_CHECKLIST_OVERDUE', reason: `"${t.name}" was not completed by ${e?.name ?? 'the assignee'} (due ${r.dueAt.toISOString()})`, evidence: { runId: r.id, employeeId: r.employeeId }, impact: 'Compliance gap; this is not a disciplinary finding', branchId: r.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'LOW', availableActions: ['resolve'] });
      await this.tell(r.employeeId, `Overdue: ${t.name}`, 'This checklist is past its due time. Complete it now.');
      overdue++;
    }
    return { created, overdue };
  }

  @Cron('*/10 * * * *')
  async cron() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.sweep()).catch((err) => this.log.error(`checklist sweep failed for ${t.id}: ${err.message}`));
  }

  // ---------------------------------------------------------------- E12/E13 employee side

  async mine(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const runs = await this.prisma.db.checklistRun.findMany({ where: { employeeId: me.id, OR: [{ status: { in: ['PENDING', 'OVERDUE'] } }, { createdAt: { gte: since } }] }, orderBy: { dueAt: 'asc' }, take: 100 });
    const tpls = await this.prisma.db.checklistTemplate.findMany({ where: { id: { in: runs.map((r) => r.templateId) } } });
    return runs.map((r) => ({ ...r, name: tpls.find((t) => t.id === r.templateId)?.name }));
  }

  async mineOne(id: string, user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const run = await this.prisma.db.checklistRun.findFirst({ where: { id, employeeId: me.id } });
    if (!run) throw new NotFoundException('Checklist not found');
    return { run, template: await this.template(run.templateId) };
  }

  // Idempotent by design (offline devices retry): the first completed submission wins and later ones get it back unchanged.
  async submit(id: string, answers: Answer[], user: RequestUser, clientCompletedAt?: string) {
    const { run, template } = await this.mineOne(id, user);
    if (run.status === 'COMPLETED' || run.status === 'REVIEWED') return { ...run, alreadySubmitted: true };
    const items = template.items as unknown as Item[];
    const byId = new Map(answers.map((a) => [a.itemId, a]));
    for (const it of items) {
      const a = byId.get(it.id);
      if (!a) throw new BadRequestException(`Answer every item: "${it.label}" is missing`);
      if (it.evidenceRequired && !a.docId) throw new BadRequestException(`"${it.label}" needs evidence`);
    }
    if (answers.some((a) => !items.some((i) => i.id === a.itemId))) throw new BadRequestException('Unknown item in answers');
    for (const a of answers) if (a.docId && !(await this.prisma.db.evidenceDocument.findFirst({ where: { id: a.docId } }))) throw new BadRequestException('Unknown evidence document');
    const failures = items.filter((i) => i.critical && !byId.get(i.id)!.ok);
    const now = new Date();
    // An offline device reports when the work was done. It counts for lateness only if it is plausible (after the run existed, not in the future).
    const device = clientCompletedAt ? new Date(clientCompletedAt) : null;
    const doneAt = device && device >= run.createdAt && device <= now ? device : now;
    const late = doneAt > run.dueAt;
    const { count } = await this.prisma.db.checklistRun.updateMany({ where: { id, status: { in: ['PENDING', 'OVERDUE'] } }, data: { status: 'COMPLETED', results: answers as any, criticalFailures: failures.length, completedAt: now, completedLate: late, clientCompletedAt: clientCompletedAt ? new Date(clientCompletedAt) : null } });
    if (!count) return { ...(await this.prisma.db.checklistRun.findFirstOrThrow({ where: { id } })), alreadySubmitted: true };
    if (failures.length) {
      await this.exceptions.raise({ code: 'OPS_CRITICAL_FAILURE', reason: `Critical item(s) failed on "${template.name}": ${failures.map((f) => f.label).join('; ')}`, evidence: { runId: id, employeeId: run.employeeId, items: failures.map((f) => f.id) }, impact: 'Needs corrective action', branchId: run.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'HIGH', availableActions: ['resolve'] });
    }
    await this.audit.record({ action: 'checklist.completed', entityType: 'ChecklistRun', entityId: id, after: { late, criticalFailures: failures.length, offline: doneAt !== now } });
    return this.prisma.db.checklistRun.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- A50 monitor and review

  runs(f: { branchId?: string; employeeId?: string; status?: string; from?: string; to?: string }, user: RequestUser) {
    return this.prisma.db.checklistRun.findMany({ where: { ...this.scope(user, f.branchId), employeeId: f.employeeId, status: f.status, forDate: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } }, orderBy: { dueAt: 'desc' }, take: 300 });
  }

  async run(id: string, user: RequestUser) {
    const run = await this.prisma.db.checklistRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundException('Run not found');
    assertBranchAccess(user, run.branchId, MANAGERS);
    return { run, template: await this.template(run.templateId) };
  }

  async review(id: string, user: RequestUser) {
    const { run } = await this.run(id, user);
    if (run.status !== 'COMPLETED') throw new ConflictException(`Run is ${run.status}`);
    await this.prisma.db.checklistRun.updateMany({ where: { id }, data: { status: 'REVIEWED', reviewedBy: user.id, reviewedAt: new Date() } });
    await this.audit.record({ action: 'checklist.reviewed', entityType: 'ChecklistRun', entityId: id });
    return this.prisma.db.checklistRun.findFirstOrThrow({ where: { id } });
  }

  async monitor(f: { branchId?: string; from?: string; to?: string }, user: RequestUser) {
    const rows = await this.runs({ ...f }, user);
    const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
    const done = n(['COMPLETED', 'REVIEWED']);
    return { total: rows.length, pending: n(['PENDING']), overdue: n(['OVERDUE']), completed: done, late: rows.filter((r) => r.completedLate).length, criticalFailures: rows.reduce((s, r) => s + r.criticalFailures, 0), compliancePct: rows.length ? Math.round((rows.filter((r) => ['COMPLETED', 'REVIEWED'].includes(r.status) && !r.completedLate && !r.criticalFailures).length / rows.length) * 100) : null };
  }

  private scope(user: RequestUser, branchId?: string) { return branchFilter(user, branchId); }
}
