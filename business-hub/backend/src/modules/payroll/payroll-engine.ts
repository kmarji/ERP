import { Decimal, d, money } from '../../common/money';
import { PayrollRules } from './payroll-rules';

export interface PayInput {
  basic: Decimal; // monthly contractual basic salary
  allowances: Decimal; // monthly fixed allowances
  periodDays: number; // calendar days in the pay period
  daysEmployed: number; // calendar days of the period the employee was employed
  overtimeMinutes: number;
  lateMinutes: number;
  unpaidLeaveDays: number;
  otherEarnings: Decimal; // adjustments, retro pay (negative for deductions)
  advanceRecovery: Decimal;
}

export interface PayResult {
  basic: Decimal;
  allowances: Decimal;
  overtimePay: Decimal;
  otherEarnings: Decimal;
  lateDeduction: Decimal;
  unpaidLeaveDeduction: Decimal;
  gross: Decimal;
  sscEmployee: Decimal;
  sscEmployer: Decimal;
  incomeTax: Decimal;
  advances: Decimal;
  net: Decimal;
  trace: { step: string; formula: string; value: string }[];
}

const bracketTax = (annualTaxable: Decimal, brackets: PayrollRules['tax']['brackets']): Decimal => {
  let tax = d(0);
  let lower = d(0);
  for (const b of brackets) {
    if (annualTaxable.lte(lower)) break;
    const upper = b.upTo === null ? annualTaxable : Decimal.min(annualTaxable, d(b.upTo));
    tax = tax.plus(upper.minus(lower).times(b.rate));
    if (b.upTo === null) break;
    lower = d(b.upTo);
  }
  return tax;
};

// Pure and deterministic: the same inputs and rule set always give the same figures, with a trace of every step.
export function calculatePay(rules: PayrollRules, i: PayInput): PayResult {
  const trace: PayResult['trace'] = [];
  const log = (step: string, formula: string, value: Decimal) => trace.push({ step, formula, value: value.toString() });

  const proration = d(i.daysEmployed).div(i.periodDays);
  const basic = money(i.basic.times(proration));
  const allowances = money(i.allowances.times(proration));
  log('proration', `${i.daysEmployed} / ${i.periodDays} days employed`, proration.toDecimalPlaces(6));
  log('basic', `${i.basic} x proration`, basic);
  log('allowances', `${i.allowances} x proration`, allowances);

  const dailyRate = i.basic.div(rules.workingDaysPerMonth);
  const hourlyRate = dailyRate.div(rules.dailyHours);
  log('hourlyRate', `${i.basic} / ${rules.workingDaysPerMonth} days / ${rules.dailyHours} hours`, hourlyRate.toDecimalPlaces(6));

  const overtimePay = money(d(i.overtimeMinutes).div(60).times(hourlyRate).times(rules.overtime.multiplier));
  log('overtime', `${i.overtimeMinutes} min / 60 x hourly x ${rules.overtime.multiplier}`, overtimePay);

  const unpaidLeaveDeduction = Decimal.min(money(dailyRate.times(i.unpaidLeaveDays)), basic);
  log('unpaidLeave', `${i.unpaidLeaveDays} day(s) x daily rate`, unpaidLeaveDeduction);

  const lateDeduction = rules.lateness.deduct ? money(d(i.lateMinutes).div(60).times(hourlyRate)) : d(0);
  log('lateness', rules.lateness.deduct ? `${i.lateMinutes} min x hourly` : 'lateness deduction disabled in rules', lateDeduction);

  const otherEarnings = money(i.otherEarnings);
  const gross = basic.plus(allowances).plus(overtimePay).plus(otherEarnings).minus(unpaidLeaveDeduction).minus(lateDeduction);
  log('gross', 'basic + allowances + overtime + other - unpaid leave - lateness', gross);

  const subject = Decimal.max(d(0), basic.plus(allowances).minus(unpaidLeaveDeduction));
  const capped = rules.ssc.monthlyCeiling === null ? subject : Decimal.min(subject, d(rules.ssc.monthlyCeiling));
  const sscEmployee = money(capped.times(rules.ssc.employeeRate));
  const sscEmployer = money(capped.times(rules.ssc.employerRate));
  log('sscSubjectWage', 'basic + allowances - unpaid leave, capped at the ceiling', capped);
  log('sscEmployee', `${rules.ssc.employeeRate * 100}% of subject wage`, sscEmployee);
  log('sscEmployer', `${rules.ssc.employerRate * 100}% of subject wage`, sscEmployer);

  const monthlyTaxable = Decimal.max(d(0), gross.minus(sscEmployee));
  const annualTaxable = Decimal.max(d(0), monthlyTaxable.times(12).minus(rules.tax.annualExemption).minus(rules.tax.familyExemption));
  const incomeTax = money(bracketTax(annualTaxable, rules.tax.brackets).div(12));
  log('incomeTax', `annualized taxable ${annualTaxable} through brackets / 12`, incomeTax);

  const advances = money(i.advanceRecovery);
  const net = gross.minus(sscEmployee).minus(incomeTax).minus(advances);
  log('net', 'gross - employee social security - income tax - advance recovery', net);
  return { basic, allowances, overtimePay, otherEarnings, lateDeduction, unpaidLeaveDeduction, gross, sscEmployee, sscEmployer, incomeTax, advances, net, trace };
}

// Calendar days (inclusive) two date ranges share.
export function overlapDays(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date | null): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd ? bEnd.getTime() : Infinity);
  return end < start ? 0 : Math.round((end - start) / 86_400_000) + 1;
}
