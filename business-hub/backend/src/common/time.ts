// Business dates follow Jordan local time (Asia/Amman), stored as UTC-midnight DATE values.
export function ammanToday(now: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}

export const dateOnly = (s: string): Date => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
