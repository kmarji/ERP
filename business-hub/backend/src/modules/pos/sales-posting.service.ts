import { Injectable, Logger } from '@nestjs/common';
import { Decimal, d, money } from '../../common/money';
import { currentTenantId } from '../../common/tenancy/tenant-context';
import { PrismaService, ScopedTx } from '../../common/prisma/prisma.service';
import { ammanToday } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { InventoryService } from '../inventory/inventory.service';
import { MenuService } from '../menu/menu.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { lineAmounts } from './pos-math';

export class PostingFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Where each payment method lands in the ledger until it is settled or handed over.
export const TENDER_ACCOUNT: Record<string, string> = { CASH: 'CASH', CARD: 'CARD_CLEARING', DIGITAL: 'CARD_CLEARING', GIFT_CARD: 'GIFT_CARD', MARKETPLACE: 'MARKETPLACE_CLEARING' };

@Injectable()
export class SalesPostingService {
  private readonly log = new Logger(SalesPostingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: FinancePostingService,
    private readonly inventory: InventoryService,
    private readonly menu: MenuService,
    private readonly audit: AuditService,
    private readonly exceptions: ExceptionService,
  ) {}

  async salesLocation(tx: ScopedTx, branchId: string) {
    const flagged = await tx.stockLocation.findFirst({ where: { branchId, isSalesLocation: true } });
    const loc = flagged ?? (await tx.stockLocation.findFirst({ where: { branchId }, orderBy: { code: 'asc' } }));
    if (!loc) throw new PostingFailure('NO_SALES_LOCATION', 'The branch has no stock location to consume sold ingredients from');
    return loc;
  }

  // Posts revenue, tax, tender and cost-of-sales records for a completed order, exactly once.
  // Financial posting is its own track: failures never undo the sale, they raise a retriable exception.
  async postSale(orderId: string): Promise<{ posted: boolean }> {
    try {
      await this.prisma.db.$transaction((tx) => this.postSaleTx(tx, orderId));
      return { posted: true };
    } catch (e) {
      if (!(e instanceof FinanceError) && !(e instanceof PostingFailure)) throw e;
      const order = await this.prisma.db.order.findFirstOrThrow({ where: { id: orderId } });
      await this.prisma.db.order.updateMany({ where: { id: orderId, postingStatus: { not: 'POSTED' } }, data: { postingStatus: 'FAILED' } });
      const open = await this.prisma.db.exception.findMany({ where: { code: 'POS_POSTING_FAILED', status: 'NOTIFIED' } });
      if (!open.some((x) => (x.evidence as any)?.orderId === orderId)) {
        await this.exceptions.raise({
          code: 'POS_POSTING_FAILED',
          reason: `Order ${order.number} was completed but could not be posted to the ledger: ${e.message}`,
          evidence: { orderId, error: e.message },
          impact: 'Sale, tax and stock consumption are not yet in the books; the customer was served and paid',
          amount: Number(order.total),
          branchId: order.branchId,
          ownerRole: 'FINANCE',
          riskTier: 'MEDIUM',
          availableActions: ['resolve'],
        });
      }
      this.log.warn(`sale posting failed for ${order.number}: ${e.message}\n${e.stack}`);
      return { posted: false };
    }
  }

  private async postSaleTx(tx: ScopedTx, orderId: string) {
    const order = await tx.order.findFirst({ where: { id: orderId }, include: { lines: true, tenders: true } });
    if (!order) throw new PostingFailure('NO_ORDER', 'Order not found');
    if (order.postingStatus === 'POSTED') return;
    if (order.status !== 'COMPLETED') throw new PostingFailure('NOT_COMPLETED', 'Only completed orders are posted');
    const branch = await tx.branch.findFirstOrThrow({ where: { id: order.branchId } });
    const active = order.lines.filter((l) => !l.voided);

    let tax = d(0);
    let salesEx = d(0);
    let discountEx = d(0);
    for (const l of active) {
      const a = lineAmounts(l.qty, d(l.unitPrice), d(l.taxRate), d(l.discount));
      tax = tax.plus(a.tax);
      salesEx = salesEx.plus(a.net).plus(a.discountEx);
      discountEx = discountEx.plus(a.discountEx);
    }
    const byAccount = new Map<string, Decimal>();
    for (const t of order.tenders.filter((x) => x.status === 'CAPTURED')) {
      const acct = TENDER_ACCOUNT[t.method];
      byAccount.set(acct, (byAccount.get(acct) ?? d(0)).plus(t.amount));
    }
    const paid = [...byAccount.values()].reduce((s, v) => s.plus(v), d(0));
    if (!paid.equals(order.total)) throw new PostingFailure('TENDER_MISMATCH', `Captured tenders ${paid} do not equal the order total ${order.total}`);

    let saleJournalId: string | null = null;
    if (!order.total.isZero() || !discountEx.isZero()) {
      const journal = await this.posting.post(
        {
          sourceType: 'Order',
          sourceId: order.id,
          idempotencyKey: `sale:${order.id}`,
          postingDate: ammanToday(order.completedAt ?? new Date()),
          memo: `Sale ${order.number}`,
          legalEntityId: branch.legalEntityId,
          branchId: branch.id,
          lines: [
            ...[...byAccount].map(([account, debit]) => ({ account, debit })),
            { account: 'SALES_DISCOUNTS', debit: discountEx },
            { account: 'SALES', credit: salesEx },
            { account: 'OUTPUT_TAX', credit: tax },
          ],
        },
        tx,
      );
      saleJournalId = journal.id;
      await tx.order.updateMany({ where: { id: order.id }, data: { journalId: journal.id } });
    }

    // Output-tax evidence for the return (WF-07), one row per rate, from the same figures that were just journaled.
    const outByRate = new Map<string, { rate: Decimal; base: Decimal; tax: Decimal }>();
    for (const l of active) {
      const a = lineAmounts(l.qty, d(l.unitPrice), d(l.taxRate), d(l.discount));
      const k = d(l.taxRate).toString();
      const cur = outByRate.get(k) ?? { rate: d(l.taxRate), base: d(0), tax: d(0) };
      outByRate.set(k, { ...cur, base: cur.base.plus(a.net), tax: cur.tax.plus(a.tax) });
    }
    for (const t of outByRate.values()) {
      await tx.taxLedgerEntry.upsert({
        where: { tenantId_sourceType_sourceId_taxRate_direction_eligible: { tenantId: currentTenantId(), sourceType: 'Order', sourceId: order.id, taxRate: t.rate, direction: 'OUTPUT', eligible: true } },
        create: { tenantId: currentTenantId(), direction: 'OUTPUT', taxRate: t.rate, sourceType: 'Order', sourceId: order.id, documentDate: ammanToday(order.completedAt ?? new Date()), base: money(t.base), taxAmount: money(t.tax), eligible: true, legalEntityId: branch.legalEntityId, journalId: saleJournalId },
        update: {},
      });
    }

    // Theoretical consumption from recipes. Wastage and counts stay separate movement types.
    const consumed = new Map<string, Decimal>();
    for (const l of active) {
      const mods = ((l.modifiers as any[]) ?? []).map((m) => m.id as string);
      const parts = await this.menu.consumptionFor({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: mods, qty: l.qty });
      for (const p of parts) consumed.set(p.productId, (consumed.get(p.productId) ?? d(0)).plus(p.qtyBase));
    }
    let cogs = d(0);
    if (consumed.size) {
      const loc = await this.salesLocation(tx, order.branchId);
      for (const [productId, qty] of consumed) {
        const m = await this.inventory.applyMovement(tx, { productId, locationId: loc.id, type: 'SALE_CONSUMPTION', qtyBase: qty.negated(), sourceType: 'Order', sourceId: order.id, idempotencyKey: `sale:${order.id}:${productId}` });
        cogs = cogs.plus(d(m.valueDelta).abs());
      }
    }
    let cogsJournalId: string | null = null;
    if (cogs.gt(0)) {
      const cj = await this.posting.post(
        {
          sourceType: 'Order',
          sourceId: order.id,
          idempotencyKey: `sale:${order.id}:cogs`,
          postingDate: ammanToday(order.completedAt ?? new Date()),
          memo: `Cost of sales ${order.number}`,
          legalEntityId: branch.legalEntityId,
          branchId: branch.id,
          lines: [{ account: 'COGS', debit: cogs }, { account: 'INVENTORY', credit: cogs }],
        },
        tx,
      );
      cogsJournalId = cj.id;
    }
    await tx.order.updateMany({ where: { id: order.id }, data: { postingStatus: 'POSTED', cogsJournalId } });
    await this.audit.record({ action: 'sale.posted', entityType: 'Order', entityId: order.id, actorType: 'SYSTEM', after: { number: order.number, total: order.total.toString(), tax: tax.toString(), cogs: cogs.toString() } }, tx);
  }

  // ---------------------------------------------------------------- refunds

  async postRefund(refundId: string): Promise<{ posted: boolean }> {
    try {
      await this.prisma.db.$transaction((tx) => this.postRefundTx(tx, refundId));
      return { posted: true };
    } catch (e) {
      if (!(e instanceof FinanceError) && !(e instanceof PostingFailure)) throw e;
      const refund = await this.prisma.db.refund.findFirstOrThrow({ where: { id: refundId }, include: { order: true } });
      await this.prisma.db.refund.updateMany({ where: { id: refundId, postingStatus: { not: 'POSTED' } }, data: { postingStatus: 'FAILED' } });
      await this.exceptions.raise({
        code: 'POS_REFUND_POSTING_FAILED',
        reason: `Refund ${refund.number} was paid out but could not be posted to the ledger: ${e.message}`,
        evidence: { refundId, orderId: refund.orderId, error: e.message },
        amount: Number(refund.total),
        branchId: refund.order.branchId,
        ownerRole: 'FINANCE',
        riskTier: 'MEDIUM',
        availableActions: ['resolve'],
      });
      return { posted: false };
    }
  }

  private async postRefundTx(tx: ScopedTx, refundId: string) {
    const refund = await tx.refund.findFirst({ where: { id: refundId }, include: { lines: true, order: { include: { lines: true } } } });
    if (!refund) throw new PostingFailure('NO_REFUND', 'Refund not found');
    if (refund.postingStatus === 'POSTED') return;
    const order = refund.order;
    const branch = await tx.branch.findFirstOrThrow({ where: { id: order.branchId } });
    const base = { sourceType: 'Refund', sourceId: refund.id, postingDate: ammanToday(), legalEntityId: branch.legalEntityId, branchId: branch.id };

    const journal = await this.posting.post(
      {
        ...base,
        idempotencyKey: `refund:${refund.id}`,
        memo: `Credit note ${refund.number} for ${order.number}`,
        lines: [{ account: 'SALES', debit: refund.net }, { account: 'OUTPUT_TAX', debit: refund.tax }, { account: TENDER_ACCOUNT[refund.method], credit: refund.total }],
      },
      tx,
    );

    // A credit note reduces output tax in the period it is issued (negative evidence rows, never edits to the original).
    const creditByRate = new Map<string, { rate: Decimal; base: Decimal; tax: Decimal }>();
    for (const rl of refund.lines) {
      const line = order.lines.find((l) => l.id === rl.orderLineId)!;
      const k = d(line.taxRate).toString();
      const cur = creditByRate.get(k) ?? { rate: d(line.taxRate), base: d(0), tax: d(0) };
      creditByRate.set(k, { ...cur, base: cur.base.plus(rl.net), tax: cur.tax.plus(rl.tax) });
    }
    for (const t of creditByRate.values()) {
      await tx.taxLedgerEntry.upsert({
        where: { tenantId_sourceType_sourceId_taxRate_direction_eligible: { tenantId: currentTenantId(), sourceType: 'Refund', sourceId: refund.id, taxRate: t.rate, direction: 'OUTPUT', eligible: true } },
        create: { tenantId: currentTenantId(), direction: 'OUTPUT', taxRate: t.rate, sourceType: 'Refund', sourceId: refund.id, documentDate: ammanToday(), base: money(t.base).negated(), taxAmount: money(t.tax).negated(), eligible: true, legalEntityId: branch.legalEntityId, journalId: journal.id },
        update: {},
      });
    }

    // Restocking returns ingredients at the cost they were originally consumed at; otherwise the item was wasted.
    let restockValue = d(0);
    if (refund.restock) {
      const returned = new Map<string, Decimal>();
      for (const rl of refund.lines) {
        const line = order.lines.find((l) => l.id === rl.orderLineId)!;
        const mods = ((line.modifiers as any[]) ?? []).map((m) => m.id as string);
        for (const p of await this.menu.consumptionFor({ menuItemId: line.menuItemId, variantId: line.variantId, modifierIds: mods, qty: rl.qty })) {
          returned.set(p.productId, (returned.get(p.productId) ?? d(0)).plus(p.qtyBase));
        }
      }
      if (returned.size) {
        const loc = await this.salesLocation(tx, order.branchId);
        for (const [productId, qty] of returned) {
          const original = await tx.stockMovement.findFirst({ where: { idempotencyKey: `sale:${order.id}:${productId}` } });
          if (!original) continue; // nothing was consumed for this sale, so there is nothing to return
          const m = await this.inventory.applyMovement(tx, { productId, locationId: loc.id, type: 'SALE_RETURN', qtyBase: qty, unitCost: d(original.unitCost), sourceType: 'Refund', sourceId: refund.id, idempotencyKey: `refund:${refund.id}:${productId}` });
          restockValue = restockValue.plus(m.valueDelta);
        }
      }
      if (restockValue.gt(0)) {
        await this.posting.post(
          { ...base, idempotencyKey: `refund:${refund.id}:cogs`, memo: `Restock for credit note ${refund.number}`, lines: [{ account: 'INVENTORY', debit: restockValue }, { account: 'COGS', credit: restockValue }] },
          tx,
        );
      }
    }
    await tx.refund.updateMany({ where: { id: refund.id }, data: { postingStatus: 'POSTED', journalId: journal.id } });
    await this.audit.record({ action: 'refund.posted', entityType: 'Refund', entityId: refund.id, actorType: 'SYSTEM', after: { number: refund.number, total: refund.total.toString(), restockValue: restockValue.toString() } }, tx);
  }

  // Finance retry after fixing the cause (e.g. unlocking a period or mapping an account).
  async repostSale(orderId: string) {
    return this.postSale(orderId);
  }
}
