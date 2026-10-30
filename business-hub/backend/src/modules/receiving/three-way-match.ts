import { Decimal, d, money } from '../../common/money';

export type FindingCode =
  | 'DUPLICATE_INVOICE'
  | 'SUPPLIER_MISMATCH'
  | 'NO_PO'
  | 'NO_LINE_ITEMS'
  | 'UNMAPPED_ITEM'
  | 'PRODUCT_NOT_ON_PO'
  | 'QTY_MISMATCH'
  | 'INVOICE_TOTAL_INCONSISTENT'
  | 'TAX_DISCREPANCY'
  | 'PRICE_VARIANCE'
  | 'OVER_DELIVERY'
  | 'PERIOD_LOCKED'
  | 'MISSING_ACCOUNT';

// HARD findings can never auto-post (identity, evidence or arithmetic problems that need a human fix).
// SOFT findings are variances a policy tolerance may accept.
export interface Finding {
  code: FindingCode;
  severity: 'HARD' | 'SOFT';
  message: string;
  ownerRole: 'PROCUREMENT' | 'BRANCH_MANAGER' | 'FINANCE';
  details?: Record<string, unknown>;
}

export const FINDING_OWNER: Record<FindingCode, Finding['ownerRole']> = {
  DUPLICATE_INVOICE: 'FINANCE',
  SUPPLIER_MISMATCH: 'FINANCE',
  NO_PO: 'PROCUREMENT',
  NO_LINE_ITEMS: 'PROCUREMENT',
  UNMAPPED_ITEM: 'PROCUREMENT',
  PRODUCT_NOT_ON_PO: 'PROCUREMENT',
  QTY_MISMATCH: 'BRANCH_MANAGER',
  INVOICE_TOTAL_INCONSISTENT: 'FINANCE',
  TAX_DISCREPANCY: 'FINANCE',
  PRICE_VARIANCE: 'PROCUREMENT',
  OVER_DELIVERY: 'PROCUREMENT',
  PERIOD_LOCKED: 'FINANCE',
  MISSING_ACCOUNT: 'FINANCE',
};

const SEVERITY: Record<FindingCode, Finding['severity']> = {
  DUPLICATE_INVOICE: 'HARD',
  SUPPLIER_MISMATCH: 'HARD',
  NO_PO: 'HARD',
  NO_LINE_ITEMS: 'HARD',
  UNMAPPED_ITEM: 'HARD',
  PRODUCT_NOT_ON_PO: 'HARD',
  QTY_MISMATCH: 'HARD',
  INVOICE_TOTAL_INCONSISTENT: 'HARD',
  TAX_DISCREPANCY: 'HARD',
  PRICE_VARIANCE: 'SOFT',
  OVER_DELIVERY: 'SOFT',
  PERIOD_LOCKED: 'HARD',
  MISSING_ACCOUNT: 'HARD',
};

export const finding = (code: FindingCode, message: string, details?: Record<string, unknown>): Finding => ({
  code,
  severity: SEVERITY[code],
  message,
  ownerRole: FINDING_OWNER[code],
  details,
});

// All quantities are in each product's base unit and prices are per base unit, so units never leak into the maths.
export interface InvoiceLineN {
  productId: string | null;
  supplierSku?: string | null;
  qtyBase: Decimal;
  priceBase: Decimal;
  lineNet: Decimal;
  lineTax: Decimal;
  expectedTax: Decimal; // from the product's own tax code, not from what the invoice claims
}

export interface MatchInput {
  supplierTaxNumberOnInvoice: string | null;
  supplierTaxNumberOnFile: string | null;
  invoice: { subtotal: Decimal; taxTotal: Decimal; total: Decimal; lines: InvoiceLineN[] };
  po: { lines: { productId: string; orderedBase: Decimal; receivedBase: Decimal; priceBase: Decimal }[] } | null;
  received: { productId: string; qtyBase: Decimal }[];
  tolerances: { totalAbs: number; taxAbs: number };
}

export interface MatchResult {
  findings: Finding[];
  // Largest price increase or over-delivery, in percent: the value fed to the policy's maxVariancePct.
  variancePct: number;
}

export function threeWayMatch(i: MatchInput): MatchResult {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  if (i.supplierTaxNumberOnInvoice && i.supplierTaxNumberOnFile && i.supplierTaxNumberOnInvoice.trim() !== i.supplierTaxNumberOnFile.trim()) {
    add(finding('SUPPLIER_MISMATCH', `Invoice tax number ${i.supplierTaxNumberOnInvoice} does not match supplier on file ${i.supplierTaxNumberOnFile}`));
  }
  if (!i.po) add(finding('NO_PO', 'No purchase order is linked to this delivery'));
  if (i.invoice.lines.length === 0) {
    add(finding('NO_LINE_ITEMS', 'Invoice has no line items (a QR code alone may not carry them); enter or scan the lines'));
    return { findings, variancePct: 0 };
  }

  const unmapped = i.invoice.lines.filter((l) => !l.productId);
  for (const l of unmapped) add(finding('UNMAPPED_ITEM', `Supplier item ${l.supplierSku ?? '(no sku)'} is not mapped to a product`, { supplierSku: l.supplierSku }));

  // Invoice arithmetic must be internally consistent before anything else can be trusted.
  const sumNet = i.invoice.lines.reduce((s, l) => s.plus(l.lineNet), d(0));
  const sumTax = i.invoice.lines.reduce((s, l) => s.plus(l.lineTax), d(0));
  if (sumNet.minus(i.invoice.subtotal).abs().gt(i.tolerances.totalAbs) || i.invoice.subtotal.plus(i.invoice.taxTotal).minus(i.invoice.total).abs().gt(i.tolerances.totalAbs) || sumTax.minus(i.invoice.taxTotal).abs().gt(i.tolerances.totalAbs)) {
    add(finding('INVOICE_TOTAL_INCONSISTENT', `Invoice totals do not add up (lines ${money(sumNet)} + tax ${money(sumTax)} vs header ${i.invoice.subtotal} + ${i.invoice.taxTotal} = ${i.invoice.total})`));
  }

  // Line-level comparisons are meaningless until every item is mapped; report only what must be fixed first.
  if (unmapped.length) return { findings, variancePct: 0 };

  const expectedTax = i.invoice.lines.reduce((s, l) => s.plus(l.expectedTax), d(0));
  if (expectedTax.minus(i.invoice.taxTotal).abs().gt(i.tolerances.taxAbs)) {
    add(finding('TAX_DISCREPANCY', `Invoice tax ${i.invoice.taxTotal} differs from expected ${money(expectedTax)} for the products' tax codes`, { invoiceTax: i.invoice.taxTotal.toString(), expectedTax: money(expectedTax).toString() }));
  }

  // Physical receipt vs invoice, per product: an invoice alone is never proof of delivery.
  const invQty = new Map<string, Decimal>();
  for (const l of i.invoice.lines) if (l.productId) invQty.set(l.productId, (invQty.get(l.productId) ?? d(0)).plus(l.qtyBase));
  const recQty = new Map<string, Decimal>();
  for (const r of i.received) recQty.set(r.productId, (recQty.get(r.productId) ?? d(0)).plus(r.qtyBase));
  for (const pid of new Set([...invQty.keys(), ...recQty.keys()])) {
    const inv = invQty.get(pid) ?? d(0);
    const rec = recQty.get(pid) ?? d(0);
    if (!inv.equals(rec)) {
      add(finding('QTY_MISMATCH', rec.lt(inv) ? `Short delivery: invoiced ${inv}, physically received ${rec}` : `Received ${rec} but only ${inv} invoiced`, { productId: pid, invoiced: inv.toString(), received: rec.toString() }));
    }
  }

  let variancePct = 0;
  if (i.po) {
    const poByProduct = new Map(i.po.lines.map((l) => [l.productId, l]));
    for (const pid of new Set([...invQty.keys(), ...recQty.keys()])) {
      const pol = poByProduct.get(pid);
      if (!pol) {
        add(finding('PRODUCT_NOT_ON_PO', `Product ${pid} is not on the purchase order`, { productId: pid }));
        continue;
      }
      const rec = recQty.get(pid) ?? d(0);
      const remaining = pol.orderedBase.minus(pol.receivedBase);
      if (rec.gt(remaining)) {
        const overPct = remaining.isZero() ? 100 : rec.minus(remaining).div(remaining).times(100).toNumber();
        variancePct = Math.max(variancePct, overPct);
        add(finding('OVER_DELIVERY', `Received ${rec} exceeds the remaining ordered quantity ${remaining}`, { productId: pid, overPct }));
      }
    }
    for (const l of i.invoice.lines) {
      const pol = l.productId ? poByProduct.get(l.productId) : undefined;
      if (!pol || pol.priceBase.isZero()) continue;
      const pct = l.priceBase.minus(pol.priceBase).div(pol.priceBase).times(100).toNumber();
      // Only increases are exceptions; a cheaper invoice never blocks receiving.
      if (pct > 0) {
        variancePct = Math.max(variancePct, pct);
        add(finding('PRICE_VARIANCE', `Invoice price is ${pct.toFixed(2)}% above the PO price`, { productId: l.productId, poPrice: pol.priceBase.toString(), invoicePrice: l.priceBase.toString(), pct }));
      }
    }
  }
  return { findings, variancePct: Number(variancePct.toFixed(4)) };
}
