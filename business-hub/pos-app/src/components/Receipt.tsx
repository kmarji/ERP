import { useState } from 'react';
import { fmt } from '../lib/format';
import { canPrintNative, printReceipt } from '../lib/printer';
import { useI18n } from '../lib/i18n';
import { Btn } from './ui';

export interface ReceiptData {
  invoiceNumber: string | null;
  orderNumber: string;
  issuedAt?: string | null;
  provisional?: boolean;
  seller: { name: string; taxNumber?: string | null; branch: string };
  lines: { name: string; nameAr?: string | null; qty: number; unitPrice: string | number; modifiers?: any[]; discount?: string | number; total: string | number }[];
  subtotal: string | number;
  discount: string | number;
  total: string | number;
  taxBreakdown: { ratePct: string; net: string; tax: string }[];
  tenders: { method: string; amount: string | number; tendered: string | number; change: string | number }[];
}

// Narrow 72mm layout; only .receipt prints (see index.css). Both English and Arabic names are shown.
export function Receipt({ r, onDone }: { r: ReceiptData; onDone?: () => void }) {
  const { t } = useI18n();
  const [err, setErr] = useState('');
  const print = async () => {
    setErr('');
    if (!canPrintNative()) return window.print();
    try { await printReceipt(r); } catch (e: any) { setErr(`Printer error: ${e?.message ?? e}. Check the printer's IP and that it is on.`); }
  };
  return (
    <div>
      <div className="receipt mx-auto w-72 rounded-lg border bg-white p-3 font-mono text-xs" dir="ltr">
        <div className="text-center">
          <div className="text-sm font-bold">{r.seller.name}</div>
          <div>{r.seller.branch}</div>
          {r.seller.taxNumber && <div>Tax no. {r.seller.taxNumber}</div>}
          <div>{r.provisional ? 'PROVISIONAL (sold offline)' : `Invoice ${r.invoiceNumber ?? ''}`}</div>
          <div>{r.orderNumber} {r.issuedAt ? new Date(r.issuedAt).toLocaleString('en-GB') : ''}</div>
        </div>
        <hr className="my-2 border-dashed" />
        {r.lines.map((l, i) => (
          <div key={i} className="mb-1">
            <div className="flex justify-between"><span>{l.qty} x {l.name}</span><span>{fmt(l.total)}</span></div>
            {l.nameAr && <div dir="rtl" className="text-right">{l.nameAr}</div>}
            {l.modifiers?.map((m: any) => <div key={m.id} className="pl-3 text-slate-500">+ {m.name}</div>)}
          </div>
        ))}
        <hr className="my-2 border-dashed" />
        <div className="flex justify-between"><span>{t('Subtotal')}</span><span>{fmt(r.subtotal)}</span></div>
        {Number(r.discount) > 0 && <div className="flex justify-between"><span>{t('Discount')}</span><span>-{fmt(r.discount)}</span></div>}
        <div className="flex justify-between text-sm font-bold"><span>{t('Total')} JOD</span><span>{fmt(r.total)}</span></div>
        {r.taxBreakdown.map((x) => <div key={x.ratePct} className="flex justify-between text-slate-600"><span>{t('Tax')} {x.ratePct}% (net {fmt(x.net)})</span><span>{fmt(x.tax)}</span></div>)}
        <hr className="my-2 border-dashed" />
        {r.tenders.map((x, i) => (
          <div key={i} className="flex justify-between"><span>{x.method}{Number(x.change) > 0 ? ` (change ${fmt(x.change)})` : ''}</span><span>{fmt(x.tendered)}</span></div>
        ))}
      </div>
      {err && <p className="mt-3 text-center text-sm text-red-600 print:hidden">{err}</p>}
      <div className="mt-4 flex justify-center gap-3 print:hidden">
        <Btn tone="ghost" onClick={() => void print()}>{t('Print')}</Btn>
        {onDone && <Btn onClick={onDone}>{t('New order')}</Btn>}
      </div>
    </div>
  );
}
