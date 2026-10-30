import { d } from '../../common/money';
import { buildTotals, LedgerEntryLike } from './tax-return-builder';

const e = (over: Partial<LedgerEntryLike>): LedgerEntryLike => ({ direction: 'OUTPUT', taxRate: d('0.16'), eligible: true, base: d(100), taxAmount: d(16), sourceId: 'a', ...over });

describe('tax return totals', () => {
  it('nets credit notes against sales and recoverable input tax against output tax', () => {
    const t = buildTotals([
      e({ sourceId: 's1', base: d(1000), taxAmount: d(160) }),
      e({ sourceId: 's2', base: d(500), taxAmount: d(80) }),
      e({ sourceId: 'cn1', base: d(-100), taxAmount: d(-16) }), // credit note
      e({ direction: 'INPUT', sourceId: 'p1', base: d(400), taxAmount: d(64) }),
      e({ direction: 'INPUT', sourceId: 'p2', base: d(50), taxAmount: d(8), eligible: false }),
    ]);
    expect(t.outputBase).toEqual(d(1400));
    expect(t.outputTax).toEqual(d(224));
    expect(t.inputTaxRecoverable).toEqual(d(64));
    expect(t.inputTaxNonRecoverable).toEqual(d(8));
    expect(t.netPayable).toEqual(d(160));
  });

  it('groups by rate and eligibility and counts distinct documents', () => {
    const t = buildTotals([e({ sourceId: 's1' }), e({ sourceId: 's1', taxRate: d(0), base: d(10), taxAmount: d(0) }), e({ sourceId: 's2' })]);
    expect(t.lines.map((l) => [String(l.taxRate), l.documents])).toEqual([['0', 1], ['0.16', 2]]);
  });

  it('reports a credit position when recoverable input exceeds output', () => {
    expect(buildTotals([e({ taxAmount: d(10), base: d(62.5) }), e({ direction: 'INPUT', sourceId: 'p', taxAmount: d(30), base: d(187.5) })]).netPayable).toEqual(d(-20));
  });

  it('is empty-safe', () => {
    expect(buildTotals([]).netPayable).toEqual(d(0));
  });
});
