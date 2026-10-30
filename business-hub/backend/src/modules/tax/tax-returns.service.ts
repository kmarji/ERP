import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Decimal, d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ammanToday, dateOnly } from '../../common/time';
import { actorHasRole, currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.module';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { WorkflowRegistry } from '../workflow-engine/workflow.types';
import { TaxFilingAdapter } from './tax.adapters';
import { buildTotals, LedgerEntryLike } from './tax-return-builder';

export const WF07 = 'WF-07';
const FILE_ACTION = 'tax.file_return';
const DAY = 86_400_000;

export interface Finding {
  code: string;
  severity: 'HARD' | 'SOFT';
  message: string;
  details?: unknown;
  acknowledged?: boolean;
  acknowledgedBy?: string;
  reason?: string;
}

@Injectable()
export class TaxReturnsService implements OnModuleInit {
  private readonly log = new Logger(TaxReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowEngineService,
    private readonly registry: WorkflowRegistry,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly posting: FinancePostingService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly filing: TaxFilingAdapter,
  ) {}

  onModuleInit() {
    this.registry.register({
      key: WF07,
      name: 'Transaction-to-Tax-Filing',
      initial: 'DRAFT',
      terminal: ['CANCELLED', 'ARCHIVED'],
      transitions: {
        DRAFT: { submit_review: 'IN_REVIEW', cancel: 'CANCELLED' },
        IN_REVIEW: { review_approved: 'AWAITING_AUTHORIZATION', review_rejected: 'DRAFT' },
        AWAITING_AUTHORIZATION: { authorized: 'APPROVED', declined: 'DRAFT' },
        APPROVED: { filing_recorded: 'FILED' },
        FILED: { payment_recorded: 'PAID' },
        PAID: { archive: 'ARCHIVED' },
      },
    });
  }

  // ---------------------------------------------------------------- periods

  async createPeriod(input: { legalEntityId: string; startDate: string; endDate: string; dueDate?: string; label?: string }) {
    const start = dateOnly(input.startDate);
    const end = dateOnly(input.endDate);
    if (end < start) throw new BadRequestException('endDate is before startDate');
    if (!(await this.prisma.db.legalEntity.findFirst({ where: { id: input.legalEntityId } }))) throw new BadRequestException('Unknown legal entity');
    const overlap = await this.prisma.db.taxPeriod.findFirst({ where: { legalEntityId: input.legalEntityId, startDate: { lte: end }, endDate: { gte: start } } });
    if (overlap) throw new ConflictException(`Overlaps tax period ${overlap.label}`);
    // Placeholder due date (30 days after period end): the real filing calendar must be confirmed in discovery.
    const due = input.dueDate ? dateOnly(input.dueDate) : new Date(end.getTime() + 30 * DAY);
    const row = await this.prisma.db.taxPeriod.create({ data: { tenantId: '', legalEntityId: input.legalEntityId, label: input.label ?? `${input.startDate.slice(0, 10)} to ${input.endDate.slice(0, 10)}`, startDate: start, endDate: end, dueDate: due } });
    await this.audit.record({ action: 'tax_period.created', entityType: 'TaxPeriod', entityId: row.id, after: row });
    return row;
  }

  listPeriods() {
    return this.prisma.db.taxPeriod.findMany({ include: { returns: { select: { id: true, version: true, status: true, netPayable: true } } }, orderBy: { startDate: 'desc' } });
  }

  // ---------------------------------------------------------------- draft generation (steps 15-17)

  async generate(periodId: string, user: RequestUser) {
    const period = await this.prisma.db.taxPeriod.findFirst({ where: { id: periodId } });
    if (!period) throw new NotFoundException('Tax period not found');
    const latest = await this.prisma.db.taxReturn.findFirst({ where: { periodId }, orderBy: { version: 'desc' } });
    if (latest && !['DRAFT', 'CANCELLED'].includes(latest.status)) throw new ConflictException(`Return v${latest.version} is ${latest.status}; it must be sent back to draft or cancelled before regenerating`);

    const entries = await this.prisma.db.taxLedgerEntry.findMany({ where: { legalEntityId: period.legalEntityId, documentDate: { gte: period.startDate, lte: period.endDate } } });
    const totals = buildTotals(entries.map<LedgerEntryLike>((e) => ({ direction: e.direction, taxRate: d(e.taxRate), eligible: e.eligible, base: d(e.base), taxAmount: d(e.taxAmount), sourceId: e.sourceId })));
    const findings = await this.validate(period, entries, totals);
    const papers = await this.workingPapers(period, entries);

    const created = await this.prisma.db.$transaction(async (tx) => {
      if (latest?.status === 'DRAFT') await tx.taxReturn.updateMany({ where: { id: latest.id }, data: { status: 'CANCELLED' } });
      const row = await tx.taxReturn.create({
        data: {
          tenantId: '',
          periodId,
          legalEntityId: period.legalEntityId,
          version: (latest?.version ?? 0) + 1,
          outputBase: totals.outputBase,
          outputTax: totals.outputTax,
          inputBase: totals.inputBase,
          inputTaxRecoverable: totals.inputTaxRecoverable,
          inputTaxNonRecoverable: totals.inputTaxNonRecoverable,
          netPayable: totals.netPayable,
          findings: findings as any,
          workingPapers: papers as any,
          generatedBy: user.id,
          lines: { create: totals.lines.map((l) => ({ tenantId: currentTenantId(), direction: l.direction, taxRate: l.taxRate, eligible: l.eligible, base: l.base, tax: l.tax, documents: l.documents })) },
        },
        include: { lines: true },
      });
      await this.audit.record({ action: 'tax_return.generated', entityType: 'TaxReturn', entityId: row.id, after: { version: row.version, outputTax: totals.outputTax.toString(), inputRecoverable: totals.inputTaxRecoverable.toString(), net: totals.netPayable.toString(), findings: findings.map((f) => f.code) } }, tx);
      return row;
    });

    if (latest?.status === 'DRAFT') {
      const oldWf = await this.workflow.findBySubject(WF07, 'TaxReturn', latest.id);
      if (oldWf && !oldWf.closed) await this.workflow.fire(oldWf.id, 'cancel');
    }
    const wf = await this.workflow.start(WF07, 'TaxReturn', created.id, 'REGULATED');
    const hard = findings.filter((f) => f.severity === 'HARD');
    if (hard.length) {
      await this.exceptions.raise({
        workflowId: wf.id,
        code: 'TAX_RETURN_FINDINGS',
        reason: `Draft return for ${period.label} has ${hard.length} issue(s) to resolve: ${hard.map((f) => f.message).slice(0, 2).join('; ')}${hard.length > 2 ? '; ...' : ''}`,
        evidence: { taxReturnId: created.id, findings: hard },
        impact: 'The return cannot go to review until each issue is fixed (regenerate) or acknowledged with a reason',
        branchId: undefined,
        ownerRole: 'FINANCE',
        riskTier: 'MEDIUM',
        availableActions: ['resolve'],
      });
    }
    return this.get(created.id);
  }

  private async validate(period: { id: string; legalEntityId: string; startDate: Date; endDate: Date }, entries: { taxRate: Prisma.Decimal; direction: string; sourceType: string; sourceId: string; journalId: string | null; eligible: boolean }[], totals: ReturnType<typeof buildTotals>): Promise<Finding[]> {
    const findings: Finding[] = [];
    const endExclusive = new Date(period.endDate.getTime() + DAY);
    const branches = await this.prisma.db.branch.findMany({ where: { legalEntityId: period.legalEntityId }, select: { id: true } });
    const branchIds = branches.map((b) => b.id);

    // 1. every sale and credit note in the period must have reached the ledger
    const unposted = await this.prisma.db.order.findMany({ where: { branchId: { in: branchIds }, status: 'COMPLETED', postingStatus: { not: 'POSTED' }, completedAt: { gte: period.startDate, lt: endExclusive } }, select: { id: true, number: true } });
    const unpostedRefunds = await this.prisma.db.refund.findMany({ where: { order: { branchId: { in: branchIds } }, postingStatus: { not: 'POSTED' }, createdAt: { gte: period.startDate, lt: endExclusive } }, select: { id: true, number: true } });
    if (unposted.length || unpostedRefunds.length) {
      findings.push({ code: 'UNPOSTED_DOCUMENTS', severity: 'HARD', message: `${unposted.length} sale(s) and ${unpostedRefunds.length} credit note(s) in the period are not posted, so their tax is missing from the return`, details: { orders: unposted.map((o) => o.number), refunds: unpostedRefunds.map((r) => r.number) } });
    }

    // 2. rates must be known tax codes
    const codes = await this.prisma.db.taxCode.findMany({ where: { active: true } });
    const known = new Set(codes.map((c) => d(c.rate).toString()));
    const unknown = [...new Set(entries.map((e) => d(e.taxRate).toString()).filter((r) => !known.has(r)))];
    if (unknown.length) findings.push({ code: 'UNKNOWN_TAX_RATE', severity: 'HARD', message: `Documents carry tax rate(s) ${unknown.join(', ')} that match no active tax code`, details: { rates: unknown } });

    // 3. purchase invoices: duplicates and unverified suppliers (input tax needs a valid tax invoice)
    const inputIds = entries.filter((e) => e.direction === 'INPUT').map((e) => e.sourceId);
    const invoices = inputIds.length ? await this.prisma.db.supplierInvoice.findMany({ where: { id: { in: [...new Set(inputIds)] } } }) : [];
    const seen = new Map<string, string[]>();
    for (const i of invoices) {
      const k = `${i.supplierId}|${i.invoiceNumber.trim().toUpperCase()}`;
      seen.set(k, [...(seen.get(k) ?? []), i.id]);
    }
    const dupes = [...seen.values()].filter((v) => v.length > 1);
    if (dupes.length) findings.push({ code: 'DUPLICATE_PURCHASE_INVOICE', severity: 'HARD', message: `${dupes.length} supplier invoice number(s) appear more than once in the period`, details: { invoiceIds: dupes.flat() } });
    const eligibleIds = new Set(entries.filter((e) => e.direction === 'INPUT' && e.eligible).map((e) => e.sourceId));
    const unverified = invoices.filter((i) => eligibleIds.has(i.id) && !i.supplierTaxNumber);
    if (unverified.length) findings.push({ code: 'INPUT_TAX_UNVERIFIED', severity: 'HARD', message: `${unverified.length} invoice(s) claim input tax but show no supplier tax number`, details: { invoices: unverified.map((i) => i.invoiceNumber) } });

    // 4. the return must tie to the ledger: tax lines of the very journals the evidence rows point at
    const journalIds = [...new Set(entries.map((e) => e.journalId).filter((x): x is string => !!x))];
    const accts = await this.prisma.db.chartAccount.findMany({ where: { systemKey: { in: ['OUTPUT_TAX', 'INPUT_TAX'] } } });
    const outId = accts.find((a) => a.systemKey === 'OUTPUT_TAX')?.id;
    const inId = accts.find((a) => a.systemKey === 'INPUT_TAX')?.id;
    const glSum = async (accountId: string | undefined) => {
      if (!accountId || !journalIds.length) return { debit: d(0), credit: d(0) };
      const a = await this.prisma.db.journalLine.aggregate({ where: { accountId, journalId: { in: journalIds } }, _sum: { debit: true, credit: true } });
      return { debit: d(a._sum.debit), credit: d(a._sum.credit) };
    };
    const gout = await glSum(outId);
    const gin = await glSum(inId);
    const glOutput = gout.credit.minus(gout.debit);
    const glInput = gin.debit.minus(gin.credit);
    const tol = d('0.001');
    if (glOutput.minus(totals.outputTax).abs().gt(tol) || glInput.minus(totals.inputTaxRecoverable).abs().gt(tol)) {
      findings.push({ code: 'LEDGER_MISMATCH', severity: 'HARD', message: `Return does not reconcile to the ledger: output tax ${totals.outputTax} vs ledger ${money(glOutput)}, recoverable input ${totals.inputTaxRecoverable} vs ledger ${money(glInput)}`, details: { glOutput: money(glOutput).toString(), glInput: money(glInput).toString() } });
    }

    // 5. hand-posted journals touching the tax accounts are not evidenced by documents
    if (outId || inId) {
      const manual = await this.prisma.db.journalLine.count({ where: { accountId: { in: [outId, inId].filter((x): x is string => !!x) }, journal: { sourceType: 'MANUAL', legalEntityId: period.legalEntityId, postingDate: { gte: period.startDate, lte: period.endDate } } } });
      if (manual) findings.push({ code: 'MANUAL_TAX_JOURNAL', severity: 'SOFT', message: `${manual} manual journal line(s) touch the tax accounts in this period and carry no source document`, details: { lines: manual } });
    }
    return findings;
  }

  // Detailed working papers: sales by day, every purchase invoice with its eligibility, and credit notes.
  private async workingPapers(period: { startDate: Date; endDate: Date }, entries: { direction: string; sourceType: string; sourceId: string; documentDate: Date; base: Prisma.Decimal; taxAmount: Prisma.Decimal; eligible: boolean; taxRate: Prisma.Decimal }[]) {
    const salesByDay = new Map<string, { date: string; documents: Set<string>; base: Decimal; tax: Decimal }>();
    const credits: { documentDate: string; refundId: string; base: string; tax: string }[] = [];
    const purchases: { documentDate: string; invoiceId: string; taxRate: string; base: string; tax: string; eligible: boolean }[] = [];
    for (const e of entries) {
      const date = e.documentDate.toISOString().slice(0, 10);
      if (e.direction === 'OUTPUT' && e.sourceType === 'Order') {
        const cur = salesByDay.get(date) ?? { date, documents: new Set<string>(), base: d(0), tax: d(0) };
        cur.documents.add(e.sourceId);
        cur.base = cur.base.plus(e.base);
        cur.tax = cur.tax.plus(e.taxAmount);
        salesByDay.set(date, cur);
      } else if (e.direction === 'OUTPUT') {
        credits.push({ documentDate: date, refundId: e.sourceId, base: d(e.base).toString(), tax: d(e.taxAmount).toString() });
      } else {
        purchases.push({ documentDate: date, invoiceId: e.sourceId, taxRate: d(e.taxRate).toString(), base: d(e.base).toString(), tax: d(e.taxAmount).toString(), eligible: e.eligible });
      }
    }
    const inv = purchases.length ? await this.prisma.db.supplierInvoice.findMany({ where: { id: { in: [...new Set(purchases.map((p) => p.invoiceId))] } }, include: { } }) : [];
    const byId = new Map(inv.map((i) => [i.id, i]));
    return {
      period: { start: period.startDate.toISOString().slice(0, 10), end: period.endDate.toISOString().slice(0, 10) },
      sales: [...salesByDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((s) => ({ date: s.date, invoices: s.documents.size, base: money(s.base).toString(), tax: money(s.tax).toString() })),
      creditNotes: credits,
      purchases: purchases.map((p) => ({ ...p, invoiceNumber: byId.get(p.invoiceId)?.invoiceNumber, supplierTaxNumber: byId.get(p.invoiceId)?.supplierTaxNumber ?? null })),
    };
  }

  // ---------------------------------------------------------------- reads

  async get(id: string) {
    const r = await this.prisma.db.taxReturn.findFirst({ where: { id }, include: { lines: true, period: true } });
    if (!r) throw new NotFoundException('Tax return not found');
    const wf = await this.workflow.findBySubject(WF07, 'TaxReturn', id);
    return { ...r, workflowState: wf?.state ?? null };
  }

  list(periodId?: string) {
    return this.prisma.db.taxReturn.findMany({ where: { periodId }, include: { period: true }, orderBy: [{ generatedAt: 'desc' }], take: 100 });
  }

  async workingPapersCsv(id: string) {
    const r = await this.get(id);
    const wp = r.workingPapers as any;
    const rows: string[] = ['section,date,document,rate,base,tax,eligible'];
    for (const s of wp.sales ?? []) rows.push(['SALES', s.date, `${s.invoices} invoices`, '', s.base, s.tax, ''].join(','));
    for (const c of wp.creditNotes ?? []) rows.push(['CREDIT_NOTE', c.documentDate, c.refundId, '', c.base, c.tax, ''].join(','));
    for (const p of wp.purchases ?? []) rows.push(['PURCHASE', p.documentDate, JSON.stringify(p.invoiceNumber ?? p.invoiceId), p.taxRate, p.base, p.tax, String(p.eligible)].join(','));
    rows.push('');
    rows.push(`TOTAL_OUTPUT_TAX,,,,${r.outputBase},${r.outputTax},`);
    rows.push(`INPUT_TAX_RECOVERABLE,,,,,${r.inputTaxRecoverable},true`);
    rows.push(`INPUT_TAX_NON_RECOVERABLE,,,,,${r.inputTaxNonRecoverable},false`);
    rows.push(`NET_PAYABLE,,,,,${r.netPayable},`);
    return rows.join('\n');
  }

  // ---------------------------------------------------------------- review (step 18)

  async acknowledge(id: string, input: { code: string; reason: string }, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'DRAFT') throw new ConflictException(`Return is ${r.status}`);
    const findings = (r.findings as unknown as Finding[]).map((f) => (f.code === input.code ? { ...f, acknowledged: true, acknowledgedBy: user.id, reason: input.reason } : f));
    if (!findings.some((f) => f.code === input.code)) throw new NotFoundException('No such finding on this return');
    await this.prisma.db.taxReturn.updateMany({ where: { id }, data: { findings: findings as any } });
    await this.audit.record({ action: 'tax_return.finding_acknowledged', entityType: 'TaxReturn', entityId: id, after: input });
    return this.get(id);
  }

  async submitForReview(id: string, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'DRAFT') throw new ConflictException(`Return is ${r.status}`);
    const open = (r.findings as unknown as Finding[]).filter((f) => f.severity === 'HARD' && !f.acknowledged);
    if (open.length) throw new ConflictException(`Unresolved issues: ${open.map((f) => f.code).join(', ')}. Fix the data and regenerate, or acknowledge each with a reason.`);
    await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'IN_REVIEW' } });
    await this.fire(id, 'submit_review');
    await this.closeFindingsException(id);
    await this.audit.record({ action: 'tax_return.submitted_for_review', entityType: 'TaxReturn', entityId: id, after: { by: user.id } });
    return this.get(id);
  }

  private async closeFindingsException(returnId: string) {
    const wf = await this.workflow.findBySubject(WF07, 'TaxReturn', returnId);
    if (!wf) return;
    for (const ex of await this.prisma.db.exception.findMany({ where: { workflowId: wf.id, code: 'TAX_RETURN_FINDINGS', status: 'NOTIFIED' } })) {
      await this.exceptions.transition(ex.id, 'RESOLVED', 'Issues fixed or acknowledged');
      await this.exceptions.transition(ex.id, 'VERIFIED', 'Return sent to review');
    }
  }

  // A qualified finance reviewer who did not prepare the draft checks it, then the authorized owner decides on filing.
  async review(id: string, input: { approve: boolean; comment?: string }, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'IN_REVIEW') throw new ConflictException(`Return is ${r.status}`);
    if (r.generatedBy === user.id) throw new ForbiddenException('The preparer cannot review their own return');
    if (!actorHasRole(user, 'FINANCE')) throw new ForbiddenException('Only a finance reviewer can review a tax return');
    if (!input.approve) {
      await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'DRAFT' } });
      await this.fire(id, 'review_rejected');
      await this.audit.record({ action: 'tax_return.review_rejected', entityType: 'TaxReturn', entityId: id, after: { comment: input.comment, by: user.id } });
      return this.get(id);
    }
    await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'AWAITING_AUTHORIZATION', reviewedBy: user.id, reviewedAt: new Date() } });
    await this.fire(id, 'review_approved');
    const decision = await this.policy.evaluate(FILE_ACTION, { amount: Math.abs(Number(r.netPayable)) });
    // Filing is regulated: always an explicit decision by the owner/authorized representative, never auto.
    await this.approvals.request({ subjectType: 'TaxReturn', subjectId: id, action: FILE_ACTION, approverRole: decision.approverRole ?? 'OWNER', amount: Math.abs(Number(r.netPayable)) });
    await this.audit.record({ action: 'tax_return.review_approved', entityType: 'TaxReturn', entityId: id, after: { comment: input.comment, by: user.id, net: r.netPayable.toString() } });
    return this.get(id);
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== FILE_ACTION) return;
    await runWithTenant(e.tenantId, async () => {
      const r = await this.prisma.db.taxReturn.findFirst({ where: { id: e.subjectId }, include: { period: true } });
      if (!r || r.status !== 'AWAITING_AUTHORIZATION') return;
      if (!e.approved) {
        await this.prisma.db.taxReturn.updateMany({ where: { id: r.id }, data: { status: 'DRAFT' } });
        await this.fire(r.id, 'declined');
        return;
      }
      // Authorizing a filing closes the books for the period: later corrections become adjustments in a later period.
      await this.prisma.db.financialPeriod.upsert({
        where: { tenantId_startDate: { tenantId: currentTenantId(), startDate: r.period.startDate } },
        create: { tenantId: currentTenantId(), startDate: r.period.startDate, endDate: r.period.endDate, status: 'LOCKED', lockedBy: e.decidedBy, lockedAt: new Date() },
        update: { endDate: r.period.endDate, status: 'LOCKED', lockedBy: e.decidedBy, lockedAt: new Date() },
      });
      await this.prisma.db.taxReturn.updateMany({ where: { id: r.id }, data: { status: 'APPROVED', authorizedBy: e.decidedBy, authorizedAt: new Date() } });
      await this.fire(r.id, 'authorized');
      await this.audit.record({ action: 'tax_return.authorized', entityType: 'TaxReturn', entityId: r.id, after: { by: e.decidedBy, periodLocked: true } });
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ---------------------------------------------------------------- filing, payment, archive (steps 19-20)

  // Official submission is only attempted where the adapter says it is permitted and authorized; otherwise the
  // system produces a guided package and tracks the manual filing to completion.
  async preparePackage(id: string, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'APPROVED') throw new ConflictException(`Return must be approved for filing first (it is ${r.status})`);
    const cap = this.filing.capabilities();
    const summary = {
      taxReturnId: r.id,
      period: r.period.label,
      version: r.version,
      totals: { outputBase: r.outputBase, outputTax: r.outputTax, inputRecoverable: r.inputTaxRecoverable, inputNonRecoverable: r.inputTaxNonRecoverable, netPayable: r.netPayable },
      lines: r.lines.map((l) => ({ direction: l.direction, rate: l.taxRate, eligible: l.eligible, base: l.base, tax: l.tax, documents: l.documents })),
      acknowledgedFindings: (r.findings as unknown as Finding[]).filter((f) => f.acknowledged),
      authorizedBy: r.authorizedBy,
      authorizedAt: r.authorizedAt,
    };
    const jsonDoc = await this.docs.upload({ originalname: `tax-return-${r.period.label}-v${r.version}.json`, mimetype: 'application/json', buffer: Buffer.from(JSON.stringify(summary, null, 2)), size: 0 }, user, { subjectType: 'TaxReturn', subjectId: id }, { extract: false });
    const csv = await this.workingPapersCsv(id);
    const csvDoc = await this.docs.upload({ originalname: `working-papers-${r.period.label}-v${r.version}.csv`, mimetype: 'text/csv', buffer: Buffer.from(csv), size: 0 }, user, { subjectType: 'TaxReturn', subjectId: id }, { extract: false });
    await this.prisma.db.taxReturn.updateMany({ where: { id }, data: { packageDocId: jsonDoc.id, filingMethod: 'MANUAL' } });
    await this.audit.record({ action: 'tax_return.package_prepared', entityType: 'TaxReturn', entityId: id, after: { method: 'MANUAL', reason: cap.reason } });
    return {
      method: 'MANUAL',
      why: cap.reason,
      documents: [{ id: jsonDoc.id, name: jsonDoc.filename }, { id: csvDoc.id, name: csvDoc.filename }],
      steps: [
        'Sign in to the official tax authority portal with the authorized credentials.',
        `Enter the figures from the summary: output tax ${r.outputTax}, recoverable input tax ${r.inputTaxRecoverable}, net ${r.netPayable} JOD.`,
        'Attach or keep the working papers (CSV) as supporting evidence.',
        'Submit, then record the official acknowledgment number back here.',
        r.netPayable.gt(0) ? 'Pay the amount due through an authorized channel and record the payment reference here.' : 'No payment is due; the credit position is carried forward.',
      ],
    };
  }

  async recordFiling(id: string, input: { acknowledgmentRef: string; filedAt?: string; evidenceDocumentId?: string }, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'APPROVED') throw new ConflictException(`Return must be approved before a filing can be recorded (it is ${r.status})`);
    if (!r.packageDocId) throw new ConflictException('Prepare the filing package first');
    await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'FILED', acknowledgmentRef: input.acknowledgmentRef, filedAt: input.filedAt ? dateOnly(input.filedAt) : ammanToday(), filedBy: user.id } });
    if (input.evidenceDocumentId) await this.prisma.db.evidenceDocument.updateMany({ where: { id: input.evidenceDocumentId }, data: { subjectType: 'TaxReturn', subjectId: id } });
    await this.fire(id, 'filing_recorded');
    await this.audit.record({ action: 'tax_return.filed', entityType: 'TaxReturn', entityId: id, after: { acknowledgmentRef: input.acknowledgmentRef, by: user.id } });
    return this.get(id);
  }

  // Settles the period's tax accounts. Output tax is cleared against recoverable input tax; the cash paid is the net.
  async recordPayment(id: string, input: { reference?: string; method?: string; paidAt?: string }, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'FILED') throw new ConflictException(`Payment can only be recorded after filing (return is ${r.status})`);
    const net = d(r.netPayable);
    if (net.gt(0) && !input.reference) throw new BadRequestException('A payment reference is required when tax is payable');
    const paidAt = input.paidAt ? dateOnly(input.paidAt) : ammanToday();
    let journalId: string | null = null;
    // A credit position with no output tax has nothing to settle: the recoverable input tax is carried forward.
    if (net.gt(0) || d(r.outputTax).gt(0)) {
      try {
        const clearInput = net.gt(0) ? d(r.inputTaxRecoverable) : d(r.outputTax);
        const j = await this.posting.post({
          sourceType: 'TaxReturn',
          sourceId: id,
          idempotencyKey: `taxreturn:${id}:payment`,
          postingDate: paidAt,
          memo: `Tax return ${r.period.label} v${r.version} settlement (${input.reference ?? 'no payment due'})`,
          legalEntityId: r.legalEntityId,
          lines: [
            { account: 'OUTPUT_TAX', debit: r.outputTax },
            { account: 'INPUT_TAX', credit: clearInput },
            { account: input.method === 'CASH' ? 'CASH' : 'BANK', credit: net.gt(0) ? net : 0 },
          ],
        });
        journalId = j.id;
      } catch (e) {
        if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
        throw e;
      }
    }
    await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'FILED' }, data: { status: 'PAID', paymentRef: input.reference ?? null, paymentMethod: input.method ?? (net.gt(0) ? 'BANK' : null), paidAt, paymentJournalId: journalId } });
    await this.fire(id, 'payment_recorded');
    await this.audit.record({ action: 'tax_return.payment_recorded', entityType: 'TaxReturn', entityId: id, after: { reference: input.reference, net: net.toString(), by: user.id } });
    return this.get(id);
  }

  async archive(id: string, user: RequestUser) {
    const r = await this.get(id);
    if (r.status !== 'PAID') throw new ConflictException(`Only a paid return can be archived (it is ${r.status})`);
    if (!r.packageDocId || !r.acknowledgmentRef) throw new ConflictException('The filing package and the official acknowledgment must be on record before archiving');
    await this.prisma.db.taxReturn.updateMany({ where: { id, status: 'PAID' }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    await this.fire(id, 'archive');
    await this.audit.record({ action: 'tax_return.archived', entityType: 'TaxReturn', entityId: id, after: { by: user.id } });
    return this.get(id);
  }

  async evidence(id: string) {
    await this.get(id);
    return this.docs.forSubject('TaxReturn', id);
  }

  private async fire(returnId: string, event: string) {
    const wf = await this.workflow.findBySubject(WF07, 'TaxReturn', returnId);
    if (wf && !wf.closed) await this.workflow.fire(wf.id, event);
  }

  // Overdue filings escalate through the normal exception SLA route (finance, then owner).
  @Cron('0 6 * * *', { timeZone: 'Asia/Amman' })
  async dueDateSweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.flagOverdue()).catch((e) => this.log.error(`tax overdue sweep failed for ${t.id}: ${e.message}`));
  }

  async flagOverdue() {
    const today = ammanToday();
    const periods = await this.prisma.db.taxPeriod.findMany({ where: { dueDate: { lt: today } }, include: { returns: true } });
    const open = await this.prisma.db.exception.findMany({ where: { code: 'TAX_FILING_OVERDUE', status: 'NOTIFIED' } });
    let raised = 0;
    for (const p of periods) {
      if (p.returns.some((r) => ['FILED', 'PAID', 'ARCHIVED'].includes(r.status))) continue;
      if (open.some((e) => (e.evidence as any)?.periodId === p.id)) continue;
      await this.exceptions.raise({ code: 'TAX_FILING_OVERDUE', reason: `The tax return for ${p.label} was due ${p.dueDate.toISOString().slice(0, 10)} and is not filed`, evidence: { periodId: p.id }, impact: 'Late filing may carry penalties', ownerRole: 'FINANCE', riskTier: 'HIGH', availableActions: ['resolve'] });
      raised++;
    }
    return raised;
  }
}

import { Prisma } from '@prisma/client';
