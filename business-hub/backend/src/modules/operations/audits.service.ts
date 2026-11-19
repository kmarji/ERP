import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { MANAGERS } from '../workforce/common';
import { ActionsService } from './actions.service';
import { OpsSettings } from './ops-settings';
import { branchFilter, isCompanyWide } from './scope';

export interface AuditItem { id: string; label: string; weight: number; critical: boolean; evidenceRequired: boolean }
export interface AuditAnswer { itemId: string; result: 'PASS' | 'FAIL' | 'NA'; note?: string; docId?: string }

const DAY = 86_400_000;

@Injectable()
export class AuditsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly actions: ActionsService, private readonly exceptions: ExceptionService, private readonly settings: OpsSettings) {}

  // ---------------------------------------------------------------- A56 templates

  templates(user: RequestUser, includeOld = false) {
    const own = branchFilter(user);
    return this.prisma.db.auditTemplate.findMany({ where: { ...(includeOld ? {} : { active: true }), ...('branchId' in own ? { OR: [{ branchId: null }, { branchId: own.branchId as any }] } : {}) }, orderBy: [{ name: 'asc' }, { version: 'desc' }] });
  }

  async saveTemplate(input: { code?: string; name: string; branchId?: string; passPercent?: number; items: { label: string; weight?: number; critical?: boolean; evidenceRequired?: boolean }[] }, user: RequestUser) {
    if (!input.items.length) throw new BadRequestException('An audit needs at least one item');
    const prev = input.code ? await this.prisma.db.auditTemplate.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } }) : null;
    if (input.code && !prev) throw new NotFoundException('Unknown template code');
    // A new version is authorized against the template's own scope, never the request's.
    const scope = prev ? prev.branchId : input.branchId ?? null;
    if (prev && input.branchId && input.branchId !== prev.branchId) throw new BadRequestException('A template cannot move to another branch');
    if (scope) assertBranchAccess(user, scope, MANAGERS);
    else if (!isCompanyWide(user)) throw new ForbiddenException('Only a company-wide role can create or change a template for all branches');
    const items: AuditItem[] = input.items.map((i) => ({ id: randomUUID(), label: i.label, weight: i.weight ?? 1, critical: !!i.critical, evidenceRequired: !!i.evidenceRequired }));
    const code = input.code ?? randomUUID().slice(0, 8);
    const last = await this.prisma.db.auditTemplate.findFirst({ where: { code }, orderBy: { version: 'desc' } });
    if (input.code && !last) throw new NotFoundException('Unknown template code');
    const row = await this.prisma.db.$transaction(async (tx) => {
      if (last) await tx.auditTemplate.updateMany({ where: { code }, data: { active: false } });
      return tx.auditTemplate.create({ data: { tenantId: currentTenantId(), code, version: (last?.version ?? 0) + 1, name: input.name, branchId: scope, items: items as any, passPercent: input.passPercent ?? last?.passPercent ?? 80, createdBy: user.id } });
    });
    await this.audit.record({ action: 'audit.template_saved', entityType: 'AuditTemplate', entityId: row.id, after: { code, version: row.version } });
    return row;
  }

  private async template(id: string) {
    const t = await this.prisma.db.auditTemplate.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  // ---------------------------------------------------------------- A57 execution

  async start(input: { templateId: string; branchId: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    const t = await this.template(input.templateId);
    if (!t.active) throw new BadRequestException('That version is retired');
    if (t.branchId && t.branchId !== input.branchId) throw new BadRequestException('This template is for a different branch');
    const row = await this.prisma.db.auditRecord.create({ data: { tenantId: '', templateId: t.id, branchId: input.branchId, auditorId: user.id } });
    await this.audit.record({ action: 'audit.started', entityType: 'AuditRecord', entityId: row.id, after: { branchId: input.branchId } });
    return row;
  }

  list(f: { branchId?: string; status?: string }, user: RequestUser) {
    return this.prisma.db.auditRecord.findMany({ where: { ...branchFilter(user, f.branchId), status: f.status }, orderBy: { startedAt: 'desc' }, take: 200 });
  }

  async get(id: string, user: RequestUser) {
    const r = await this.prisma.db.auditRecord.findFirst({ where: { id } });
    if (!r) throw new NotFoundException('Audit not found');
    assertBranchAccess(user, r.branchId, MANAGERS);
    const actions = await this.prisma.db.correctiveAction.findMany({ where: { source: 'AUDIT', sourceId: id } });
    return { audit: r, template: await this.template(r.templateId), actions };
  }

  // Score = weight of passed items over weight of applicable items. Any failed critical item fails the audit outright.
  // Every failed item becomes a corrective action, so each finding is traceable to its audit and item.
  async complete(id: string, answers: AuditAnswer[], user: RequestUser) {
    const { audit: rec, template } = await this.get(id, user);
    if (rec.auditorId !== user.id) throw new ForbiddenException('Only the auditor who started this audit can complete it');
    if (rec.status !== 'IN_PROGRESS') throw new ConflictException('Audit is already completed');
    const items = template.items as unknown as AuditItem[];
    const by = new Map(answers.map((a) => [a.itemId, a]));
    if (answers.some((a) => !items.some((i) => i.id === a.itemId))) throw new BadRequestException('Unknown item in answers');
    for (const i of items) {
      const a = by.get(i.id);
      if (!a) throw new BadRequestException(`Answer every item: "${i.label}" is missing`);
      if (a.result === 'FAIL' && !a.note?.trim()) throw new BadRequestException(`Say what was wrong: "${i.label}"`);
      if (a.result !== 'NA' && i.evidenceRequired && !a.docId) throw new BadRequestException(`"${i.label}" needs evidence`);
      if (a.docId && !(await this.prisma.db.evidenceDocument.findFirst({ where: { id: a.docId } }))) throw new BadRequestException('Unknown evidence document');
    }
    const applicable = items.filter((i) => by.get(i.id)!.result !== 'NA');
    const total = applicable.reduce((s, i) => s + i.weight, 0);
    const got = applicable.filter((i) => by.get(i.id)!.result === 'PASS').reduce((s, i) => s + i.weight, 0);
    const scorePct = total ? Math.round((got / total) * 100) : 100;
    const failed = items.filter((i) => by.get(i.id)!.result === 'FAIL');
    const criticalFails = failed.filter((i) => i.critical).length;
    const passed = scorePct >= template.passPercent && criticalFails === 0;
    const cfg = await this.settings.get();
    const results = await this.prisma.db.$transaction(async (tx) => {
      const { count } = await tx.auditRecord.updateMany({ where: { id, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', scorePct, passed, criticalFails, completedAt: new Date() } });
      if (!count) throw new ConflictException('Audit is already completed');
      const out: any[] = answers.map((a) => ({ ...a }));
      for (const i of failed) {
        const act = await this.actions.create({ branchId: rec.branchId, source: 'AUDIT', sourceId: id, title: `${template.name}: ${i.label}`, description: by.get(i.id)!.note, severity: i.critical ? 'CRITICAL' : 'MEDIUM', dueAt: new Date(Date.now() + (i.critical ? cfg.criticalActionDays : cfg.actionDays) * DAY) }, user.id, tx);
        out.find((o) => o.itemId === i.id).actionId = act.id;
      }
      await tx.auditRecord.updateMany({ where: { id }, data: { results: out as any } });
      await this.audit.record({ action: 'audit.completed', entityType: 'AuditRecord', entityId: id, after: { scorePct, passed, criticalFails, findings: failed.length } }, tx);
      return out;
    });
    if (criticalFails) {
      await this.exceptions.raise({ code: 'OPS_AUDIT_CRITICAL', reason: `Audit "${template.name}" found ${criticalFails} critical failure(s)`, evidence: { auditId: id, branchId: rec.branchId }, impact: 'Critical findings need corrective action', branchId: rec.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'HIGH', availableActions: ['resolve'] });
    }
    return { ...(await this.prisma.db.auditRecord.findFirstOrThrow({ where: { id } })), results };
  }
}
