const DAY = 86_400_000;

// Calendar months on UTC-midnight dates; 31 January + 1 month is the last day of February.
export function addMonths(d: Date, n: number) {
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), lastDay)));
}

export function employmentPeriod(from: Date, to: Date) {
  if (to < from) return { years: 0, months: 0, days: 0 };
  let n = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  if (addMonths(from, n) > to) n--;
  return { years: Math.floor(n / 12), months: n % 12, days: Math.round((to.getTime() - addMonths(from, n).getTime()) / DAY) };
}
