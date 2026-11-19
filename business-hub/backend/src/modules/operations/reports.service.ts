import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { DashboardService } from './dashboard.service';
import { branchFilter } from './scope';

export const REPORTS = ['checklists', 'audits', 'training', 'food-safety', 'actions'] as const;
export type ReportKind = (typeof REPORTS)[number];
type Row = Record<string, string | number | boolean | null>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// A60: compliance, audit, training and safety reporting, scoped to the caller's branches, as rows or CSV.
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly dash: DashboardService) {}

  async rows(kind: string, f: { branchId?: string; from?: string; to?: string }, user: RequestUser): Promise<Row[]> {
    if (!(REPORTS as readonly string[]).includes(kind)) throw new BadRequestException(`Unknown report; use one of ${REPORTS.join(', ')}`);
    const scope = branchFilter(user, f.branchId);
    const range = (field: string) => ({ [field]: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lt: new Date(new Date(f.to).getTime() + 86_400_000) } : {}) } });
    const branches = new Map((await this.prisma.db.branch.findMany()).map((b) => [b.id, b.name]));
    const emps = new Map((await this.prisma.db.employee.findMany({ select: { id: true, name: true, number: true } })).map((e) => [e.id, e]));
    const who = (id: string | null) => (id ? `${emps.get(id)?.name ?? id} (${emps.get(id)?.number ?? ''})` : null);
    const take = 5000;
    switch (kind as ReportKind) {
      case 'checklists': {
        const tpls = new Map((await this.prisma.db.checklistTemplate.findMany()).map((t) => [t.id, t]));
        const r = await this.prisma.db.checklistRun.findMany({ where: { ...scope, ...range('dueAt') }, orderBy: { dueAt: 'asc' }, take });
        return r.map((x) => ({ branch: branches.get(x.branchId) ?? x.branchId, checklist: tpls.get(x.templateId)?.name ?? x.templateId, employee: who(x.employeeId), due: iso(x.dueAt), status: x.status, completedAt: iso(x.completedAt), late: x.completedLate, criticalFailures: x.criticalFailures, onRequest: !x.assignmentId }));
      }
      case 'audits': {
        const tpls = new Map((await this.prisma.db.auditTemplate.findMany()).map((t) => [t.id, t]));
        const r = await this.prisma.db.auditRecord.findMany({ where: { ...scope, ...range('startedAt') }, orderBy: { startedAt: 'asc' }, take });
        return r.map((x) => ({ branch: branches.get(x.branchId) ?? x.branchId, audit: tpls.get(x.templateId)?.name ?? x.templateId, started: iso(x.startedAt), completed: iso(x.completedAt), status: x.status, scorePct: x.scorePct, passed: x.passed, criticalFails: x.criticalFails }));
      }
      case 'training': {
        const inScope = scope.branchId ? new Set((await this.prisma.db.employeeAssignment.findMany({ where: { ...scope, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.employeeId)) : null;
        const r = await this.prisma.db.trainingAssignment.findMany({ where: { itemCode: { not: null }, ...(inScope ? { employeeId: { in: [...inScope] } } : {}), ...(f.from || f.to ? range('dueDate') : {}) }, orderBy: { dueDate: 'asc' }, take });
        return r.map((x) => ({ employee: who(x.employeeId), training: x.title, due: x.dueDate ? x.dueDate.toISOString().slice(0, 10) : null, status: x.status, attempts: x.attempts, bestScore: x.bestScore, completedAt: iso(x.completedAt), source: x.source }));
      }
      case 'food-safety': {
        const pts = new Map((await this.prisma.db.foodSafetyPoint.findMany()).map((p) => [p.id, p]));
        const r = await this.prisma.db.foodSafetyReading.findMany({ where: { ...scope, ...range('takenAt') }, orderBy: { takenAt: 'asc' }, take });
        return r.map((x) => { const p = pts.get(x.pointId); return { branch: branches.get(x.branchId) ?? x.branchId, point: p?.name ?? x.pointId, kind: p?.kind ?? null, takenAt: iso(x.takenAt), value: x.value.toString(), unit: p?.unit ?? null, min: p?.minValue?.toString() ?? null, max: p?.maxValue?.toString() ?? null, inRange: x.inRange, note: x.note }; });
      }
      case 'actions': {
        const r = await this.prisma.db.correctiveAction.findMany({ where: { ...scope, ...range('createdAt') }, orderBy: { createdAt: 'asc' }, take });
        return r.map((x) => ({ number: x.number, branch: branches.get(x.branchId) ?? x.branchId, source: x.source, severity: x.severity, title: x.title, status: x.status, assignee: who(x.assigneeEmployeeId), created: iso(x.createdAt), due: iso(x.dueAt), completed: iso(x.completedAt), verified: iso(x.verifiedAt) }));
      }
    }
  }

  // Cells that start with = + - @ are prefixed so a spreadsheet never runs them as formulas.
  csv(rows: Row[]) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const cell = (v: unknown) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  }
}
