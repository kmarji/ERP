type Thresholds = { dailyThresholdMinutes: number; weeklyThresholdMinutes: number };

// ponytail: overtime = max(daily excess, weekly excess not already paid as overtime this week); per-entry, not per-day.
export function entryOvertime(prevWorked: number, prevOvertime: number, worked: number, rules: Thresholds) {
  const daily = Math.max(0, worked - rules.dailyThresholdMinutes);
  const weekly = Math.max(0, Math.max(0, prevWorked + worked - rules.weeklyThresholdMinutes) - prevOvertime);
  return Math.min(worked, Math.max(daily, weekly));
}

// Overtime of each entry of one week, in order.
export function overtimeMinutes(worked: number[], rules: Thresholds) {
  let total = 0;
  let overtime = 0;
  return worked.map((w) => {
    const o = entryOvertime(total, overtime, w, rules);
    total += w;
    overtime += o;
    return o;
  });
}

// Break assumed when no shift template sets one.
export const breakOf = (grossMinutes: number, templateBreak?: number) => templateBreak ?? (grossMinutes > 360 ? 30 : 0);
