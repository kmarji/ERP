import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Receipt } from '../components/Receipt';
import { Btn, Chip, Err, Input } from '../components/ui';
import { api, newKey } from '../lib/api';
import { fmt, num } from '../lib/format';
import { useI18n } from '../lib/i18n';

type Method = 'CASH' | 'CARD' | 'DIGITAL' | 'GIFT_CARD';

export default function Pay() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { t } = useI18n();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api<any>(`/pos/orders/${id}`) });
  const receipt = useQuery({ queryKey: ['receipt', id], queryFn: () => api<any>(`/pos/orders/${id}/receipt`), enabled: order.data?.status === 'COMPLETED' });
  const [method, setMethod] = useState<Method>('CASH');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [declined, setDeclined] = useState('');

  const o = order.data;
  if (!o) return <Err error={order.error} />;
  if (o.status === 'COMPLETED') return <div className="p-6">{receipt.data ? <Receipt r={receipt.data} onDone={() => nav('/order')} /> : <Err error={receipt.error} />}</div>;

  const paid = o.tenders.filter((x: any) => x.status === 'CAPTURED').reduce((s: number, x: any) => s + num(x.amount), 0);
  const due = Math.max(0, num(o.total) - paid);
  const quick = [...new Set([due, Math.ceil(due), Math.ceil(due / 5) * 5, Math.ceil(due / 10) * 10, Math.ceil(due / 50) * 50])];
  const tendered = amount === '' ? due : num(amount);
  const change = method === 'CASH' ? Math.max(0, tendered - due) : 0;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['order', id] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // A fresh idempotency key per tap, kept stable by the request itself: a retried POST is never charged twice.
  const addTender = () =>
    run(async () => {
      setDeclined('');
      const body: any = { idempotencyKey: newKey(), method };
      if (method === 'CASH') body.tendered = tendered;
      else {
        body.amount = amount === '' ? due : num(amount);
        body.reference = ref || undefined;
      }
      const tender = await api<any>(`/pos/orders/${id}/tenders`, { body });
      if (tender.status === 'FAILED') setDeclined(`Payment declined (${tender.reference ?? 'no reference'}). Try another method.`);
      setAmount('');
      setRef('');
    });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 md:flex-row">
      <section className="flex-1 space-y-3 rounded-2xl bg-white p-4">
        <div className="text-lg">{o.number}</div>
        <div className="text-4xl font-bold">{t('Due')}: {fmt(due)}</div>
        <div className="text-slate-500">{t('Total')} {fmt(o.total)} - paid {fmt(paid)}</div>
        {o.tenders.filter((x: any) => x.status !== 'VOIDED').map((x: any) => <div key={x.id} className={`flex justify-between rounded-xl px-3 py-2 ${x.status === 'FAILED' ? 'bg-red-50 text-red-700' : 'bg-slate-50'}`}><span>{x.method} {x.reference ?? ''}</span><span>{fmt(x.amount)} {x.status}</span></div>)}
        <Btn className="w-full" disabled={busy || due > 0.0005} onClick={() => void run(async () => { await api(`/pos/orders/${id}/complete`, { method: 'POST', body: {} }); })}>{t('Complete')}</Btn>
      </section>
      {due > 0.0005 && (
        <section className="flex-1 space-y-3 rounded-2xl bg-white p-4">
          <div className="flex flex-wrap gap-2">
            {([['CASH', 'Cash'], ['CARD', 'Card'], ['DIGITAL', 'Digital'], ['GIFT_CARD', 'Gift card']] as const).map(([m, label]) => <Chip key={m} on={method === m} onClick={() => { setMethod(m); setAmount(''); }}>{t(label)}</Chip>)}
          </div>
          <Err error={error} />
          {declined && <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">{declined}</p>}
          {method === 'CASH' && <div className="flex flex-wrap gap-2">{quick.map((q) => <Chip key={q} on={tendered === q} onClick={() => setAmount(String(q))}>{fmt(q)}</Chip>)}</div>}
          <Input inputMode="decimal" placeholder={method === 'CASH' ? 'Cash received' : 'Amount (blank = all due)'} value={amount} onChange={(e) => setAmount(e.target.value)} />
          {method !== 'CASH' && <Input placeholder={method === 'GIFT_CARD' ? 'Gift card code' : 'Approval code from the card terminal'} value={ref} onChange={(e) => setRef(e.target.value)} autoCapitalize="characters" />}
          {method === 'CASH' && <div className="text-2xl">{t('Change')}: {fmt(change)}</div>}
          <Btn className="w-full" disabled={busy || tendered <= 0 || (method !== 'CASH' && !ref.trim())} onClick={() => void addTender()}>{t('Pay')} {fmt(method === 'CASH' ? Math.min(tendered, due) : tendered)}</Btn>
        </section>
      )}
    </div>
  );
}
