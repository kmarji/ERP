// JOD has three decimals; the API sends money as strings.
export const fmt = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '-' : Number(v).toFixed(3));
export const num = (v: number | string | null | undefined) => Number(v ?? 0);
export const time = (d: string | Date) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
