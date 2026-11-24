// JOD has three decimal places (fils).
export function formatJOD(value: number | string | null | undefined, lang: 'en' | 'ar' = 'en') {
  if (value === null || value === undefined || value === '') return '-';
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-JO' : 'en-JO', {
    style: 'currency',
    currency: 'JOD',
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(Number(value));
}

export const formatDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Amman', dateStyle: 'medium', timeStyle: 'short' }) : '-';

export const formatTime = (d: string | Date) => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Amman', hour: '2-digit', minute: '2-digit' });
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => ymd(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000));
export const mondayOf = (d = new Date()) => addDays(ymd(d), -((d.getUTCDay() + 6) % 7));
// <input type="datetime-local"> value -> ISO instant (browser time zone).
export const localToIso = (v: string) => new Date(v).toISOString();
