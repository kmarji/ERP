import { d } from '../../common/money';
import { calculatePay, overlapDays } from './payroll-engine';
import { parseRules } from './payroll-rules';

const rules = parseRules({});
const base = { basic: d(600), allowances: d(100), periodDays: 30, daysEmployed: 30, overtimeMinutes: 0, lateMinutes: 0, unpaidLeaveDays: 0, otherEarnings: d(0), advanceRecovery: d(0) };

describe('payroll engine', () => {
  it('calculates a full month with social security and annualized income tax', () => {
    const r = calculatePay(rules, base);
    expect(r.gross).toEqual(d(700));
    expect(r.sscEmployee).toEqual(d('52.5')); // 7.5% of 700
    expect(r.sscEmployer).toEqual(d('99.75')); // 14.25% of 700
    // taxable (700-52.5)*12 = 7770 - exemption 9000 < 0
    expect(r.incomeTax).toEqual(d(0));
    expect(r.net).toEqual(d('647.5'));
    expect(r.trace.map((t) => t.step)).toEqual(expect.arrayContaining(['proration', 'gross', 'sscEmployee', 'incomeTax', 'net']));
  });

  it('applies tax brackets above the exemption', () => {
    const r = calculatePay(rules, { ...base, basic: d(2000), allowances: d(0) });
    // gross 2000, ssc 150, taxable (1850*12)=22200-9000=13200 -> 5000*5% + 5000*10% + 3200*15% = 250+500+480 = 1230 / 12
    expect(r.incomeTax).toEqual(d('102.5'));
    expect(r.net).toEqual(d('1747.5'));
  });

  it('prorates a mid-month hire and deducts unpaid leave at the daily rate', () => {
    const half = calculatePay(rules, { ...base, daysEmployed: 15 });
    expect(half.basic).toEqual(d(300));
    expect(half.allowances).toEqual(d(50));
    const leave = calculatePay(rules, { ...base, unpaidLeaveDays: 2 });
    expect(leave.unpaidLeaveDeduction).toEqual(d(40)); // 600/30 x 2
    expect(leave.gross).toEqual(d(660));
  });

  it('pays overtime at the hourly rate times the multiplier', () => {
    const r = calculatePay(rules, { ...base, overtimeMinutes: 120 }); // 600/30/8 = 2.5/h; 2h x 2.5 x 1.25
    expect(r.overtimePay).toEqual(d('6.25'));
  });

  it('recovers advances and honours the social security ceiling', () => {
    const r = calculatePay(parseRules({ ssc: { monthlyCeiling: 500 } }), { ...base, advanceRecovery: d(50) });
    expect(r.sscEmployee).toEqual(d('37.5'));
    expect(r.net).toEqual(d('612.5')); // 700 - 37.5 - 50
  });

  it('only deducts lateness when the rules say so', () => {
    expect(calculatePay(rules, { ...base, lateMinutes: 60 }).lateDeduction).toEqual(d(0));
    expect(calculatePay(parseRules({ lateness: { deduct: true } }), { ...base, lateMinutes: 60 }).lateDeduction).toEqual(d('2.5'));
  });

  it('is deterministic and balanced: gross + employer cost = net + deductions + obligations', () => {
    const r = calculatePay(rules, { ...base, basic: d(1500), overtimeMinutes: 300, advanceRecovery: d(25) });
    expect(r.gross.plus(r.sscEmployer)).toEqual(r.net.plus(r.sscEmployee).plus(r.sscEmployer).plus(r.incomeTax).plus(r.advances));
    expect(calculatePay(rules, { ...base, basic: d(1500), overtimeMinutes: 300, advanceRecovery: d(25) }).net).toEqual(r.net);
  });

  it('counts overlapping calendar days inclusively', () => {
    const d1 = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(overlapDays(d1('2026-10-01'), d1('2026-10-31'), d1('2026-10-16'), null)).toBe(16);
    expect(overlapDays(d1('2026-10-01'), d1('2026-10-31'), d1('2026-09-01'), d1('2026-10-10'))).toBe(10);
    expect(overlapDays(d1('2026-10-01'), d1('2026-10-31'), d1('2026-11-05'), null)).toBe(0);
  });
});
