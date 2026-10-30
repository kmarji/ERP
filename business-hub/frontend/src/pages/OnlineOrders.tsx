import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Select, StatusBadge, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useList } from '../lib/lookups';

const COLUMNS = ['PLACED', 'ACCEPTED', 'READY', 'OUT_FOR_DELIVERY'];
const HISTORY = ['DELIVERED', 'CANCELLED', 'REJECTED'];

const paidInfo = (o: any) => {
  const captured = (o.tenders ?? []).filter((t: any) => t.status === 'CAPTURED');
  const paid = captured.reduce((s: number, t: any) => s + Number(t.amount), 0);
  return { methods: [...new Set(captured.map((t: any) => t.method))] as string[], due: Math.max(0, Number(o.total) - paid) };
};

function Countdown({ at }: { at: string | null }) {
  if (!at) return null;
  const mins = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  return <span className={mins < 0 ? 'font-medium text-red-600' : 'text-slate-500'}>{mins < 0 ? `${-mins} min late` : `due in ${mins} min`}</span>;
}

function OrderCard({ o, onAct, busy }: { o: any; onAct: (id: string, action: string, body?: object) => void; busy: boolean }) {
  const { lang } = useI18n();
  const [note, setNote] = useState('');
  const [cash, setCash] = useState('');
  const { methods, due } = paidInfo(o);
  const st = o.fulfilmentStatus as string;
  const contact = o.contact ?? {};
  const isDelivery = o.channel === 'DELIVERY' || o.source === 'AGGREGATOR';
  const deliverBody = due > 0 ? { cash: { tendered: Number(cash) } } : {};
  const deliverOk = due === 0 || Number(cash) >= due;
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{o.number}</span>
        <span className="flex gap-1"><Badge tone={o.source === 'AGGREGATOR' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}>{o.source}</Badge><Badge>{o.channel}</Badge></span>
      </div>
      <div className="flex justify-between"><span>{formatJOD(o.total, lang)}</span><Countdown at={o.promisedAt} /></div>
      <div className="text-xs text-slate-600">
        {contact.name} {contact.phone}
        {contact.address && <div>{contact.address.area ? `${contact.address.area}: ` : ''}{contact.address.text}</div>}
      </div>
      <ul className="text-xs text-slate-700">{o.lines?.filter((l: any) => !l.voided).map((l: any) => <li key={l.id}>{l.qty} x {l.name}</li>)}</ul>
      <div className="text-xs">
        {due > 0 ? <Badge tone="bg-amber-100 text-amber-800">COD: collect {formatJOD(due, lang)}</Badge> : <Badge tone="bg-emerald-100 text-emerald-800">Paid ({methods.join(', ') || '-'})</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        {st === 'PLACED' && <Button disabled={busy} onClick={() => onAct(o.id, 'accept')}>Accept</Button>}
        {st === 'ACCEPTED' && <Button disabled={busy} onClick={() => onAct(o.id, 'ready')}>Ready</Button>}
        {st === 'READY' && isDelivery && <Button disabled={busy} variant="ghost" onClick={() => onAct(o.id, 'dispatch', { driver: note || undefined })}>Dispatch</Button>}
        {(st === 'READY' || st === 'OUT_FOR_DELIVERY') && (
          <>
            {due > 0 && <Input className="w-24" type="number" step="0.001" placeholder="Cash given" value={cash} onChange={(e) => setCash(e.target.value)} />}
            <Button disabled={busy || !deliverOk} onClick={() => onAct(o.id, 'deliver', deliverBody)}>Deliver</Button>
          </>
        )}
        <Input className="w-32" placeholder={st === 'READY' ? 'Driver / reason' : 'Reason'} value={note} onChange={(e) => setNote(e.target.value)} />
        {st === 'PLACED' && <Button variant="danger" disabled={busy || note.length < 3} onClick={() => onAct(o.id, 'reject', { reason: note })}>Reject</Button>}
        {st !== 'PLACED' && <Button variant="danger" disabled={busy || note.length < 3} onClick={() => onAct(o.id, 'cancel', { reason: note })}>Cancel</Button>}
      </div>
    </div>
  );
}

export default function OnlineOrders() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const [tab, setTab] = useState('Live');
  const [branchId, setBranchId] = useState('');
  const [hist, setHist] = useState('DELIVERED');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const bq = branchId ? `branchId=${branchId}` : '';
  const live = useQuery({ queryKey: ['online-orders', branchId], queryFn: () => api<any[]>(`/online-orders?${bq}`), refetchInterval: 8000, enabled: tab === 'Live' });
  const history = useQuery({ queryKey: ['online-orders-history', branchId, hist], queryFn: () => api<any[]>(`/online-orders?status=${hist}&${bq}`), enabled: tab === 'History' });
  const act = useMutation({
    mutationFn: (v: { id: string; action: string; body?: object }) => api(`/online-orders/${v.id}/${v.action}`, { method: 'POST', body: v.body ?? {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['online-orders'] }),
  });
  const onAct = (id: string, action: string, body?: object) => act.mutate({ id, action, body });
  return (
    <div className="space-y-4">
      <PageHeader title="Online orders" subtitle="Direct and marketplace orders for the branch. The board refreshes every few seconds." actions={
        <Select className="w-48" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>} />
      <ErrorBox error={live.error ?? history.error ?? act.error} />
      <Tabs tabs={['Live', 'History']} value={tab} onChange={setTab} />
      {tab === 'Live' ? (
        <div className="grid gap-4 lg:grid-cols-4">
          {COLUMNS.map((c) => {
            const rows = live.data?.filter((o) => o.fulfilmentStatus === c) ?? [];
            return (
              <div key={c} className="space-y-3 rounded-xl bg-slate-100 p-3">
                <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500"><span>{c.replace(/_/g, ' ')}</span><span>{rows.length}</span></div>
                {rows.length === 0 && <Empty>None</Empty>}
                {rows.map((o) => <OrderCard key={o.id} o={o} onAct={onAct} busy={act.isPending} />)}
              </div>
            );
          })}
        </div>
      ) : (
        <Card title={<span className="flex items-center gap-3">History <Select className="w-40 normal-case" value={hist} onChange={(e) => setHist(e.target.value)}>{HISTORY.map((s) => <option key={s}>{s}</option>)}</Select></span>}>
          {history.data?.length === 0 ? <Empty>No orders.</Empty> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {history.data?.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-2">
                  <span>{o.number} <Badge>{o.source}</Badge> <span className="text-xs text-slate-500">{formatDate(o.createdAt)}</span></span>
                  <span className="flex items-center gap-3">{formatJOD(o.total)} <StatusBadge status={o.fulfilmentStatus} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
