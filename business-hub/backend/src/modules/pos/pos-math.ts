import { Decimal, d, money } from '../../common/money';

// Consumer prices are tax-inclusive: tax is the portion of the payable amount that is VAT.
export const taxPart = (inclusive: Decimal, rate: Decimal): Decimal => money(inclusive.times(rate).div(d(1).plus(rate)));

export interface LineAmounts {
  gross: Decimal; // qty x unit price, tax-inclusive
  discount: Decimal; // tax-inclusive share of order/line discounts
  total: Decimal; // payable
  tax: Decimal;
  net: Decimal; // revenue excluding tax
  discountEx: Decimal; // discount excluding the tax it would have carried
}

export function lineAmounts(qty: number, unitPrice: Decimal, taxRate: Decimal, discount: Decimal = d(0)): LineAmounts {
  const gross = money(unitPrice.times(qty));
  const disc = Decimal.min(money(discount), gross);
  const total = gross.minus(disc);
  const tax = taxPart(total, taxRate);
  const net = total.minus(tax);
  const discountEx = gross.minus(taxPart(gross, taxRate)).minus(net);
  return { gross, discount: disc, total, tax, net, discountEx };
}

// Spreads an order-level discount over lines in proportion to their gross value; the rounding remainder goes to
// the largest line so allocations always add up to exactly the discount.
export function allocateDiscount(grosses: Decimal[], discount: Decimal): Decimal[] {
  const totalGross = grosses.reduce((s, g) => s.plus(g), d(0));
  if (totalGross.isZero() || discount.isZero()) return grosses.map(() => d(0));
  const capped = Decimal.min(money(discount), totalGross);
  const parts = grosses.map((g) => money(capped.times(g).div(totalGross)));
  const remainder = capped.minus(parts.reduce((s, p) => s.plus(p), d(0)));
  if (!remainder.isZero()) {
    const idx = grosses.reduce((best, g, i) => (g.gt(grosses[best]) ? i : best), 0);
    parts[idx] = parts[idx].plus(remainder);
  }
  return parts;
}

export interface DiscountSpec {
  kind: 'PERCENT' | 'AMOUNT' | 'VOUCHER' | 'LOYALTY';
  value: number; // percent, or JOD amount
  amount?: number; // resolved JOD amount (kept for vouchers and loyalty, whose value is fixed when applied)
  reason?: string;
  approvedBy?: string | null;
  voucherId?: string;
  points?: number;
}

// Resolves each discount against the current gross and caps the cumulative total at the gross.
export function resolveDiscounts(gross: Decimal, specs: DiscountSpec[]): { amounts: Decimal[]; total: Decimal } {
  let remaining = gross;
  const amounts = specs.map((s) => {
    const wanted = s.kind === 'PERCENT' ? money(gross.times(s.value).div(100)) : money(s.kind === 'AMOUNT' ? s.value : s.amount ?? 0);
    const applied = Decimal.min(wanted, remaining);
    remaining = remaining.minus(applied);
    return applied;
  });
  return { amounts, total: amounts.reduce((s, a) => s.plus(a), d(0)) };
}

// Part of an original line (or refund) that is being returned, without losing fils to rounding:
// returning every remaining unit returns every remaining fil.
export function proportion(remainingTotal: Decimal, remainingTax: Decimal, remainingQty: number, qty: number) {
  if (qty >= remainingQty) return { total: remainingTotal, tax: remainingTax };
  const total = money(remainingTotal.times(qty).div(remainingQty));
  const tax = money(remainingTax.times(qty).div(remainingQty));
  return { total, tax };
}
