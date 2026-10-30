import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useOverride } from '../components/Override';
import { Btn, Chip, Err, Input } from '../components/ui';
import { api, newKey } from '../lib/api';
import { fmt, time } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNet } from '../lib/offline';
import { useSession } from '../lib/session';

export default function RefundPage() {
  const { t, nameOf } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const override = useOverride();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const key = useRef(newKey()); // one key per refund attempt, so a double tap or retry never refunds twice

  const list = useQuery({ queryKey: ['completed', branch!.id], queryFn: () => api<any[]>(`/pos/orders?branchId=${branch!.id}&status=COMPLETED&take=100`), enabled: net.online });
  const detail = useQuery({ queryKey: ['order', sel], queryFn: () => api<any>(`/pos/orders/${sel}`), enabled: !!sel });
  const o = detail.data;

  if (!net.online) return <p className="p-8 text-xl">Refunds need the server (approval and the original payment). They are blocked offline.</p>;

  async function submit(full: boolean) {
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([orderLineId, n]) => ({ orderLineId, qty: n }));
      const r = await override((ov) => api<any>(`/pos/orders/${sel}/refunds`, { body: { idempotencyKey: key.current, ...(full ? { full: true } : { lines }), reason, restock, override: ov } }));
      setDone(r);
      key.current = newKey();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (done) return (
    <div className="mx-auto max-w-xl space-y-4 p-8 text-center">
      <h2 className="text-2xl font-semibold">Refund {done.number}: {fmt(done.total)} JOD via {done.method}</h2>
      <Btn onClick={() => { setDone(null); setSel(null); setQty({}); setReason(''); void list.refetch(); }}>OK</Btn>
    </div>
  );

  const shown = (list.data ?? []).filter((x) => x.number.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6 md:flex-row">
      <section className="flex-1 space-y-2">
        <h1 className="text-2xl font-semibold">{t('Refund')}</h1>
        <Input placeholder="Order number" value={q} onChange={(e) => setQ(e.target.value)} />
        <Err error={list.error} />
        {shown.map((x) => (
          <button key={x.id} onClick={() => { setSel(x.id); setQty({}); }} className={`flex min-h-16 w-full items-center justify-between rounded-2xl border p-3 text-lg ${sel === x.id ? 'border-brand-600 bg-brand-50' : 'bg-white'}`}>
            <span>{x.number} <span className="text-slate-500">{time(x.completedAt ?? x.createdAt)}</span></span>
            <span>{fmt(x.total)} {x.refundStatus !== 'NONE' && <span className="text-sm text-amber-700">{x.refundStatus}</span>}</span>
          </button>
        ))}
      </section>
      {o && (
        <section className="flex-1 space-y-3 rounded-2xl bg-white p-4">
          <Err error={error} />
          {o.lines.filter((l: any) => !l.voided).map((l: any) => {
            const left = l.qty - l.refundedQty;
            return (
              <div key={l.id} className="flex items-center justify-between">
                <span>{nameOf(l)} <span className="text-slate-500">({left} left)</span></span>
                <span className="flex items-center gap-2">
                  <Btn tone="ghost" className="min-h-12 px-4" disabled={left === 0} onClick={() => setQty({ ...qty, [l.id]: Math.max(0, (qty[l.id] ?? 0) - 1) })}>-</Btn>
                  <span className="w-8 text-center text-xl">{qty[l.id] ?? 0}</span>
                  <Btn tone="ghost" className="min-h-12 px-4" disabled={left === 0} onClick={() => setQty({ ...qty, [l.id]: Math.min(left, (qty[l.id] ?? 0) + 1) })}>+</Btn>
                </span>
              </div>
            );
          })}
          <Input placeholder={t('Reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Chip on={restock} onClick={() => setRestock(!restock)}>Return items to stock</Chip>
          <div className="flex gap-3">
            <Btn className="flex-1" disabled={busy || reason.length < 2 || !Object.values(qty).some((n) => n > 0)} onClick={() => void submit(false)}>{t('Refund')}</Btn>
            <Btn tone="danger" className="flex-1" disabled={busy || reason.length < 2} onClick={() => void submit(true)}>Refund all</Btn>
          </div>
        </section>
      )}
    </div>
  );
}
