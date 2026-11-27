import { ownDutyRule } from '../audit/owner-override';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { MANAGERS } from '../workforce/common';
import { AuditService } from '../audit/audit.service';

// ponytail: placeholder cap (1 day's basic per deduction), NOT legally verified; companies change it in policy 'discipline.settings'.
const DEFAULT_MAX_DEDUCTION_DAYS = 1;
// The ladder a company starts with; keys keep working for older cases. It owns and edits the list afterwards.
const DEFAULT_ACTIONS: [string, string, number, boolean][] = [['VERBAL', 'First warning (verbal)', 1, true], ['WRITTEN', 'Second warning (written)', 2, true], ['FINAL', 'Third / final warning', 3, true], ['FINE', 'Deduction only', 0, false]];
const COUNTED = ['APPROVED', 'NOTIFIED', 'APPEALED', 'CLOSED'];
const DEFAULT_CATEGORIES = [['ATTENDANCE', 'Attendance'], ['CONDUCT', 'Conduct'], ['SAFETY', 'Safety'], ['POLICY', 'Policy']];

@Injectable()
export class DisciplineService {
  constructor(private readonly prisma: PrismaService, private readonly seq: SequenceService, private readonly audit: AuditService) {}

  // First use per company creates the four defaults; after that the company owns the list.
  async categories(includeInactive = false) {
    if (!(await this.prisma.db.disciplineCategory.count())) await this.prisma.db.disciplineCategory.createMany({ data: DEFAULT_CATEGORIES.map(([key, label]) => ({ tenantId: currentTenantId(), key, label })), skipDuplicates: true });
    return this.prisma.db.disciplineCategory.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { label: 'asc' } });
  }

  async saveCategory(input: { key: string; label: string; expiryMonths?: number | null; active?: boolean }) {
    await this.categories(true);
    const key = input.key.trim().toUpperCase().replace(/\s+/g, '_');
    const data = { label: input.label, expiryMonths: input.expiryMonths ?? null, active: input.active ?? true };
    await this.prisma.db.disciplineCategory.upsert({ where: { tenantId_key: { tenantId: currentTenantId(), key } }, create: { tenantId: currentTenantId(), key, ...data }, update: data });
    await this.audit.record({ action: 'discipline.category_saved', entityType: 'DisciplineCategory', entityId: key, after: data });
    return this.categories(true);
  }


  async actions(includeInactive = false) {
    if (!(await this.prisma.db.disciplineAction.count())) await this.prisma.db.disciplineAction.createMany({ data: DEFAULT_ACTIONS.map(([key, label, step, countsAsWarning]) => ({ tenantId: currentTenantId(), key, label, step, countsAsWarning })), skipDuplicates: true });
    return this.prisma.db.disciplineAction.findMany({ where: includeInactive ? {} : { active: true }, orderBy: [{ step: 'asc' }, { label: 'asc' }] });
  }

  async saveAction(input: { key: string; label: string; step?: number; countsAsWarning?: boolean; defaultDeduction?: number | null; active?: boolean }) {
    await this.actions(true);
    const key = input.key.trim().toUpperCase().replace(/\s+/g, '_');
    if (key === 'NONE') throw new BadRequestException('NONE is reserved for dismissing a case');
    const countsAsWarning = input.countsAsWarning ?? true;
    const data = { label: input.label, step: countsAsWarning ? Math.max(1, input.step ?? 1) : 0, countsAsWarning, defaultDeduction: input.defaultDeduction ?? null, active: input.active ?? true };
    await this.prisma.db.disciplineAction.upsert({ where: { tenantId_key: { tenantId: currentTenantId(), key } }, create: { tenantId: currentTenantId(), key, ...data }, update: data });
    await this.audit.record({ action: 'discipline.action_saved', entityType: 'DisciplineAction', entityId: key, after: data });
    return this.actions(true);
  }

  // Where the employee stands on the ladder: warnings that still count (decided, not overturned, not expired) and the next step.
  async suggest(employeeId: string) {
    const [actions, cases] = await Promise.all([this.actions(), this.prisma.db.disciplinaryCase.findMany({ where: { employeeId, status: { in: COUNTED as any } }, orderBy: { decidedAt: 'asc' } })]);
    const today = new Date();
    const counting = new Set(actions.filter((a) => a.countsAsWarning).map((a) => a.key));
    const active = cases.filter((c) => c.sanction && counting.has(c.sanction) && c.appealOutcome !== 'OVERTURNED' && (!c.expiresAt || c.expiresAt >= today));
    const ladder = actions.filter((a) => a.countsAsWarning);
    const next = ladder.length ? ladder[Math.min(active.length, ladder.length - 1)] : null;
    return { priorWarnings: active.length, suggested: next?.key ?? null, atTopOfLadder: !!ladder.length && active.length >= ladder.length, history: cases.map((c) => ({ number: c.number, sanction: c.sanction, decidedAt: c.decidedAt, counts: active.includes(c), fineAmount: c.fineAmount })) };
  }

  private async maxDeductionDays() {
    const p = await this.prisma.db.policy.findFirst({ where: { key: 'discipline.settings', active: true } });
    const v = (p?.rules as { maxDeductionDays?: unknown } | undefined)?.maxDeductionDays;
    return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_DEDUCTION_DAYS;
  }

  list(q: { employeeId?: string; status?: string }) {
    return this.prisma.db.disciplinaryCase.findMany({ where: { employeeId: q.employeeId, status: q.status as any }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async get(id: string) {
    const c = await this.prisma.db.disciplinaryCase.findFirst({ where: { id } });
    if (!c) throw new NotFoundException('Case not found');
    return c;
  }

  // Employees only ever see their own case, and only once it has been notified to them.
  async mine(employeeId: string, id?: string) {
    const where = { employeeId, status: { in: ['EMPLOYEE_RESPONSE', 'NOTIFIED', 'APPEALED', 'CLOSED'] as any } };
    const label = new Map((await this.actions(true)).map((a) => [a.key, a.label]));
    const named = <T extends { sanction: string | null }>(c: T) => ({ ...c, sanctionLabel: c.sanction ? label.get(c.sanction) ?? c.sanction : null });
    if (!id) return (await this.prisma.db.disciplinaryCase.findMany({ where, orderBy: { createdAt: 'desc' } })).map(named);
    const c = await this.prisma.db.disciplinaryCase.findFirst({ where: { ...where, id } });
    if (!c) throw new NotFoundException('Case not found');
    return named(c);
  }

  async report(input: { employeeId: string; category: string; description: string; incidentDate: string; evidenceDocIds?: string[] }, user: RequestUser) {
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } });
    if (!emp) throw new BadRequestException('Unknown employee');
    if (!(await this.categories()).some((c) => c.key === input.category)) throw new BadRequestException('Unknown or inactive category');
    await ownDutyRule(emp.userId === user.id, user, this.audit, 'Employee', emp.id, 'You cannot report yourself');
    // A branch-scoped manager may only report staff currently assigned to their branch.
    const now = new Date();
    const branches = (await this.prisma.db.employeeAssignment.findMany({ where: { employeeId: emp.id, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] } })).map((a) => a.branchId);
    if (!branches.some((b) => { try { assertBranchAccess(user, b, MANAGERS); return true; } catch { return false; } })) throw new ForbiddenException('Employee is outside your branch');
    const row = await this.prisma.db.disciplinaryCase.create({
      data: { tenantId: '', number: await this.seq.next('discipline', 'DC'), employeeId: emp.id, category: input.category, description: input.description, incidentDate: new Date(input.incidentDate), evidenceDocIds: input.evidenceDocIds ?? [], reportedBy: user.id },
    });
    await this.audit.record({ action: 'discipline.reported', entityType: 'DisciplinaryCase', entityId: row.id, after: { employee: emp.number, category: input.category } });
    return row;
  }

  // Nobody handles a case about themselves, whatever their role.
  private async notSelf(employeeId: string, user: RequestUser) {
    await ownDutyRule((await this.prisma.db.employee.findFirst({ where: { id: employeeId } }))?.userId === user.id, user, this.audit, 'Employee', employeeId, 'You cannot handle a case about yourself');
  }

  private async move(id: string, from: string[], to: string, data: Record<string, unknown> = {}, action = `discipline.${to.toLowerCase()}`) {
    const c = await this.get(id);
    const { count } = await this.prisma.db.disciplinaryCase.updateMany({ where: { id, status: { in: from as any } }, data: { status: to as any, ...data } });
    if (!count) throw new ConflictException(`Case is ${c.status}`);
    await this.audit.record({ action, entityType: 'DisciplinaryCase', entityId: id, before: { status: c.status }, after: { status: to, ...data } });
    return this.get(id);
  }

  async startReview(id: string, user: RequestUser) { await this.notSelf((await this.get(id)).employeeId, user); return this.move(id, ['REPORTED'], 'UNDER_REVIEW'); }
  async requestResponse(id: string, user: RequestUser) { await this.notSelf((await this.get(id)).employeeId, user); return this.move(id, ['UNDER_REVIEW'], 'EMPLOYEE_RESPONSE'); }

  async respond(id: string, employeeId: string, text: string) {
    await this.mine(employeeId, id);
    return this.move(id, ['EMPLOYEE_RESPONSE'], 'DECISION_PENDING', { employeeResponse: text, respondedAt: new Date() }, 'discipline.employee_responded');
  }

  // HR decides; a deduction needs OWNER, a legal basis and stays under the cap. Dismissal is a decision too.
  async decide(id: string, input: { sanction: string; fineAmount?: number; legalBasis?: string; note?: string; expiresAt?: string }, user: RequestUser) {
    const c = await this.get(id);
    await this.notSelf(c.employeeId, user);
    if (!['UNDER_REVIEW', 'DECISION_PENDING'].includes(c.status)) throw new ConflictException(`Case is ${c.status}`);
    if (input.sanction === 'NONE') return this.move(id, ['UNDER_REVIEW', 'DECISION_PENDING'], 'DISMISSED', { sanction: 'NONE', decisionNote: input.note, decidedBy: user.id, decidedAt: new Date() });
    const action = (await this.actions()).find((a) => a.key === input.sanction);
    if (!action) throw new BadRequestException('Unknown or inactive disciplinary action');
    // Any action may carry a deduction; money leaving a payslip is OWNER-approved, needs a basis and stays under the company's cap.
    let fine: ReturnType<typeof money> | null = null;
    if (input.sanction === 'FINE' && !input.fineAmount) throw new BadRequestException('A deduction requires an amount');
    if (input.fineAmount) {
      if (!user.roles.some((r) => r.key === 'OWNER')) throw new ForbiddenException('Only an OWNER may approve a disciplinary deduction');
      if (!input.legalBasis?.trim()) throw new BadRequestException('A deduction requires a legal/policy basis');
      if (input.fineAmount <= 0) throw new BadRequestException('A deduction requires an amount');
      const contract = await this.prisma.db.employmentContract.findFirst({ where: { employeeId: c.employeeId, status: { not: 'ENDED' } }, orderBy: { version: 'desc' } });
      if (!contract) throw new BadRequestException('Employee has no active contract');
      fine = money(input.fineAmount);
      const days = await this.maxDeductionDays();
      if (fine.gt(d(contract.salaryBasic).div(30).times(days))) throw new BadRequestException(`Deduction exceeds ${days} day(s) of basic salary`);
    }
    const cat = (await this.categories(true)).find((x) => x.key === c.category);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : cat?.expiryMonths ? new Date(new Date().setMonth(new Date().getMonth() + cat.expiryMonths)) : null;
    return this.move(id, ['UNDER_REVIEW', 'DECISION_PENDING'], 'APPROVED', { sanction: input.sanction, fineAmount: fine, legalBasis: input.legalBasis, decisionNote: input.note, expiresAt, decidedBy: user.id, decidedAt: new Date() }, 'discipline.approved');
  }

  // Notice goes to the employee; a fine becomes ONE payroll deduction (unique sourceRef blocks duplicates).
  async notify(id: string, user: RequestUser) {
    const c = await this.get(id);
    await this.notSelf(c.employeeId, user);
    if (c.status !== 'APPROVED') throw new ConflictException(`Case is ${c.status}`);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.disciplinaryCase.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'NOTIFIED', notifiedAt: new Date() } });
      if (c.fineAmount) {
        await tx.payrollAdjustment.create({ data: { tenantId: currentTenantId(), employeeId: c.employeeId, kind: 'DEDUCTION', label: `Disciplinary deduction ${c.number} (${c.legalBasis})`, amount: c.fineAmount, sourceRef: `discipline:${id}`, createdBy: user.id } });
      }
      await this.audit.record({ action: 'discipline.notified', entityType: 'DisciplinaryCase', entityId: id, after: { sanction: c.sanction, fine: c.fineAmount?.toString() ?? null } }, tx);
    });
    return this.get(id);
  }

  // Acknowledging receipt is not agreement.
  async acknowledge(id: string, employeeId: string) {
    const c = await this.mine(employeeId, id) as any;
    if (c.status !== 'NOTIFIED') throw new ConflictException(`Case is ${c.status}`);
    await this.prisma.db.disciplinaryCase.updateMany({ where: { id }, data: { acknowledgedAt: new Date() } });
    await this.audit.record({ action: 'discipline.acknowledged', entityType: 'DisciplinaryCase', entityId: id });
    return this.get(id);
  }

  async appeal(id: string, employeeId: string, text: string) {
    await this.mine(employeeId, id);
    return this.move(id, ['NOTIFIED'], 'APPEALED', { appealText: text }, 'discipline.appealed');
  }

  // Overturning a fine that is not yet in a finalized run reverses it; an already-applied deduction needs a payroll correction.
  async decideAppeal(id: string, outcome: 'UPHELD' | 'OVERTURNED', user: RequestUser) {
    const c = await this.get(id);
    await this.notSelf(c.employeeId, user);
    if (c.status !== 'APPEALED') throw new ConflictException(`Case is ${c.status}`);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.disciplinaryCase.updateMany({ where: { id }, data: { status: 'CLOSED', appealOutcome: outcome, appealDecidedBy: user.id } });
      if (outcome === 'OVERTURNED' && c.fineAmount) {
        const adj = await tx.payrollAdjustment.findFirst({ where: { sourceRef: `discipline:${id}` } });
        if (adj?.appliedRunId) await tx.payrollAdjustment.create({ data: { tenantId: currentTenantId(), employeeId: c.employeeId, kind: 'EARNING', label: `Refund of overturned deduction ${c.number}`, amount: adj.amount, sourceRef: `discipline:${id}:refund`, createdBy: user.id } });
        else if (adj) await tx.payrollAdjustment.deleteMany({ where: { id: adj.id } });
      }
      await this.audit.record({ action: 'discipline.appeal_decided', entityType: 'DisciplinaryCase', entityId: id, after: { outcome } }, tx);
    });
    return this.get(id);
  }

  async close(id: string, user: RequestUser) { await this.notSelf((await this.get(id)).employeeId, user); return this.move(id, ['NOTIFIED'], 'CLOSED'); }
}
