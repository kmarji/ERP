import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Decimal, d, money, qty as roundQty, rate } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { ammanToday, dateOnly } from '../../common/time';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { DocumentsService } from '../documents/documents.module';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { InventoryService } from '../inventory/inventory.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { WorkflowRegistry } from '../workflow-engine/workflow.types';
import { Finding, finding, InvoiceLineN, threeWayMatch } from './three-way-match';

export const WF01 = 'WF-01';
const POLICY = 'receiving.three_way_match';
const VARIANCE_ACTION = 'receiving.post_with_variance';
const TOLERANCES = { totalAbs: 0.01, taxAbs: 0.05 };
const ROLE_RANK: Record<string, number> = { PROCUREMENT: 30, BRANCH_MANAGER: 40, FINANCE: 60, OWNER: 100 };
export const RECEIVER_ROLES = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'] as const;
const HIGH_RISK = new Set(['DUPLICATE_INVOICE', 'TAX_DISCREPANCY', 'SUPPLIER_MISMATCH']);

export interface RawInvoiceLine {
  supplierSku?: string;
  description?: string;
  productId?: string;
  qty: number;
  unit: string;
  unitPrice: number;
  taxRate?: number;
  lineNet?: number;
  lineTax?: number;
}

export interface RawInvoice {
  invoiceNumber?: string;
  invoiceDate?: string;
  supplierTaxNumber?: string;
  qrUuid?: string;
  qrPayload?: string;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
  lines?: RawInvoiceLine[];
}

export interface ReceiveInput {
  idempotencyKey: string;
  purchaseOrderId?: string;
  supplierId?: string;
  branchId: string;
  stockLocationId: string;
  evidenceDocumentId?: string;
  invoice?: RawInvoice;
  receivedLines: { poLineId?: string; productId?: string; qty: number; unit?: string }[];
}

type ProductWithTax = Prisma.ProductGetPayload<{ include: { taxCode: true } }>;

@Injectable()
export class ReceivingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly workflow: WorkflowEngineService,
    private readonly registry: WorkflowRegistry,
    private readonly inventory: InventoryService,
    private readonly posting: FinancePostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
  ) {}

  onModuleInit() {
    this.registry.register({
      key: WF01,
      name: 'Purchase-to-Compliance',
      initial: 'CAPTURED',
      terminal: ['REJECTED', 'ARCHIVED'],
      transitions: {
        CAPTURED: { match_passed: 'POSTED', match_failed: 'EXCEPTION' },
        EXCEPTION: { approved: 'POSTED', rejected: 'REJECTED' },
        POSTED: { payment_approved: 'PAYMENT_APPROVED' },
        PAYMENT_APPROVED: { payment_confirmed: 'PAID' },
        PAID: { archive: 'ARCHIVED' },
      },
    });
  }

  // ================================================================ capture + match + (auto) post

  async receive(input: ReceiveInput, user: RequestUser) {
    assertBranchAccess(user, input.branchId, RECEIVER_ROLES);
    const replay = await this.prisma.db.goodsReceipt.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return { ...(await this.outcome(replay.id)), replay: true };

    const po = input.purchaseOrderId
      ? await this.prisma.db.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId }, include: { lines: true } })
      : null;
    if (input.purchaseOrderId && !po) throw new BadRequestException('Unknown purchase order');
    if (po && !['ISSUED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new ConflictException(`Purchase order is ${po.status}`);
    const supplierId = po?.supplierId ?? input.supplierId;
    if (!supplierId) throw new BadRequestException('supplierId is required when there is no purchase order');
    const supplier = await this.prisma.db.supplier.findFirst({ where: { id: supplierId } });
    if (!supplier) throw new BadRequestException('Unknown supplier');
    const location = await this.prisma.db.stockLocation.findFirst({ where: { id: input.stockLocationId, branchId: input.branchId } });
    if (!location) throw new BadRequestException('Stock location does not belong to the branch');
    const branch = await this.prisma.db.branch.findFirstOrThrow({ where: { id: input.branchId } });

    // ---- invoice draft: extracted fields first, human-entered fields override
    const doc = input.evidenceDocumentId ? await this.docs.get(input.evidenceDocumentId) : null;
    const ex: any = doc?.extracted ?? {};
    const exField = (k: string) => ex.fields?.[k]?.value ?? null;
    const manual = input.invoice ?? {};
    const rawLines: RawInvoiceLine[] = manual.lines ?? ex.lines ?? [];
    const invoiceNumber = String(manual.invoiceNumber ?? exField('invoiceNumber') ?? '').trim();
    const invoiceDateStr = manual.invoiceDate ?? exField('invoiceDate');
    if (!invoiceNumber || !invoiceDateStr) throw new BadRequestException('invoiceNumber and invoiceDate are required (scan a readable invoice or enter them)');
    const confidence = doc?.confidence !== null && doc?.confidence !== undefined ? Number(doc.confidence) : 1;

    const products = await this.loadProducts(rawLines, supplierId, input);
    const normalized = await this.normalizeInvoiceLines(rawLines, supplierId, products);
    const sumNet = normalized.reduce((s, l) => s.plus(l.net), d(0));
    const sumTax = normalized.reduce((s, l) => s.plus(l.tax), d(0));
    const subtotal = money(manual.subtotal ?? exField('subtotal') ?? sumNet);
    const taxTotal = money(manual.taxTotal ?? exField('taxTotal') ?? sumTax);
    const total = money(manual.total ?? exField('total') ?? subtotal.plus(taxTotal));
    const supplierTaxNumber = (manual.supplierTaxNumber ?? exField('supplierTaxNumber') ?? null) as string | null;
    const qrUuid = (manual.qrUuid ?? exField('qrUuid') ?? null) as string | null;

    // ---- physical receipt lines (base units) and PO lines
    const poLines = po ? await this.normalizePoLines(po.lines) : null;
    const received = await this.normalizeReceived(input.receivedLines, po?.lines ?? []);

    // ---- duplicate guard (PUR-03)
    const dupKey = createHash('sha256').update(`${supplierId}|${invoiceNumber.toUpperCase()}|${invoiceDateStr}|${total}`).digest('hex');
    const dup = await this.findDuplicate(supplierId, invoiceNumber, qrUuid);

    // ---- match (PUR-02)
    const result = threeWayMatch({
      supplierTaxNumberOnInvoice: supplierTaxNumber,
      supplierTaxNumberOnFile: supplier.taxNumber,
      invoice: {
        subtotal,
        taxTotal,
        total,
        lines: normalized.map<InvoiceLineN>((l) => ({ productId: l.productId, supplierSku: l.supplierSku, qtyBase: l.qtyBase, priceBase: l.priceBase, lineNet: l.net, lineTax: l.tax, expectedTax: l.expectedTax })),
      },
      po: poLines,
      received: received.map((r) => ({ productId: r.productId, qtyBase: r.qtyBase })),
      tolerances: TOLERANCES,
    });
    const findings: Finding[] = [...result.findings];
    if (dup) findings.unshift(finding('DUPLICATE_INVOICE', `Probable duplicate of invoice ${dup.invoiceNumber} (${dup.status})`, { existingInvoiceId: dup.id, existingStatus: dup.status }));

    // ---- persist receipt + invoice (nothing is posted yet)
    const costs = this.costPerProduct(normalized, products, poLines);
    const created = await this.persist({
      input, user, supplierId, branch, invoiceNumber, invoiceDate: dateOnly(String(invoiceDateStr)), subtotal, taxTotal, total, supplierTaxNumber, qrUuid, qrPayload: manual.qrPayload ?? ex.qrPayload ?? null,
      confidence, normalized, received, costs, dupKey, isDuplicate: !!dup, findings, po,
    });

    const wf = await this.workflow.start(WF01, 'SupplierInvoice', created.invoiceId, 'LOW');
    const hard = findings.filter((f) => f.severity === 'HARD');
    if (hard.length) {
      await this.openException(created, wf.id, findings, total, input.branchId, null);
      return { ...(await this.outcome(created.receiptId)), replay: false };
    }

    const decision = await this.policy.evaluate(POLICY, { amount: Number(total), variancePct: result.variancePct, confidence, branchId: input.branchId });
    if (decision.decision === 'AUTO') {
      await this.tryPost(created.receiptId, 'AUTO');
    } else {
      const ex2 = await this.openException(created, wf.id, findings, total, input.branchId, decision.decision === 'BLOCKED' ? 'FINANCE' : null, decision.reason);
      if (decision.decision !== 'BLOCKED') {
        await this.approvals.request({ subjectType: 'GoodsReceipt', subjectId: created.receiptId, action: VARIANCE_ACTION, approverRole: ex2.ownerRole!, amount: Number(total), exceptionId: ex2.id, branchId: input.branchId });
      }
    }
    return { ...(await this.outcome(created.receiptId)), replay: false };
  }

  private async persist(p: any) {
    const { input, user, supplierId, branch, po, normalized, received, costs } = p;
    const run = async (clearKeys: boolean) =>
      this.prisma.db.$transaction(async (tx) => {
        const invoice = await tx.supplierInvoice.create({
          data: {
            tenantId: '',
            supplierId,
            invoiceNumber: p.invoiceNumber,
            invoiceDate: p.invoiceDate,
            subtotal: p.subtotal,
            taxTotal: p.taxTotal,
            total: p.total,
            supplierTaxNumber: p.supplierTaxNumber,
            qrUuid: clearKeys ? null : p.qrUuid,
            qrPayload: p.qrPayload,
            purchaseOrderId: po?.id ?? null,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
            extractionConfidence: p.confidence,
            status: 'CAPTURED',
            findings: p.findings as any,
            duplicateKey: clearKeys ? null : p.dupKey,
            createdBy: user.id,
            lines: {
              create: normalized.map((l: any) => ({
                tenantId: currentTenantId(),
                supplierSku: l.supplierSku ?? null,
                description: l.description ?? null,
                productId: l.productId,
                qty: l.qty,
                unit: l.unit,
                unitPrice: l.unitPrice,
                taxRate: l.taxRate,
                lineNet: l.net,
                lineTax: l.tax,
              })),
            },
          },
        });
        const number = await this.sequences.next('GRN', 'GRN', tx);
        const receipt = await tx.goodsReceipt.create({
          data: {
            tenantId: '',
            number,
            purchaseOrderId: po?.id ?? null,
            supplierId,
            branchId: input.branchId,
            stockLocationId: input.stockLocationId,
            invoiceId: invoice.id,
            receivedBy: user.id,
            idempotencyKey: input.idempotencyKey,
            correlationId: currentContext()?.correlationId ?? input.idempotencyKey,
            createdBy: user.id,
            lines: {
              create: received.map((r: any) => {
                const cost = costs.get(r.productId) ?? d(0);
                return { tenantId: currentTenantId(), poLineId: r.poLineId ?? null, productId: r.productId, qtyReceived: r.qty, unit: r.unit, qtyBase: r.qtyBase, unitCost: cost, value: money(r.qtyBase.times(cost)) };
              }),
            },
          },
        });
        if (input.evidenceDocumentId) {
          await tx.evidenceDocument.updateMany({ where: { id: input.evidenceDocumentId }, data: { subjectType: 'SupplierInvoice', subjectId: invoice.id } });
        }
        await this.audit.record({ action: 'receipt.captured', entityType: 'GoodsReceipt', entityId: receipt.id, after: { number, invoiceNumber: p.invoiceNumber, total: p.total.toString(), findings: p.findings.map((f: Finding) => f.code) } }, tx);
        return { invoiceId: invoice.id, receiptId: receipt.id, receiptNumber: number, branchId: branch.id };
      });
    try {
      return await run(p.isDuplicate);
    } catch (e) {
      // Lost a race against an identical concurrent scan: the unique duplicate key caught it, so treat it as a duplicate.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && !p.isDuplicate) {
        p.findings.unshift(finding('DUPLICATE_INVOICE', 'Identical invoice was captured concurrently', {}));
        return run(true);
      }
      throw e;
    }
  }

  private async openException(created: { invoiceId: string; receiptId: string; receiptNumber: string }, workflowId: string, findings: Finding[], total: Decimal, branchId: string, forceOwner: string | null, policyReason?: string) {
    const hard = findings.filter((f) => f.severity === 'HARD');
    const primary = hard[0] ?? findings[0];
    const ownerRole = forceOwner ?? (hard.length ? hard.map((f) => f.ownerRole).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] : undefined);
    await this.prisma.db.supplierInvoice.updateMany({ where: { id: created.invoiceId }, data: { status: 'EXCEPTION', findings: findings as any } });
    await this.workflow.fire(workflowId, 'match_failed');
    const reason = [primary?.message, policyReason && !primary ? policyReason : null].filter(Boolean).join(' ') || policyReason || 'Needs review';
    return this.exceptions.raise({
      workflowId,
      code: `PUR_${primary?.code ?? 'POLICY_REVIEW'}`,
      reason: `Receipt ${created.receiptNumber}: ${reason}${findings.length > 1 ? ` (+${findings.length - 1} more)` : ''}`,
      evidence: { receiptId: created.receiptId, invoiceId: created.invoiceId, findings },
      impact: `Stock and payable of ${total} JOD are not posted until this is resolved`,
      amount: Number(total),
      riskTier: findings.some((f) => HIGH_RISK.has(f.code)) ? 'HIGH' : 'MEDIUM',
      branchId,
      ownerRole,
      policyKey: ownerRole ? undefined : POLICY,
      availableActions: hard.length ? ['override_post', 'reject'] : ['approve', 'reject'],
    });
  }

  // ================================================================ posting (PUR-04)

  private async tryPost(receiptId: string, mode: 'AUTO' | 'APPROVED' | 'OVERRIDE', actor?: RequestUser, reason?: string) {
    try {
      await this.postReceipt(receiptId, mode, reason);
    } catch (e) {
      if (!(e instanceof FinanceError)) throw e;
      const receipt = await this.prisma.db.goodsReceipt.findFirstOrThrow({ where: { id: receiptId } });
      await this.prisma.db.goodsReceipt.updateMany({ where: { id: receiptId }, data: { postingStatus: 'FAILED' } });
      const code = e.code === 'PERIOD_LOCKED' ? 'PERIOD_LOCKED' : 'MISSING_ACCOUNT';
      const f = finding(code, e.message);
      const wf = receipt.invoiceId ? await this.workflow.findBySubject(WF01, 'SupplierInvoice', receipt.invoiceId) : null;
      if (wf && wf.state === 'CAPTURED') await this.workflow.fire(wf.id, 'match_failed');
      if (receipt.invoiceId) await this.prisma.db.supplierInvoice.updateMany({ where: { id: receipt.invoiceId }, data: { status: 'EXCEPTION' } });
      await this.exceptions.raise({
        workflowId: wf?.id,
        code: `PUR_${code}`,
        reason: `Receipt ${receipt.number} cannot be posted: ${e.message}`,
        evidence: { receiptId, invoiceId: receipt.invoiceId, findings: [f] },
        impact: 'Stock and payable are not posted',
        branchId: receipt.branchId,
        ownerRole: 'FINANCE',
        riskTier: 'MEDIUM',
        availableActions: ['override_post', 'reject'],
      });
      return;
    }
    // Verified: the posted journal balances (enforced by the posting engine) and movements exist.
    await this.closeOpenExceptions(receiptId, mode === 'AUTO' ? null : reason ?? 'Posted');
  }

  private async closeOpenExceptions(receiptId: string, comment: string | null) {
    if (!comment) return;
    const receipt = await this.prisma.db.goodsReceipt.findFirst({ where: { id: receiptId } });
    if (!receipt?.invoiceId) return;
    const wf = await this.workflow.findBySubject(WF01, 'SupplierInvoice', receipt.invoiceId);
    if (!wf) return;
    const open = await this.prisma.db.exception.findMany({ where: { workflowId: wf.id, status: { in: ['NOTIFIED', 'APPROVED'] } } });
    for (const ex of open) {
      if (ex.status === 'NOTIFIED') await this.exceptions.transition(ex.id, 'RESOLVED', comment);
      await this.exceptions.transition(ex.id, 'EXECUTED', comment);
      await this.exceptions.transition(ex.id, 'VERIFIED', 'Journal balanced, stock movements recorded');
    }
  }

  async postReceipt(receiptId: string, mode: 'AUTO' | 'APPROVED' | 'OVERRIDE', reason?: string) {
    const result = await this.prisma.db.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.findFirst({ where: { id: receiptId }, include: { lines: true } });
      if (!receipt) throw new NotFoundException('Receipt not found');
      if (receipt.operationalStatus === 'CONFIRMED') return { receipt, newInvoiceId: null as string | null };
      if (receipt.operationalStatus === 'REJECTED') throw new ConflictException('Receipt was rejected');
      const invoice = await tx.supplierInvoice.findFirst({ where: { id: receipt.invoiceId ?? '' }, include: { lines: true } });
      if (!invoice) throw new BadRequestException('Receipt has no invoice');
      if (receipt.lines.some((l) => d(l.unitCost).isZero())) throw new BadRequestException('Some received lines have no price (unmapped or not on the invoice); fix the mapping and capture again');

      const branch = await tx.branch.findFirstOrThrow({ where: { id: receipt.branchId } });
      let inventoryTotal = d(0);
      for (const l of receipt.lines) {
        const m = await this.inventory.applyMovement(tx, {
          productId: l.productId,
          locationId: receipt.stockLocationId,
          type: 'RECEIPT',
          qtyBase: l.qtyBase,
          unitCost: d(l.unitCost),
          sourceType: 'GoodsReceipt',
          sourceId: receipt.id,
          idempotencyKey: `receipt:${receipt.id}:${l.id}`,
        });
        inventoryTotal = inventoryTotal.plus(m.valueDelta);
      }

      const products = await this.productMap(tx, invoice.lines.map((l) => l.productId));
      const eligibleOf = (pid: string | null) => (pid ? products.get(pid)?.taxCode?.eligibleDefault ?? true : true);
      const eligibleTax = invoice.lines.filter((l) => eligibleOf(l.productId)).reduce((s, l) => s.plus(l.lineTax), d(0));
      const variance = money(d(invoice.total).minus(inventoryTotal).minus(eligibleTax));

      const journal = await this.posting.post(
        {
          sourceType: 'GoodsReceipt',
          sourceId: receipt.id,
          idempotencyKey: `receipt:${receipt.id}`,
          postingDate: ammanToday(),
          memo: `Goods receipt ${receipt.number} / invoice ${invoice.invoiceNumber}`,
          legalEntityId: branch.legalEntityId,
          branchId: receipt.branchId,
          lines: [
            { account: 'INVENTORY', debit: inventoryTotal },
            { account: 'INPUT_TAX', debit: eligibleTax },
            { account: 'PURCHASE_VARIANCE', debit: variance.gt(0) ? variance : 0, credit: variance.isNegative() ? variance.abs() : 0 },
            { account: 'AP', credit: invoice.total },
          ],
        },
        tx,
      );

      // Tax evidence for the draft return (WF-07), one row per rate and eligibility.
      const byRate = new Map<string, { rate: Decimal; eligible: boolean; base: Decimal; tax: Decimal }>();
      for (const l of invoice.lines) {
        const eligible = eligibleOf(l.productId);
        const key = `${l.taxRate}|${eligible}`;
        const cur = byRate.get(key) ?? { rate: d(l.taxRate), eligible, base: d(0), tax: d(0) };
        byRate.set(key, { ...cur, base: cur.base.plus(l.lineNet), tax: cur.tax.plus(l.lineTax) });
      }
      for (const t of byRate.values()) {
        await tx.taxLedgerEntry.upsert({
          where: { tenantId_sourceType_sourceId_taxRate_direction_eligible: { tenantId: currentTenantId(), sourceType: 'SupplierInvoice', sourceId: invoice.id, taxRate: t.rate, direction: 'INPUT', eligible: t.eligible } },
          create: { tenantId: currentTenantId(), direction: 'INPUT', taxRate: t.rate, sourceType: 'SupplierInvoice', sourceId: invoice.id, documentDate: invoice.invoiceDate, base: money(t.base), taxAmount: money(t.tax), eligible: t.eligible, legalEntityId: branch.legalEntityId, journalId: journal.id },
          update: {},
        });
      }

      const supplier = await tx.supplier.findFirstOrThrow({ where: { id: invoice.supplierId } });
      await tx.payable.upsert({
        where: { invoiceId: invoice.id },
        create: { tenantId: currentTenantId(), supplierId: invoice.supplierId, invoiceId: invoice.id, legalEntityId: branch.legalEntityId, amountDue: invoice.total, dueDate: new Date(invoice.invoiceDate.getTime() + supplier.paymentTermsDays * 86_400_000) },
        update: {},
      });

      if (receipt.purchaseOrderId) await this.updatePurchaseOrder(tx, receipt.purchaseOrderId, receipt.lines);
      await tx.goodsReceipt.updateMany({ where: { id: receipt.id }, data: { operationalStatus: 'CONFIRMED', postingStatus: 'POSTED', journalId: journal.id } });
      await tx.supplierInvoice.updateMany({ where: { id: invoice.id }, data: { status: 'POSTED', journalId: journal.id } });
      await this.audit.record({ action: `receipt.posted.${mode.toLowerCase()}`, entityType: 'GoodsReceipt', entityId: receipt.id, actorType: mode === 'AUTO' ? 'SYSTEM' : undefined, after: { journal: journal.number, inventory: inventoryTotal.toString(), inputTax: eligibleTax.toString(), payable: invoice.total.toString(), reason } }, tx);
      return { receipt, newInvoiceId: invoice.id as string | null };
    });

    if (result.newInvoiceId) {
      const wf = await this.workflow.findBySubject(WF01, 'SupplierInvoice', result.newInvoiceId);
      if (wf && !wf.closed) await this.workflow.fire(wf.id, wf.state === 'EXCEPTION' ? 'approved' : 'match_passed');
    }
    return result.receipt;
  }

  private async updatePurchaseOrder(tx: any, poId: string, lines: { poLineId: string | null; productId: string; qtyBase: Prisma.Decimal }[]) {
    const poLines = await tx.purchaseOrderLine.findMany({ where: { orderId: poId } });
    for (const l of lines) {
      const pol = poLines.find((x: any) => x.id === l.poLineId) ?? poLines.find((x: any) => x.productId === l.productId);
      if (!pol) continue;
      const factor = await this.catalog.unitFactor(pol.productId, pol.unit, tx);
      await tx.purchaseOrderLine.updateMany({ where: { id: pol.id }, data: { qtyReceived: { increment: roundQty(d(l.qtyBase).div(factor)) } } });
    }
    const fresh = await tx.purchaseOrderLine.findMany({ where: { orderId: poId } });
    const done = fresh.every((x: any) => d(x.qtyReceived).gte(d(x.qty)));
    await tx.purchaseOrder.updateMany({ where: { id: poId }, data: { status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
  }

  // ================================================================ human resolution

  // Finance/owner accepts a hard finding. Stock posts at the physically received quantity; any difference to the
  // invoice total lands in purchase price variance, so books stay balanced and the override is fully audited.
  async overridePost(receiptId: string, reason: string, user: RequestUser) {
    const receipt = await this.prisma.db.goodsReceipt.findFirst({ where: { id: receiptId } });
    if (!receipt) throw new NotFoundException();
    if (receipt.operationalStatus !== 'PENDING_REVIEW') throw new ConflictException(`Receipt is ${receipt.operationalStatus}`);
    await this.audit.record({ action: 'receipt.override_requested', entityType: 'GoodsReceipt', entityId: receiptId, after: { reason, by: user.id } });
    await this.tryPost(receiptId, 'OVERRIDE', user, reason);
    return this.outcome(receiptId);
  }

  async reject(receiptId: string, reason: string) {
    const receipt = await this.prisma.db.goodsReceipt.findFirst({ where: { id: receiptId } });
    if (!receipt) throw new NotFoundException();
    if (receipt.operationalStatus !== 'PENDING_REVIEW') throw new ConflictException(`Receipt is ${receipt.operationalStatus}`);
    await this.prisma.db.goodsReceipt.updateMany({ where: { id: receiptId, operationalStatus: 'PENDING_REVIEW' }, data: { operationalStatus: 'REJECTED', postingStatus: 'NOT_REQUIRED' } });
    if (receipt.invoiceId) {
      // Releases the duplicate keys so a corrected invoice can be captured again.
      await this.prisma.db.supplierInvoice.updateMany({ where: { id: receipt.invoiceId }, data: { status: 'REJECTED', duplicateKey: null, qrUuid: null } });
      const wf = await this.workflow.findBySubject(WF01, 'SupplierInvoice', receipt.invoiceId);
      if (wf && !wf.closed && wf.state === 'EXCEPTION') await this.workflow.fire(wf.id, 'rejected');
      if (wf) {
        const open = await this.prisma.db.exception.findMany({ where: { workflowId: wf.id, status: 'NOTIFIED' } });
        for (const ex of open) {
          await this.exceptions.transition(ex.id, 'REJECTED', reason);
          await this.exceptions.transition(ex.id, 'ARCHIVED', reason);
        }
      }
      await this.prisma.db.approval.updateMany({ where: { subjectType: 'GoodsReceipt', subjectId: receiptId, status: 'PENDING' }, data: { status: 'REJECTED', comment: `Receipt rejected: ${reason}`, decidedAt: new Date() } });
    }
    await this.audit.record({ action: 'receipt.rejected', entityType: 'GoodsReceipt', entityId: receiptId, after: { reason } });
    return this.outcome(receiptId);
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== VARIANCE_ACTION) return;
    await runWithTenant(e.tenantId, async () => {
      if (e.approved) await this.tryPost(e.subjectId, 'APPROVED', undefined, 'Approved variance');
      else await this.reject(e.subjectId, 'Variance rejected by approver');
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  // ================================================================ reads

  async outcome(receiptId: string) {
    const receipt = await this.prisma.db.goodsReceipt.findFirst({ where: { id: receiptId }, include: { lines: true } });
    if (!receipt) throw new NotFoundException('Receipt not found');
    const invoice = receipt.invoiceId ? await this.prisma.db.supplierInvoice.findFirst({ where: { id: receipt.invoiceId }, include: { lines: true } }) : null;
    const wf = invoice ? await this.workflow.findBySubject(WF01, 'SupplierInvoice', invoice.id) : null;
    const exceptions = wf ? await this.prisma.db.exception.findMany({ where: { workflowId: wf.id }, orderBy: { createdAt: 'asc' } }) : [];
    return {
      outcome: receipt.operationalStatus === 'CONFIRMED' ? 'POSTED' : receipt.operationalStatus === 'REJECTED' ? 'REJECTED' : 'EXCEPTION',
      receipt,
      invoice,
      findings: (invoice?.findings ?? []) as unknown as Finding[],
      workflowState: wf?.state ?? null,
      exceptions,
    };
  }

  // Everything linked to one delivery: the evidence chain an auditor follows (AT-01).
  async trace(receiptId: string) {
    const o = await this.outcome(receiptId);
    const [movements, journal, payable, taxEntries, document, po] = await Promise.all([
      this.prisma.db.stockMovement.findMany({ where: { sourceType: 'GoodsReceipt', sourceId: receiptId } }),
      o.receipt.journalId ? this.prisma.db.journal.findFirst({ where: { id: o.receipt.journalId }, include: { lines: { include: { account: true } } } }) : null,
      o.invoice ? this.prisma.db.payable.findFirst({ where: { invoiceId: o.invoice.id } }) : null,
      o.invoice ? this.prisma.db.taxLedgerEntry.findMany({ where: { sourceType: 'SupplierInvoice', sourceId: o.invoice.id } }) : [],
      o.invoice?.evidenceDocumentId ? this.prisma.db.evidenceDocument.findFirst({ where: { id: o.invoice.evidenceDocumentId } }) : null,
      o.receipt.purchaseOrderId ? this.prisma.db.purchaseOrder.findFirst({ where: { id: o.receipt.purchaseOrderId }, include: { lines: true } }) : null,
    ]);
    return { ...o, purchaseOrder: po, document, movements, journal, payable, taxEntries };
  }

  list(status?: string) {
    return this.prisma.db.goodsReceipt.findMany({ where: { operationalStatus: status as any }, include: { lines: true, invoice: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  // ================================================================ normalization helpers

  private async findDuplicate(supplierId: string, invoiceNumber: string, qrUuid: string | null) {
    return this.prisma.db.supplierInvoice.findFirst({
      where: {
        status: { not: 'REJECTED' },
        OR: [{ supplierId, invoiceNumber: { equals: invoiceNumber, mode: 'insensitive' } }, ...(qrUuid ? [{ qrUuid }] : [])],
      },
    });
  }

  private async productMap(db: any, ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows: ProductWithTax[] = unique.length ? await db.product.findMany({ where: { id: { in: unique } }, include: { taxCode: true } }) : [];
    return new Map(rows.map((p) => [p.id, p]));
  }

  private async loadProducts(rawLines: RawInvoiceLine[], supplierId: string, input: ReceiveInput) {
    const ids: string[] = [];
    for (const l of rawLines) {
      if (l.productId) ids.push(l.productId);
      else if (l.supplierSku) {
        const m = await this.catalog.mapSupplierSku(supplierId, l.supplierSku);
        if (m) ids.push(m.productId);
      }
    }
    for (const r of input.receivedLines) if (r.productId) ids.push(r.productId);
    return this.productMap(this.prisma.db, ids);
  }

  private async normalizeInvoiceLines(rawLines: RawInvoiceLine[], supplierId: string, products: Map<string, ProductWithTax>) {
    const out = [];
    for (const l of rawLines) {
      let productId: string | null = l.productId ?? null;
      if (!productId && l.supplierSku) productId = (await this.catalog.mapSupplierSku(supplierId, l.supplierSku))?.productId ?? null;
      const product = productId ? products.get(productId) : undefined;
      let factor = d(1);
      let usableProductId = productId;
      if (productId) {
        try {
          factor = await this.catalog.unitFactor(productId, l.unit);
        } catch {
          usableProductId = null; // unknown unit: surfaces as an unmapped item for a human to fix
        }
      } else {
        usableProductId = null;
      }
      const net = money(l.lineNet ?? d(l.qty).times(l.unitPrice));
      const tax = money(l.lineTax ?? net.times(l.taxRate ?? 0));
      const effectiveRate = !net.isZero() ? rate(tax.div(net)).toDecimalPlaces(4) : d(l.taxRate ?? 0);
      out.push({
        supplierSku: l.supplierSku ?? null,
        description: l.description ?? null,
        productId: usableProductId,
        qty: roundQty(l.qty),
        unit: l.unit,
        unitPrice: d(l.unitPrice),
        taxRate: effectiveRate,
        net,
        tax,
        expectedTax: money(net.times(product?.taxCode?.rate ?? 0)),
        qtyBase: roundQty(d(l.qty).times(factor)),
        priceBase: rate(d(l.unitPrice).div(factor)),
      });
    }
    return out;
  }

  private async normalizePoLines(lines: { productId: string; qty: Prisma.Decimal; unit: string; unitPrice: Prisma.Decimal; qtyReceived: Prisma.Decimal }[]) {
    const out = [];
    for (const l of lines) {
      const f = await this.catalog.unitFactor(l.productId, l.unit);
      out.push({ productId: l.productId, orderedBase: roundQty(d(l.qty).times(f)), receivedBase: roundQty(d(l.qtyReceived).times(f)), priceBase: rate(d(l.unitPrice).div(f)) });
    }
    return { lines: out };
  }

  private async normalizeReceived(lines: ReceiveInput['receivedLines'], poLines: { id: string; productId: string; unit: string }[]) {
    const out = [];
    for (const r of lines) {
      const pol = r.poLineId ? poLines.find((p) => p.id === r.poLineId) : r.productId ? poLines.find((p) => p.productId === r.productId) : undefined;
      if (r.poLineId && !pol) throw new BadRequestException(`poLineId ${r.poLineId} is not on the purchase order`);
      const productId = pol?.productId ?? r.productId;
      if (!productId) throw new BadRequestException('Each received line needs poLineId or productId');
      const product = await this.prisma.db.product.findFirst({ where: { id: productId } });
      if (!product) throw new BadRequestException(`Unknown product ${productId}`);
      const unit = r.unit ?? pol?.unit ?? product.baseUnit;
      const factor = await this.catalog.unitFactor(productId, unit);
      out.push({ poLineId: pol?.id ?? null, productId, qty: roundQty(r.qty), unit, qtyBase: roundQty(d(r.qty).times(factor)) });
    }
    return out;
  }

  // Cost per base unit = invoice net plus any non-recoverable input tax, spread over invoiced quantity.
  // Falls back to the PO price for products that are received but not invoiced (those will raise a finding anyway).
  private costPerProduct(invoiceLines: { productId: string | null; net: Decimal; tax: Decimal; qtyBase: Decimal }[], products: Map<string, ProductWithTax>, po: { lines: { productId: string; priceBase: Decimal }[] } | null) {
    const agg = new Map<string, { cost: Decimal; qty: Decimal }>();
    for (const l of invoiceLines) {
      if (!l.productId) continue;
      const eligible = products.get(l.productId)?.taxCode?.eligibleDefault ?? true;
      const cur = agg.get(l.productId) ?? { cost: d(0), qty: d(0) };
      agg.set(l.productId, { cost: cur.cost.plus(l.net).plus(eligible ? 0 : l.tax), qty: cur.qty.plus(l.qtyBase) });
    }
    const out = new Map<string, Decimal>();
    for (const [pid, a] of agg) if (a.qty.gt(0)) out.set(pid, rate(a.cost.div(a.qty)));
    for (const l of po?.lines ?? []) if (!out.has(l.productId)) out.set(l.productId, l.priceBase);
    return out;
  }
}
