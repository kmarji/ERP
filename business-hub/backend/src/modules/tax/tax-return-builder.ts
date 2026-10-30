import { Decimal, d, money } from '../../common/money';

export interface LedgerEntryLike {
  direction: 'INPUT' | 'OUTPUT';
  taxRate: Decimal;
  eligible: boolean;
  base: Decimal;
  taxAmount: Decimal;
  sourceId: string;
}

export interface ReturnLine {
  direction: 'INPUT' | 'OUTPUT';
  taxRate: Decimal;
  eligible: boolean;
  base: Decimal;
  tax: Decimal;
  documents: number;
}

export interface ReturnTotals {
  lines: ReturnLine[];
  outputBase: Decimal;
  outputTax: Decimal;
  inputBase: Decimal;
  inputTaxRecoverable: Decimal;
  inputTaxNonRecoverable: Decimal;
  netPayable: Decimal;
}

// Sales are collected net of credit notes (negative rows). Only eligible input tax reduces the amount payable.
export function buildTotals(entries: LedgerEntryLike[]): ReturnTotals {
  const groups = new Map<string, { line: ReturnLine; docs: Set<string> }>();
  for (const e of entries) {
    const eligible = e.direction === 'INPUT' ? e.eligible : true;
    const key = `${e.direction}|${d(e.taxRate)}|${eligible}`;
    const g = groups.get(key) ?? { line: { direction: e.direction, taxRate: d(e.taxRate), eligible, base: d(0), tax: d(0), documents: 0 }, docs: new Set<string>() };
    g.line.base = g.line.base.plus(e.base);
    g.line.tax = g.line.tax.plus(e.taxAmount);
    g.docs.add(e.sourceId);
    groups.set(key, g);
  }
  const lines = [...groups.values()]
    .map(({ line, docs }) => ({ ...line, base: money(line.base), tax: money(line.tax), documents: docs.size }))
    .sort((a, b) => a.direction.localeCompare(b.direction) || Number(a.taxRate) - Number(b.taxRate));
  const sum = (pick: (l: ReturnLine) => boolean, f: (l: ReturnLine) => Decimal) => lines.filter(pick).reduce((s, l) => s.plus(f(l)), d(0));
  const outputTax = sum((l) => l.direction === 'OUTPUT', (l) => l.tax);
  const inputTaxRecoverable = sum((l) => l.direction === 'INPUT' && l.eligible, (l) => l.tax);
  return {
    lines,
    outputBase: sum((l) => l.direction === 'OUTPUT', (l) => l.base),
    outputTax,
    inputBase: sum((l) => l.direction === 'INPUT', (l) => l.base),
    inputTaxRecoverable,
    inputTaxNonRecoverable: sum((l) => l.direction === 'INPUT' && !l.eligible, (l) => l.tax),
    netPayable: outputTax.minus(inputTaxRecoverable),
  };
}
