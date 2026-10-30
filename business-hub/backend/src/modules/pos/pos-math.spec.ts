import { d } from '../../common/money';
import { allocateDiscount, lineAmounts, proportion, resolveDiscounts, taxPart } from './pos-math';

describe('POS maths (tax-inclusive prices)', () => {
  it('splits a 16% inclusive price into net and tax', () => {
    const l = lineAmounts(2, d('3.480'), d('0.16'));
    expect(l).toMatchObject({ gross: d('6.96'), total: d('6.96'), tax: d('0.96'), net: d('6') });
  });

  it('computes tax on the discounted amount and the ex-tax discount', () => {
    const l = lineAmounts(1, d('11.600'), d('0.16'), d('1.160'));
    expect(l.total).toEqual(d('10.44'));
    expect(l.tax).toEqual(d('1.44'));
    expect(l.net).toEqual(d('9'));
    expect(l.discountEx).toEqual(d('1')); // 10 net before discount, 9 after
  });

  it('never discounts below zero', () => {
    expect(lineAmounts(1, d(5), d(0), d(9)).total).toEqual(d(0));
  });

  it('allocates an order discount exactly across lines', () => {
    const parts = allocateDiscount([d('10'), d('10'), d('10')], d('1'));
    expect(parts.reduce((s, p) => s.plus(p), d(0))).toEqual(d('1'));
    expect(allocateDiscount([d('4'), d('6')], d('1')).map(String)).toEqual(['0.4', '0.6']);
    expect(allocateDiscount([d('4')], d('9')).map(String)).toEqual(['4']); // capped at gross
  });

  it('resolves stacked discounts without exceeding the gross', () => {
    const r = resolveDiscounts(d('20'), [{ kind: 'PERCENT', value: 10 }, { kind: 'AMOUNT', value: 5 }, { kind: 'VOUCHER', value: 0, amount: 100 }]);
    expect(r.amounts.map(String)).toEqual(['2', '5', '13']);
    expect(r.total).toEqual(d('20'));
  });

  it('returns every remaining fil on the last partial refund', () => {
    // 3 items for 10.000 incl 1.379 tax: refund 1, then 1, then the last one gets the remainder
    const a = proportion(d('10'), d('1.379'), 3, 1);
    const b = proportion(d('10').minus(a.total), d('1.379').minus(a.tax), 2, 1);
    const c = proportion(d('10').minus(a.total).minus(b.total), d('1.379').minus(a.tax).minus(b.tax), 1, 1);
    expect(a.total.plus(b.total).plus(c.total)).toEqual(d('10'));
    expect(a.tax.plus(b.tax).plus(c.tax)).toEqual(d('1.379'));
  });

  it('taxPart handles zero rate', () => {
    expect(taxPart(d('5'), d(0))).toEqual(d(0));
  });
});
