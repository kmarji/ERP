import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Decimal, d, money } from '../../common/money';
import { FieldCrypto } from '../../common/crypto/field-crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { ammanToday, dateOnly } from '../../common/time';
import { actorHasRole, currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.module';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { NotificationsService } from '../notifications/notifications.module';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { WorkflowRegistry } from '../workflow-engine/workflow.types';
import { AttendanceService } from '../workforce/attendance.service';
import { calculatePay, overlapDays } from './payroll-engine';
import { PayrollRulesService } from './payroll-rules.service';

export const WF04 = 'WF-04';
const FINALIZE = 'payroll.finalize';
const RELEASE = 'payroll.release_payment';
const SYSTEM = { id: 'system', tenantId: '', email: 'system', isSystem: true, roles: [], delegations: [] } as RequestUser;
// Problems a person may consciously accept with a recorded reason. The rest must be fixed and the run recalculated.
const ACKNOWLEDGEABLE = ['MISSING_BANK', 'ANOMALOUS_NET', 'OVERTIME_LIMIT', 'ABSENT_SHIFTS'];
const DAY = 86_400_000;

type Draft = { employeeId?: string; code: string; severity: 'HARD' | 'SOFT'; message: string; details?: object };

@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: PayrollRulesService,
    private readonly attendance: AttendanceService,
    private readonly workflow: WorkflowEngineService,
    private readonly registry: WorkflowRegistry,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly posting: FinancePostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly crypto: FieldCrypto,
  ) {}

  onModuleInit() {
    this.registry.register({
      key: WF04,
      name: 'Attendance-to-Payroll',
      initial: 'DRAFT',
      terminal: ['PAID', 'CANCELLED'],
      transitions: {
        DRAFT: { calculated: 'CALCULATED', cancel: 'CANCELLED' },
        CALCULATED: { submit_review: 'IN_REVIEW', cancel: 'CANCELLED' },
        IN_REVIEW: { review_rejected: 'CALCULATED', authorized: 'FINALIZED', declined: 'CALCULATED' },
        FINALIZED: { payment_recorded: 'PAID' },
      },
    });
  }

  // ---------------------------------------------------------------- runs

  async createRun(input: { legalEntityId: string; periodStart: string; periodEnd: string }, user: RequestUser) {
    const start = dateOnly(input.periodStart);
    const end = dateOnly(input.periodEnd);
    if (end < start) throw new BadRequestException('periodEnd is before periodStart');
    if (!(await this.prisma.db.legalEntity.findFirst({ where: { id: input.legalEntityId } }))) throw new BadRequestException('Unknown legal entity');
    const existing = await this.prisma.db.payrollRun.findFirst({ where: { legalEntityId: input.legalEntityId, status: { not: 'CANCELLED' }, periodStart: { lte: end }, periodEnd: { gte: start } } });
    if (existing) throw new ConflictException(`Overlaps payroll run ${existing.number} (${existing.status})`);
    const rs = await this.rules.activeFor(end);
    const run = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('PAY', 'PAY', tx);
      const r = await tx.payrollRun.create({ data: { tenantId: '', number, legalEntityId: input.legalEntityId, periodStart: start, periodEnd: end, ruleSetId: rs.id, ruleVersion: rs.version, createdBy: user.id } });
      await this.audit.record({ action: 'payroll_run.created', entityType: 'PayrollRun', entityId: r.id, after: { number, period: `${input.periodStart}..${input.periodEnd}`, rules: rs.version } }, tx);
      return r;
    });
    await this.workflow.start(WF04, 'PayrollRun', run.id, 'HIGH');
    return run;
  }

  async get(id: string) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id }, include: { lines: true, exceptions: true } });
    if (!run) throw new NotFoundException('Payroll run not found');
    const rs = await this.prisma.db.payrollRuleSet.findFirst({ where: { id: run.ruleSetId } });
    const wf = await this.workflow.findBySubject(WF04, 'PayrollRun', id);
    return { ...run, rulesVerified: !!rs?.verifiedAt, workflowState: wf?.state ?? null };
  }

  list() {
    return this.prisma.db.payrollRun.findMany({ orderBy: { periodStart: 'desc' }, take: 100 });
  }

  private async fire(runId: string, event: string) {
    const wf = await this.workflow.findBySubject(WF04, 'PayrollRun', runId);
    if (wf && !wf.closed) await this.workflow.fire(wf.id, event);
  }

  // Imports approved attendance, leave, compensation and deductions and computes every employee's pay with a trace.
  async calculate(runId: string) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (!['DRAFT', 'CALCULATED'].includes(run.status)) throw new ConflictException(`Run is ${run.status}; send it back to calculated state to recalculate`);
    const rs = await this.rules.activeFor(run.periodEnd);
    const rules = rs.rules;
    const periodDays = Math.round((run.periodEnd.getTime() - run.periodStart.getTime()) / DAY) + 1;

    const employees = await this.prisma.db.employee.findMany({
      where: { legalEntityId: run.legalEntityId, hireDate: { lte: run.periodEnd }, OR: [{ terminationDate: null }, { terminationDate: { gte: run.periodStart } }] },
      include: { contracts: true, assignments: true },
      orderBy: { number: 'asc' },
    });

    const drafts: Draft[] = [];
    const lines: Prisma.PayrollRunLineUncheckedCreateInput[] = [];
    const advanceRecoveries: { advanceId: string; amount: Decimal }[] = [];
    const adjustmentIds: string[] = [];

    for (const e of employees) {
      const contract = e.contracts.filter((c) => c.startDate <= run.periodEnd && c.status !== 'ENDED').sort((a, b) => b.version - a.version)[0];
      if (!contract) {
        drafts.push({ employeeId: e.id, code: 'MISSING_CONTRACT', severity: 'HARD', message: `${e.name} has no employment contract effective in this period` });
        continue;
      }
      const days = overlapDays(run.periodStart, run.periodEnd, new Date(Math.max(e.hireDate.getTime(), contract.startDate.getTime())), e.terminationDate && contract.endDate ? new Date(Math.min(e.terminationDate.getTime(), contract.endDate.getTime())) : e.terminationDate ?? contract.endDate);
      if (days === 0) continue;
      const att = await this.attendance.summarize(e.id, run.periodStart, run.periodEnd);

      await this.createRetro(e.id, run.periodStart, e.contracts);
      const adjustments = await this.prisma.db.payrollAdjustment.findMany({ where: { employeeId: e.id, appliedRunId: null } });
      const other = adjustments.reduce((s, a) => (a.kind === 'EARNING' ? s.plus(a.amount) : s.minus(a.amount)), d(0));
      adjustmentIds.push(...adjustments.map((a) => a.id));

      const primary = e.assignments.find((a) => a.isPrimary && (!a.validTo || a.validTo >= run.periodStart)) ?? e.assignments[0];
      const allowances = (contract.allowances as { amount: number }[]).reduce((s, a) => s.plus(a.amount), d(0));

      // advances are recovered by instalment; everything outstanding is recovered when the employee leaves
      let recovery = d(0);
      const advs = await this.prisma.db.employeeAdvance.findMany({ where: { employeeId: e.id, status: 'ACTIVE' } });
      const leaving = e.terminationDate && e.terminationDate <= run.periodEnd;
      for (const a of advs) {
        const take = Decimal.min(d(a.remaining), leaving ? d(a.remaining) : d(a.installmentAmount));
        if (take.gt(0)) {
          recovery = recovery.plus(take);
          advanceRecoveries.push({ advanceId: a.id, amount: take });
        }
      }

      const input = { basic: d(contract.salaryBasic), allowances, periodDays, daysEmployed: days, overtimeMinutes: att.overtimeMinutes, lateMinutes: att.lateMinutes, unpaidLeaveDays: att.unpaidLeaveDays, otherEarnings: other, advanceRecovery: recovery };
      let calc = calculatePay(rules, input);
      if (calc.net.isNegative() && recovery.gt(0)) {
        // never take more than the employee earns: cap recovery and carry the rest
        const capacity = Decimal.max(d(0), calc.net.plus(recovery));
        const capped = Decimal.min(recovery, capacity);
        advanceRecoveries.forEach((r, idx) => { if (advs.some((a) => a.id === r.advanceId)) advanceRecoveries[idx] = { ...r, amount: r.amount.times(recovery.isZero() ? 0 : capped.div(recovery)).toDecimalPlaces(3) }; });
        calc = calculatePay(rules, { ...input, advanceRecovery: capped });
      }

      if (att.unresolvedEntries > 0 || att.missingPunches > 0) drafts.push({ employeeId: e.id, code: 'UNRESOLVED_TIME', severity: 'HARD', message: `${e.name} has ${att.unresolvedEntries} unresolved time record(s) in the period`, details: { unresolved: att.unresolvedEntries, missingPunches: att.missingPunches } });
      if (att.absentShifts > 0) drafts.push({ employeeId: e.id, code: 'ABSENT_SHIFTS', severity: 'SOFT', message: `${e.name} has ${att.absentShifts} scheduled shift(s) with no time entry and no approved leave`, details: { absentShifts: att.absentShifts } });
      if (d(contract.salaryBasic).lt(rules.minimumWageMonthly)) drafts.push({ employeeId: e.id, code: 'BELOW_MIN_WAGE', severity: 'HARD', message: `${e.name}'s basic salary ${contract.salaryBasic} is below the configured minimum wage ${rules.minimumWageMonthly}` });
      if (calc.net.isNegative()) drafts.push({ employeeId: e.id, code: 'NEGATIVE_NET', severity: 'HARD', message: `${e.name}'s net pay is negative (${calc.net})` });
      if (att.overtimeMinutes / 60 > rules.overtime.maxMonthlyHours) drafts.push({ employeeId: e.id, code: 'OVERTIME_LIMIT', severity: 'SOFT', message: `${e.name} worked ${(att.overtimeMinutes / 60).toFixed(1)} overtime hours, above the ${rules.overtime.maxMonthlyHours} hour policy limit` });
      const prev = await this.prisma.db.payrollRunLine.findFirst({ where: { employeeId: e.id, run: { status: { in: ['FINALIZED', 'PAID'] }, periodEnd: { lt: run.periodStart } } }, orderBy: { run: { periodEnd: 'desc' } } });
      if (prev && d(prev.net).gt(0)) {
        const pct = calc.net.minus(prev.net).abs().div(prev.net).times(100).toNumber();
        if (pct > rules.anomalyPct) drafts.push({ employeeId: e.id, code: 'ANOMALOUS_NET', severity: 'SOFT', message: `${e.name}'s net pay changed ${pct.toFixed(0)}% from last month (${prev.net} to ${calc.net})`, details: { previous: prev.net.toString(), current: calc.net.toString() } });
      }
      let iban: string | undefined;
      try { iban = e.sensitive ? this.crypto.decrypt<{ iban?: string }>(e.sensitive).iban : undefined; } catch { iban = undefined; }
      if (!iban) drafts.push({ employeeId: e.id, code: 'MISSING_BANK', severity: 'SOFT', message: `${e.name} has no bank account on file; they will not be in the bank file` });

      lines.push({
        tenantId: currentTenantId(),
        runId,
        employeeId: e.id,
        branchId: primary?.branchId ?? '',
        basic: calc.basic,
        allowances: calc.allowances,
        overtimePay: calc.overtimePay,
        otherEarnings: calc.otherEarnings,
        lateDeduction: calc.lateDeduction,
        unpaidLeaveDeduction: calc.unpaidLeaveDeduction,
        gross: calc.gross,
        sscEmployee: calc.sscEmployee,
        sscEmployer: calc.sscEmployer,
        incomeTax: calc.incomeTax,
        advances: calc.advances,
        net: calc.net,
        regularHours: d(att.regularMinutes).div(60).toDecimalPlaces(2),
        overtimeHours: d(att.overtimeMinutes).div(60).toDecimalPlaces(2),
        trace: { steps: calc.trace, inputs: { basic: input.basic.toString(), allowances: allowances.toString(), periodDays, daysEmployed: days, contractVersion: contract.version, ruleVersion: rs.version }, attendance: att } as any,
      });
    }

    const totals = this.totals(lines, drafts);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.payrollRunLine.deleteMany({ where: { runId } });
      await tx.payrollException.deleteMany({ where: { runId } });
      if (lines.length) await tx.payrollRunLine.createMany({ data: lines });
      if (drafts.length) await tx.payrollException.createMany({ data: drafts.map((x) => ({ tenantId: currentTenantId(), runId, employeeId: x.employeeId ?? null, code: x.code, severity: x.severity, message: x.message, details: (x.details ?? {}) as any })) });
      await tx.payrollRun.updateMany({ where: { id: runId }, data: { status: 'CALCULATED', totals: totals as any, ruleSetId: rs.id, ruleVersion: rs.version } });
      await this.audit.record({ action: 'payroll_run.calculated', entityType: 'PayrollRun', entityId: runId, actorType: 'SYSTEM', after: { ...totals, rules: rs.version } }, tx);
    });
    if (run.status === 'DRAFT') await this.fire(runId, 'calculated');
    const hard = drafts.filter((x) => x.severity === 'HARD');
    if (hard.length) await this.raiseReview(runId, run.legalEntityId, hard.length);
    return this.get(runId);
  }

  private totals(lines: Prisma.PayrollRunLineUncheckedCreateInput[], drafts: Draft[]) {
    const sum = (f: (l: Prisma.PayrollRunLineUncheckedCreateInput) => unknown) => lines.reduce((s, l) => s.plus(d(f(l) as Decimal)), d(0));
    const gross = sum((l) => l.gross);
    const er = sum((l) => l.sscEmployer);
    return { employees: lines.length, gross: money(gross).toString(), net: money(sum((l) => l.net)).toString(), sscEmployee: money(sum((l) => l.sscEmployee)).toString(), sscEmployer: money(er).toString(), incomeTax: money(sum((l) => l.incomeTax)).toString(), advances: money(sum((l) => l.advances)).toString(), employerCost: money(gross.plus(er)).toString(), hardExceptions: drafts.filter((x) => x.severity === 'HARD').length, softExceptions: drafts.filter((x) => x.severity === 'SOFT').length };
  }

  private async raiseReview(runId: string, _entity: string, hard: number) {
    const open = await this.prisma.db.exception.findMany({ where: { code: 'PAYROLL_REVIEW', status: 'NOTIFIED' } });
    if (open.some((e) => (e.evidence as any)?.runId === runId)) return;
    await this.exceptions.raise({ code: 'PAYROLL_REVIEW', reason: `Payroll run has ${hard} problem(s) that must be fixed before it can go to review`, evidence: { runId }, impact: 'Payroll cannot be reviewed or finalized while hard exceptions are open', ownerRole: 'HR', riskTier: 'MEDIUM', availableActions: ['resolve'] });
  }

  // Back-dated contract changes become a one-off adjustment in the next run; the finalized run itself is never edited.
  private async createRetro(employeeId: string, before: Date, contracts: { version: number; salaryBasic: Prisma.Decimal; startDate: Date; status: string }[]) {
    const lines = await this.prisma.db.payrollRunLine.findMany({ where: { employeeId, run: { status: { in: ['FINALIZED', 'PAID'] }, periodEnd: { lt: before } } }, include: { run: true } });
    for (const l of lines) {
      const inputs = (l.trace as any)?.inputs;
      if (!inputs) continue;
      const effective = contracts.filter((c) => c.startDate <= l.run.periodEnd && c.status !== 'ENDED').sort((a, b) => b.version - a.version)[0];
      if (!effective || effective.version <= (inputs.contractVersion ?? 0)) continue;
      const delta = d(effective.salaryBasic).minus(inputs.basic).times(inputs.daysEmployed).div(inputs.periodDays);
      if (!delta.gt(0)) continue;
      try {
        await this.prisma.db.payrollAdjustment.create({ data: { tenantId: '', employeeId, kind: 'EARNING', label: `Retroactive pay for ${l.run.periodStart.toISOString().slice(0, 7)} (contract v${effective.version})`, amount: money(delta), sourceRef: `retro:${l.id}`, createdBy: 'system' } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
  }

  async resolveException(id: string, input: { action: 'ACKNOWLEDGE' | 'RESOLVE'; note: string }, user: RequestUser) {
    const ex = await this.prisma.db.payrollException.findFirst({ where: { id } });
    if (!ex) throw new NotFoundException('Exception not found');
    if (ex.status !== 'OPEN') throw new ConflictException(`Exception is ${ex.status}`);
    if (ex.severity === 'HARD' && !ACKNOWLEDGEABLE.includes(ex.code)) throw new BadRequestException(`${ex.code} must be fixed at its source and the run recalculated; it cannot be acknowledged`);
    await this.prisma.db.payrollException.updateMany({ where: { id }, data: { status: input.action === 'RESOLVE' ? 'RESOLVED' : 'ACKNOWLEDGED', resolvedBy: user.id, note: input.note } });
    await this.audit.record({ action: 'payroll_exception.resolved', entityType: 'PayrollException', entityId: id, after: { code: ex.code, action: input.action, note: input.note } });
    return this.prisma.db.payrollException.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- review and authorization

  private async openHard(runId: string) {
    return this.prisma.db.payrollException.count({ where: { runId, severity: 'HARD', status: 'OPEN' } });
  }

  async submitReview(runId: string, user: RequestUser) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== 'CALCULATED') throw new ConflictException(`Run is ${run.status}`);
    const openSoft = await this.prisma.db.payrollException.count({ where: { runId, status: 'OPEN' } });
    if (await this.openHard(runId)) throw new ConflictException('Fix the hard exceptions and recalculate first');
    if (openSoft) throw new ConflictException(`${openSoft} open exception(s) need an HR decision (resolve or acknowledge with a note) before review`);
    await this.prisma.db.payrollRun.updateMany({ where: { id: runId, status: 'CALCULATED' }, data: { status: 'IN_REVIEW' } });
    await this.fire(runId, 'submit_review');
    await this.audit.record({ action: 'payroll_run.submitted_for_review', entityType: 'PayrollRun', entityId: runId, after: { by: user.id } });
    const open = await this.prisma.db.exception.findMany({ where: { code: 'PAYROLL_REVIEW', status: 'NOTIFIED' } });
    for (const ex of open.filter((e) => (e.evidence as any)?.runId === runId)) {
      await this.exceptions.transition(ex.id, 'RESOLVED', 'Payroll exceptions handled');
      await this.exceptions.transition(ex.id, 'VERIFIED', 'Run sent to review');
    }
    return this.get(runId);
  }

  async review(runId: string, input: { approve: boolean; comment?: string }, user: RequestUser) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== 'IN_REVIEW') throw new ConflictException(`Run is ${run.status}`);
    if (run.createdBy === user.id) throw new ForbiddenException('The person who prepared the payroll cannot review it');
    if (!input.approve) {
      await this.prisma.db.payrollRun.updateMany({ where: { id: runId }, data: { status: 'CALCULATED' } });
      await this.fire(runId, 'review_rejected');
      await this.audit.record({ action: 'payroll_run.review_rejected', entityType: 'PayrollRun', entityId: runId, after: { comment: input.comment, by: user.id } });
      return this.get(runId);
    }
    const rs = await this.prisma.db.payrollRuleSet.findFirst({ where: { id: run.ruleSetId } });
    if (!rs?.verifiedAt) throw new ConflictException(`Payroll rules v${run.ruleVersion} are unverified placeholders. Verify them against current law before finalizing payroll.`);
    const net = Number((run.totals as any).net ?? 0);
    const decision = await this.policy.evaluate(FINALIZE, { amount: net });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Payroll finalization is blocked by policy');
    await this.prisma.db.payrollRun.updateMany({ where: { id: runId }, data: { reviewedBy: user.id, reviewedAt: new Date() } });
    // Finalizing payroll is a high-risk action: never silent, always an explicit authorization by a designated approver.
    await this.approvals.request({ subjectType: 'PayrollRun', subjectId: runId, action: FINALIZE, approverRole: decision.approverRole ?? 'OWNER', amount: net });
    await this.audit.record({ action: 'payroll_run.review_approved', entityType: 'PayrollRun', entityId: runId, after: { by: user.id, net, comment: input.comment } });
    return this.get(runId);
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== FINALIZE) return;
    await runWithTenant(e.tenantId, async () => {
      const run = await this.prisma.db.payrollRun.findFirst({ where: { id: e.subjectId } });
      if (!run || run.status !== 'IN_REVIEW') return;
      if (!e.approved) {
        await this.prisma.db.payrollRun.updateMany({ where: { id: run.id }, data: { status: 'CALCULATED' } });
        await this.fire(run.id, 'declined');
        return;
      }
      if (e.decidedBy === run.createdBy) {
        await this.prisma.db.payrollRun.updateMany({ where: { id: run.id }, data: { status: 'CALCULATED' } });
        await this.fire(run.id, 'declined');
        await this.exceptions.raise({ code: 'PAYROLL_SEPARATION_OF_DUTIES', reason: `Payroll ${run.number} was authorized by the person who prepared it; the authorization was not used`, evidence: { runId: run.id }, ownerRole: 'FINANCE', riskTier: 'HIGH', availableActions: ['resolve'] });
        return;
      }
      await this.finalize(run.id, e.decidedBy);
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ---------------------------------------------------------------- finalization (balanced journal, payslips, obligations)

  async finalize(runId: string, approvedBy: string) {
    try {
      await this.prisma.db.$transaction(async (tx) => {
        const run = await tx.payrollRun.findFirst({ where: { id: runId }, include: { lines: true } });
        if (!run || !['IN_REVIEW', 'FINALIZED'].includes(run.status)) return;
        if (run.status === 'FINALIZED') return;
        if (await tx.payrollException.count({ where: { runId, severity: 'HARD', status: 'OPEN' } })) throw new ConflictException('Hard exceptions are still open');
        const rs = await tx.payrollRuleSet.findFirstOrThrow({ where: { id: run.ruleSetId } });
        if (!rs.verifiedAt) throw new ConflictException('Payroll rules are not verified');
        const entity = await tx.legalEntity.findFirstOrThrow({ where: { id: run.legalEntityId } });

        const byBranch = new Map<string, { gross: Decimal; er: Decimal }>();
        let net = d(0), sscEe = d(0), sscEr = d(0), tax = d(0), adv = d(0);
        for (const l of run.lines) {
          const b = byBranch.get(l.branchId) ?? { gross: d(0), er: d(0) };
          byBranch.set(l.branchId, { gross: b.gross.plus(l.gross), er: b.er.plus(l.sscEmployer) });
          net = net.plus(l.net); sscEe = sscEe.plus(l.sscEmployee); sscEr = sscEr.plus(l.sscEmployer); tax = tax.plus(l.incomeTax); adv = adv.plus(l.advances);
        }
        const journal = await this.posting.post(
          {
            sourceType: 'PayrollRun',
            sourceId: run.id,
            idempotencyKey: `payroll:${run.id}`,
            postingDate: run.periodEnd,
            memo: `Payroll ${run.number} ${run.periodStart.toISOString().slice(0, 7)}`,
            legalEntityId: entity.id,
            lines: [
              ...[...byBranch].flatMap(([branchId, v]) => [{ account: 'SALARY_EXPENSE', debit: v.gross, branchId: branchId || null }, { account: 'SSC_EXPENSE', debit: v.er, branchId: branchId || null }]),
              { account: 'PAYROLL_PAYABLE', credit: net },
              { account: 'SSC_PAYABLE', credit: sscEe.plus(sscEr) },
              { account: 'PAYROLL_TAX_PAYABLE', credit: tax },
              { account: 'EMPLOYEE_ADVANCES', credit: adv },
            ],
          },
          tx,
        );
        const due = new Date(run.periodEnd.getTime() + (parseInt(String((rs.rules as any)?.obligations?.dueDaysAfterPeriod ?? 15), 10) || 15) * DAY);
        for (const [kind, amount] of [['SSC', sscEe.plus(sscEr)], ['INCOME_TAX', tax]] as const) {
          if (amount.gt(0)) await tx.statutoryObligation.create({ data: { tenantId: currentTenantId(), runId, kind, amount: money(amount), dueDate: due } });
        }
        // instalments actually recovered reduce the advance balances; one-off adjustments are marked as used
        for (const l of run.lines.filter((x) => d(x.advances).gt(0))) {
          let left = d(l.advances);
          for (const a of await tx.employeeAdvance.findMany({ where: { employeeId: l.employeeId, status: 'ACTIVE' }, orderBy: { issuedAt: 'asc' } })) {
            if (!left.gt(0)) break;
            const take = Decimal.min(left, d(a.remaining));
            const remaining = d(a.remaining).minus(take);
            await tx.employeeAdvance.updateMany({ where: { id: a.id }, data: { remaining, status: remaining.gt(0) ? 'ACTIVE' : 'CLEARED' } });
            left = left.minus(take);
          }
        }
        await tx.payrollAdjustment.updateMany({ where: { employeeId: { in: run.lines.map((l) => l.employeeId) }, appliedRunId: null }, data: { appliedRunId: run.id } });
        await tx.payrollRun.updateMany({ where: { id: runId }, data: { status: 'FINALIZED', approvedBy, approvedAt: new Date(), finalizedAt: new Date(), journalId: journal.id } });
        await this.audit.record({ action: 'payroll_run.finalized', entityType: 'PayrollRun', entityId: runId, after: { approvedBy, net: net.toString(), journal: journal.number } }, tx);
      });
    } catch (e) {
      if (!(e instanceof FinanceError) && !(e instanceof ConflictException)) throw e;
      await this.exceptions.raise({ code: 'PAYROLL_FINALIZE_BLOCKED', reason: `Payroll could not be finalized: ${e.message}`, evidence: { runId }, ownerRole: 'FINANCE', riskTier: 'HIGH', availableActions: ['resolve'] });
      return;
    }
    await this.fire(runId, 'authorized');
    await this.generatePayslips(runId);
  }

  // Safe to repeat: lines that already have a payslip are skipped.
  async generatePayslips(runId: string) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId }, include: { lines: true } });
    if (!run || !['FINALIZED', 'PAID'].includes(run.status)) throw new ConflictException('Payslips exist only for finalized payroll');
    const emps = await this.prisma.db.employee.findMany({ where: { id: { in: run.lines.map((l) => l.employeeId) } } });
    let n = 0;
    for (const l of run.lines.filter((x) => !x.payslipDocId)) {
      const emp = emps.find((x) => x.id === l.employeeId)!;
      const html = renderPayslip(run.number, run.periodStart, run.periodEnd, emp.name, emp.number, l);
      const doc = await this.docs.upload({ originalname: `payslip-${emp.number}-${run.periodStart.toISOString().slice(0, 7)}.html`, mimetype: 'text/html', buffer: Buffer.from(html), size: html.length }, SYSTEM, { subjectType: 'PayrollRunLine', subjectId: l.id }, { extract: false });
      await this.prisma.db.payrollRunLine.updateMany({ where: { id: l.id }, data: { payslipDocId: doc.id } });
      if (emp.userId) await this.notifications.notify({ userId: emp.userId, title: `Your payslip for ${run.periodStart.toISOString().slice(0, 7)} is ready` });
      n++;
    }
    return { generated: n };
  }

  async bankFile(runId: string, user: RequestUser) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId }, include: { lines: true } });
    if (!run || !['FINALIZED', 'PAID'].includes(run.status)) throw new ConflictException('A bank file exists only for finalized payroll');
    const emps = await this.prisma.db.employee.findMany({ where: { id: { in: run.lines.map((l) => l.employeeId) } } });
    const rows = ['employee_number,name,iban,amount,currency,reference'];
    const skipped: string[] = [];
    for (const l of run.lines) {
      const e = emps.find((x) => x.id === l.employeeId)!;
      let iban: string | undefined;
      try { iban = e.sensitive ? this.crypto.decrypt<{ iban?: string }>(e.sensitive).iban : undefined; } catch { iban = undefined; }
      if (!iban || !d(l.net).gt(0)) { skipped.push(e.number); continue; }
      rows.push([e.number, JSON.stringify(e.name), iban, l.net.toString(), 'JOD', run.number].join(','));
    }
    // The file contains account numbers, so it is generated on demand and every download is audited, never stored.
    await this.audit.record({ action: 'payroll_run.bank_file_generated', entityType: 'PayrollRun', entityId: runId, actorId: user.id, actorType: 'USER', after: { rows: rows.length - 1, skipped } });
    return { csv: rows.join('\n'), skipped };
  }

  // ---------------------------------------------------------------- payment and obligations (tracked separately from calculation)

  async requestPayment(runId: string) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== 'FINALIZED') throw new ConflictException(`Run is ${run.status}`);
    const pending = await this.prisma.db.approval.findFirst({ where: { subjectType: 'PayrollRun', subjectId: runId, action: RELEASE, status: { in: ['PENDING', 'APPROVED'] } } });
    if (pending) return pending;
    const net = Number((run.totals as any).net ?? 0);
    const decision = await this.policy.evaluate(RELEASE, { amount: net });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Payment release is blocked by policy');
    return this.approvals.request({ subjectType: 'PayrollRun', subjectId: runId, action: RELEASE, approverRole: decision.approverRole ?? 'OWNER', amount: net });
  }

  async confirmPayment(runId: string, input: { reference: string; method?: 'BANK' | 'CASH'; paidAt?: string }, user: RequestUser) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === 'PAID') return this.get(runId);
    if (run.status !== 'FINALIZED') throw new ConflictException(`Run is ${run.status}`);
    const approved = await this.prisma.db.approval.findFirst({ where: { subjectType: 'PayrollRun', subjectId: runId, action: RELEASE, status: 'APPROVED' } });
    if (!approved) throw new ConflictException('Payment release has not been approved');
    const net = money((run.totals as any).net ?? 0);
    const paidAt = input.paidAt ? dateOnly(input.paidAt) : ammanToday();
    let journalId: string | null = null;
    try {
      const entity = run.legalEntityId;
      const j = await this.posting.post({ sourceType: 'PayrollPayment', sourceId: run.id, idempotencyKey: `payroll:${run.id}:payment`, postingDate: paidAt, memo: `Salaries ${run.number} paid (${input.reference})`, legalEntityId: entity, lines: [{ account: 'PAYROLL_PAYABLE', debit: net }, { account: input.method === 'CASH' ? 'CASH' : 'BANK', credit: net }] });
      journalId = j.id;
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    await this.prisma.db.payrollRun.updateMany({ where: { id: runId, status: 'FINALIZED' }, data: { status: 'PAID', paidAt, paymentRef: input.reference, paymentJournalId: journalId } });
    await this.fire(runId, 'payment_recorded');
    await this.audit.record({ action: 'payroll_run.paid', entityType: 'PayrollRun', entityId: runId, after: { reference: input.reference, by: user.id } });
    return this.get(runId);
  }

  listObligations(status?: string) {
    return this.prisma.db.statutoryObligation.findMany({ where: { status }, orderBy: { dueDate: 'asc' }, take: 200 });
  }

  async payObligation(id: string, input: { reference: string; paidAt?: string }, user: RequestUser) {
    const o = await this.prisma.db.statutoryObligation.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Obligation not found');
    if (o.status === 'PAID') return o;
    const run = await this.prisma.db.payrollRun.findFirstOrThrow({ where: { id: o.runId } });
    const paidAt = input.paidAt ? dateOnly(input.paidAt) : ammanToday();
    try {
      const j = await this.posting.post({ sourceType: 'StatutoryObligation', sourceId: o.id, idempotencyKey: `obligation:${o.id}`, postingDate: paidAt, memo: `${o.kind} for ${run.number} paid (${input.reference})`, legalEntityId: run.legalEntityId, lines: [{ account: o.kind === 'SSC' ? 'SSC_PAYABLE' : 'PAYROLL_TAX_PAYABLE', debit: o.amount }, { account: 'BANK', credit: o.amount }] });
      await this.prisma.db.statutoryObligation.updateMany({ where: { id }, data: { status: 'PAID', reference: input.reference, paidAt, journalId: j.id } });
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    await this.audit.record({ action: 'obligation.paid', entityType: 'StatutoryObligation', entityId: id, after: { reference: input.reference, by: user.id } });
    return this.prisma.db.statutoryObligation.findFirstOrThrow({ where: { id } });
  }

  async cancel(runId: string) {
    const run = await this.prisma.db.payrollRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (!['DRAFT', 'CALCULATED'].includes(run.status)) throw new ConflictException(`Run is ${run.status}; a finalized run is reversed with journal reversals, never deleted`);
    await this.prisma.db.payrollRun.updateMany({ where: { id: runId }, data: { status: 'CANCELLED' } });
    await this.fire(runId, 'cancel');
    return this.get(runId);
  }

  // ---------------------------------------------------------------- advances and adjustments

  async issueAdvance(input: { employeeId: string; amount: number; installments: number; reason?: string }, user: RequestUser) {
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId, status: { in: ['ACTIVE', 'ONBOARDING', 'ON_LEAVE'] } } });
    if (!emp) throw new BadRequestException('Unknown or inactive employee');
    const amount = money(input.amount);
    return this.prisma.db.$transaction(async (tx) => {
      const a = await tx.employeeAdvance.create({ data: { tenantId: '', employeeId: emp.id, amount, installments: input.installments, installmentAmount: money(amount.div(input.installments)), remaining: amount, reason: input.reason ?? null, approvedBy: user.id, createdBy: user.id } });
      await this.posting.post({ sourceType: 'EmployeeAdvance', sourceId: a.id, idempotencyKey: `advance:${a.id}`, postingDate: ammanToday(), memo: `Advance to ${emp.name}`, legalEntityId: emp.legalEntityId, lines: [{ account: 'EMPLOYEE_ADVANCES', debit: amount }, { account: 'CASH', credit: amount }] }, tx);
      await this.audit.record({ action: 'advance.issued', entityType: 'EmployeeAdvance', entityId: a.id, after: { employee: emp.number, amount: amount.toString(), installments: input.installments } }, tx);
      return a;
    });
  }

  listAdvances(employeeId?: string) {
    return this.prisma.db.employeeAdvance.findMany({ where: { employeeId }, orderBy: { issuedAt: 'desc' }, take: 200 });
  }

  async addAdjustment(input: { employeeId: string; kind: 'EARNING' | 'DEDUCTION'; label: string; amount: number }, user: RequestUser) {
    if (!(await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } }))) throw new BadRequestException('Unknown employee');
    const decision = await this.policy.evaluate('payroll.adjustment', { amount: input.amount });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Adjustments are blocked by policy');
    if (decision.decision !== 'AUTO' && !decision.escalationRoute.some((r) => actorHasRole(user, r))) throw new ForbiddenException(`An adjustment of ${input.amount} JOD needs ${decision.approverRole} approval`);
    const row = await this.prisma.db.payrollAdjustment.create({ data: { tenantId: '', employeeId: input.employeeId, kind: input.kind, label: input.label, amount: money(input.amount), createdBy: user.id } });
    await this.audit.record({ action: 'payroll_adjustment.created', entityType: 'PayrollAdjustment', entityId: row.id, after: { ...input, approvedBy: decision.decision === 'AUTO' ? null : user.id } });
    return row;
  }

  listAdjustments(applied?: boolean) {
    return this.prisma.db.payrollAdjustment.findMany({ where: applied === undefined ? {} : { appliedRunId: applied ? { not: null } : null }, orderBy: { createdAt: 'desc' }, take: 200 });
  }
}

function renderPayslip(runNumber: string, start: Date, end: Date, name: string, number: string, l: { basic: Prisma.Decimal; allowances: Prisma.Decimal; overtimePay: Prisma.Decimal; otherEarnings: Prisma.Decimal; lateDeduction: Prisma.Decimal; unpaidLeaveDeduction: Prisma.Decimal; gross: Prisma.Decimal; sscEmployee: Prisma.Decimal; incomeTax: Prisma.Decimal; advances: Prisma.Decimal; net: Prisma.Decimal; regularHours: Prisma.Decimal; overtimeHours: Prisma.Decimal }) {
  const row = (en: string, ar: string, v: Prisma.Decimal | string, sign = '') => `<tr><td>${en} / ${ar}</td><td style="text-align:end">${sign}${v}</td></tr>`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(number)}</title></head><body style="font-family:sans-serif;max-width:640px"><h2>Payslip / قسيمة الراتب</h2><p>${esc(name)} (${esc(number)})<br>${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} · ${esc(runNumber)}</p><table width="100%" border="1" cellspacing="0" cellpadding="6">${row('Basic', 'الراتب الأساسي', l.basic)}${row('Allowances', 'البدلات', l.allowances)}${row('Overtime', 'العمل الإضافي', l.overtimePay)}${row('Adjustments', 'تعديلات', l.otherEarnings)}${row('Unpaid leave', 'إجازة بدون راتب', l.unpaidLeaveDeduction, '-')}${row('Lateness', 'التأخير', l.lateDeduction, '-')}${row('Gross', 'الإجمالي', l.gross)}${row('Social security', 'الضمان الاجتماعي', l.sscEmployee, '-')}${row('Income tax', 'ضريبة الدخل', l.incomeTax, '-')}${row('Advance recovery', 'استرداد سلفة', l.advances, '-')}<tr><th>Net pay / صافي الراتب</th><th style="text-align:end">${l.net} JOD</th></tr></table><p>Hours: regular ${l.regularHours}, overtime ${l.overtimeHours}</p></body></html>`;
}
