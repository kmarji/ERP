import { d } from '../../common/money';
import { InvoiceLineN, MatchInput, threeWayMatch } from './three-way-match';

const line = (over: Partial<InvoiceLineN> = {}): InvoiceLineN => ({
  productId: 'p1',
  supplierSku: 'S1',
  qtyBase: d(10),
  priceBase: d(2),
  lineNet: d(20),
  lineTax: d(3.2),
  expectedTax: d(3.2),
  ...over,
});

const base = (over: Partial<MatchInput> = {}): MatchInput => ({
  supplierTaxNumberOnInvoice: 'T1',
  supplierTaxNumberOnFile: 'T1',
  invoice: { subtotal: d(20), taxTotal: d(3.2), total: d(23.2), lines: [line()] },
  po: { lines: [{ productId: 'p1', orderedBase: d(10), receivedBase: d(0), priceBase: d(2) }] },
  received: [{ productId: 'p1', qtyBase: d(10) }],
  tolerances: { totalAbs: 0.01, taxAbs: 0.05 },
  ...over,
});

const codes = (i: MatchInput) => threeWayMatch(i).findings.map((f) => f.code);

describe('three-way match', () => {
  it('passes an exact match with no findings', () => {
    expect(threeWayMatch(base())).toEqual({ findings: [], variancePct: 0 });
  });

  it('flags a price increase as a soft finding with its percentage', () => {
    const i = base({ invoice: { subtotal: d(21), taxTotal: d(3.36), total: d(24.36), lines: [line({ priceBase: d(2.1), lineNet: d(21), lineTax: d(3.36), expectedTax: d(3.36) })] } });
    const r = threeWayMatch(i);
    expect(r.findings.map((f) => [f.code, f.severity])).toEqual([['PRICE_VARIANCE', 'SOFT']]);
    expect(r.variancePct).toBeCloseTo(5);
  });

  it('ignores a price decrease', () => {
    const i = base({ invoice: { subtotal: d(19), taxTotal: d(3.04), total: d(22.04), lines: [line({ priceBase: d(1.9), lineNet: d(19), lineTax: d(3.04), expectedTax: d(3.04) })] } });
    expect(codes(i)).toEqual([]);
  });

  it('blocks a short delivery (invoice is not proof of delivery)', () => {
    const r = threeWayMatch(base({ received: [{ productId: 'p1', qtyBase: d(8) }] }));
    expect(r.findings.map((f) => f.code)).toEqual(['QTY_MISMATCH']);
    expect(r.findings[0].severity).toBe('HARD');
    expect(r.findings[0].ownerRole).toBe('BRANCH_MANAGER');
  });

  it('flags over-delivery against the remaining PO quantity', () => {
    const i = base({
      invoice: { subtotal: d(24), taxTotal: d(3.84), total: d(27.84), lines: [line({ qtyBase: d(12), lineNet: d(24), lineTax: d(3.84), expectedTax: d(3.84) })] },
      received: [{ productId: 'p1', qtyBase: d(12) }],
    });
    const r = threeWayMatch(i);
    expect(r.findings.map((f) => f.code)).toEqual(['OVER_DELIVERY']);
    expect(r.variancePct).toBeCloseTo(20);
  });

  it('takes earlier partial receipts into account', () => {
    const i = base({ po: { lines: [{ productId: 'p1', orderedBase: d(15), receivedBase: d(5), priceBase: d(2) }] } });
    expect(codes(i)).toEqual([]);
    const over = base({ po: { lines: [{ productId: 'p1', orderedBase: d(15), receivedBase: d(8), priceBase: d(2) }] } });
    expect(codes(over)).toEqual(['OVER_DELIVERY']);
  });

  it('flags a wrong tax rate even when the invoice is internally consistent', () => {
    const i = base({ invoice: { subtotal: d(20), taxTotal: d(2), total: d(22), lines: [line({ lineTax: d(2) })] } });
    expect(codes(i)).toEqual(['TAX_DISCREPANCY']);
  });

  it('flags inconsistent invoice arithmetic', () => {
    const i = base({ invoice: { subtotal: d(20), taxTotal: d(3.2), total: d(30), lines: [line()] } });
    expect(codes(i)).toContain('INVOICE_TOTAL_INCONSISTENT');
  });

  it('flags missing PO, unmapped items, foreign products and supplier identity', () => {
    expect(codes(base({ po: null }))).toEqual(['NO_PO']);
    expect(codes(base({ invoice: { subtotal: d(20), taxTotal: d(3.2), total: d(23.2), lines: [line({ productId: null })] }, received: [] }))).toContain('UNMAPPED_ITEM');
    expect(codes(base({ po: { lines: [{ productId: 'other', orderedBase: d(10), receivedBase: d(0), priceBase: d(2) }] } }))).toContain('PRODUCT_NOT_ON_PO');
    expect(codes(base({ supplierTaxNumberOnInvoice: 'T9' }))).toEqual(['SUPPLIER_MISMATCH']);
  });

  it('reports only the unmapped item, not derivative quantity or tax findings', () => {
    const i = base({ invoice: { subtotal: d(20), taxTotal: d(3.2), total: d(23.2), lines: [line({ productId: null, expectedTax: d(0) })] } });
    expect(codes(i)).toEqual(['UNMAPPED_ITEM']);
  });

  it('requires line items when only totals are available (QR without lines)', () => {
    const i = base({ invoice: { subtotal: d(20), taxTotal: d(3.2), total: d(23.2), lines: [] } });
    expect(codes(i)).toEqual(['NO_LINE_ITEMS']);
  });
});
