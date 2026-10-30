import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api, newKey } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

const TABS = ['Orders', 'Shifts', 'Report', 'Settlements'];

export default function Sales() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <div className="space-y-4">
      <PageHeader title="Sales" subtitle="Orders, refunds, shifts, sales reports and card settlements." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'Orders' && <Orders />}
      {tab === 'Shifts' && <Shifts />}
      {tab === 'Report' && <Report />}
      {tab === 'Settlements' && <Settlements />}
    </div>
  );
}

function Orders() {
  const { lang } = useI18n();
  const branches = useList('/org/branches');
  const [flt, setFlt] = useState({ branchId: '', status: '', from: '', to: '' });
  const q = new URLSearchParams(Object.entries(flt).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['pos-orders', q], queryFn: () => api<any[]>(`/pos/orders?${q}`) });
  const [sel, setSel] = useState('');
  return (
    <div className="space-y-4">
      <ErrorBox error={list.error} />
      <Card>
        <div className="mb-3 grid gap-3 md:grid-cols-4">
          <Select value={flt.branchId} onChange={(e) => setFlt({ ...flt, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Select value={flt.status} onChange={(e) => setFlt({ ...flt, status: e.target.value })}><option value="">Any status</option>{['OPEN', 'SENT', 'COMPLETED', 'VOIDED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <Input type="date" value={flt.from} onChange={(e) => setFlt({ ...flt, from: e.target.value })} />
          <Input type="date" value={flt.to} onChange={(e) => setFlt({ ...flt, to: e.target.value })} />
        </div>
        {list.data?.length === 0 ? <Empty>No orders.</Empty> : (
          <Table head={['Order', 'Channel', 'Total', 'Status', 'Posting', 'Refund', 'Created']}>
            {list.data?.map((o) => (
              <tr key={o.id} onClick={() => setSel(o.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === o.id ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2 font-medium">{o.number} {o.source !== 'POS' && <Badge>{o.source}</Badge>}</td>
                <td className="px-3 py-2">{o.channel}</td>
                <td className="px-3 py-2">{formatJOD(o.total, lang)}</td>
                <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
                <td className="px-3 py-2"><StatusBadge status={o.postingStatus} /></td>
                <td className="px-3 py-2">{o.refundStatus !== 'NONE' && <Badge tone="bg-amber-100 text-amber-800">{o.refundStatus}</Badge>}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(o.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {sel && <OrderDetail id={sel} />}
    </div>
  );
}

function OrderDetail({ id }: { id: string }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ['pos-order', id], queryFn: () => api<any>(`/pos/orders/${id}`) });
  const [showReceipt, setShowReceipt] = useState(false);
  const receipt = useQuery({ queryKey: ['pos-receipt', id], queryFn: () => api<any>(`/pos/orders/${id}/receipt`), enabled: showReceipt });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pos-order', id] }); qc.invalidateQueries({ queryKey: ['pos-orders'] }); };
  const repost = useMutation({ mutationFn: () => api(`/pos/orders/${id}/repost`, { method: 'POST' }), onSuccess: refresh });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [f, setF] = useState({ reason: '', restock: false, full: false, email: '', password: '' });
  const refund = useMutation({
    mutationFn: () => api(`/pos/orders/${id}/refunds`, {
      body: {
        idempotencyKey: newKey(),
        reason: f.reason,
        restock: f.restock,
        ...(f.full ? { full: true } : { lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([orderLineId, v]) => ({ orderLineId, qty: Number(v) })) }),
        ...(f.email ? { override: { email: f.email, password: f.password } } : {}),
      },
    }),
    onSuccess: () => { setQty({}); setF({ ...f, reason: '', full: false, password: '' }); refresh(); },
  });
  const o = order.data;
  if (!o) return <Card><ErrorBox error={order.error} /></Card>;
  const lines = o.lines.filter((l: any) => !l.voided);
  const canRefund = o.status === 'COMPLETED' && o.refundStatus !== 'FULL';
  return (
    <Card title={`Order ${o.number}`}>
      <ErrorBox error={repost.error ?? refund.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={o.status} /><StatusBadge status={o.postingStatus} />
        <span className="text-slate-500">total {formatJOD(o.total, lang)} (tax {formatJOD(o.taxTotal, lang)}{Number(o.discountTotal) > 0 ? `, discount ${formatJOD(o.discountTotal, lang)}` : ''})</span>
        {o.invoice && <Badge>{o.invoice.number}</Badge>}
        {o.postingStatus === 'FAILED' && <Button variant="ghost" onClick={() => repost.mutate()}>Repost to ledger</Button>}
        <Button variant="ghost" onClick={() => setShowReceipt(!showReceipt)}>{showReceipt ? 'Hide receipt' : 'Receipt'}</Button>
      </div>
      <Table head={['Item', 'Qty', 'Unit', 'Total', 'Refunded', canRefund ? 'Refund qty' : '']}>
        {lines.map((l: any) => (
          <tr key={l.id}>
            <td className="px-3 py-2">{l.name} {(l.modifiers as any[]).length > 0 && <span className="text-xs text-slate-400">{(l.modifiers as any[]).map((m) => m.name).join(', ')}</span>}</td>
            <td className="px-3 py-2">{l.qty}</td><td className="px-3 py-2">{formatJOD(l.unitPrice, lang)}</td><td className="px-3 py-2">{formatJOD(l.total, lang)}</td><td className="px-3 py-2">{l.refundedQty}</td>
            <td className="px-3 py-2">{canRefund && <Input className="w-20" type="number" min="0" max={l.qty - l.refundedQty} disabled={f.full} value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-3 grid gap-4 text-sm md:grid-cols-2">
        <div><div className="text-xs font-medium text-slate-500">Tenders</div>{o.tenders.map((t: any) => <div key={t.id}>{t.method} {formatJOD(t.amount, lang)} <StatusBadge status={t.status} /> <span className="text-xs text-slate-400">{t.reference}</span></div>)}</div>
        <div><div className="text-xs font-medium text-slate-500">Refunds</div>{o.refunds.length === 0 ? <span className="text-slate-400">none</span> : o.refunds.map((r: any) => <div key={r.id}>{r.number} {formatJOD(r.total, lang)} via {r.method} <StatusBadge status={r.postingStatus} /> {r.approvedBy && <Badge>manager approved</Badge>}</div>)}</div>
      </div>
      {showReceipt && receipt.data && (
        <pre className="mt-4 max-w-sm whitespace-pre-wrap rounded border border-dashed border-slate-300 bg-white p-3 font-mono text-xs print:border-0">
{`${receipt.data.seller.name}${receipt.data.seller.taxNumber ? ` (Tax ${receipt.data.seller.taxNumber})` : ''}
${receipt.data.seller.branch}
${receipt.data.invoiceNumber ?? ''}  ${receipt.data.orderNumber}  ${receipt.data.issuedAt ? formatDate(receipt.data.issuedAt) : ''}
${'-'.repeat(32)}
${receipt.data.lines.map((l: any) => `${l.qty} x ${l.name}${l.nameAr ? ` / ${l.nameAr}` : ''}  ${formatJOD(l.total, lang)}`).join('\n')}
${'-'.repeat(32)}
Subtotal ${formatJOD(receipt.data.subtotal, lang)}
Discount ${formatJOD(receipt.data.discount, lang)}
${receipt.data.taxBreakdown.map((t: any) => `Tax ${t.ratePct}%: net ${formatJOD(t.net, lang)} tax ${formatJOD(t.tax, lang)}`).join('\n')}
TOTAL ${formatJOD(receipt.data.total, lang)}
${receipt.data.tenders.map((t: any) => `${t.method} ${formatJOD(t.amount, lang)}${Number(t.change) > 0 ? ` (change ${formatJOD(t.change, lang)})` : ''}`).join('\n')}`}
        </pre>
      )}
      {showReceipt && receipt.data && <Button variant="ghost" className="mt-2 print:hidden" onClick={() => window.print()}>Print</Button>}
      {canRefund && (
        <form className="mt-4 space-y-3 border-t border-slate-100 pt-4" onSubmit={(e: FormEvent) => { e.preventDefault(); refund.mutate(); }}>
          <div className="text-xs font-medium text-slate-500">Issue a refund (credit note). Above the cashier limit a manager must approve with their credentials.</div>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={2} /></Field>
            <Field label="Manager email (optional)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Manager password"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!!f.email} /></Field>
            <div className="mt-5 space-y-1 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.full} onChange={(e) => setF({ ...f, full: e.target.checked })} />Refund everything remaining</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.restock} onChange={(e) => setF({ ...f, restock: e.target.checked })} />Return ingredients to stock</label>
            </div>
          </div>
          <Button type="submit" disabled={!f.full && !Object.values(qty).some((v) => Number(v) > 0)}>Refund</Button>
        </form>
      )}
    </Card>
  );
}

function Shifts() {
  const { lang } = useI18n();
  const branches = useList('/org/branches');
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['pos-shifts', status], queryFn: () => api<any[]>(`/pos/shifts${status ? `?status=${status}` : ''}`) });
  const [sel, setSel] = useState('');
  const rep = useQuery({ queryKey: ['shift-report', sel], queryFn: () => api<any>(`/pos/shifts/${sel}/report`), enabled: !!sel });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error} />
        <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option>OPEN</option><option>CLOSED</option></Select></div>
        {list.data?.length === 0 ? <Empty>No shifts.</Empty> : (
          <Table head={['Branch', 'Opened', 'Float', 'Status', 'Variance']}>
            {list.data?.map((s) => (
              <tr key={s.id} onClick={() => setSel(s.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === s.id ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2">{nameOf(branches.data, s.branchId)}</td><td className="px-3 py-2 text-xs">{formatDate(s.openedAt)}</td>
                <td className="px-3 py-2">{formatJOD(s.openingFloat, lang)}</td><td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                <td className={`px-3 py-2 ${s.variance && Number(s.variance) !== 0 ? 'font-medium text-red-600' : ''}`}>{s.variance === null ? '-' : formatJOD(s.variance, lang)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card className="lg:col-span-2" title="Shift report">
        {!rep.data ? <Empty>Select a shift.</Empty> : (
          <div className="space-y-1 text-sm">
            <div>Orders: <b>{rep.data.orders}</b> - total {formatJOD(rep.data.total, lang)} (tax {formatJOD(rep.data.tax, lang)}, discounts {formatJOD(rep.data.discounts, lang)})</div>
            <div>Refunds: {rep.data.refunds.count} ({formatJOD(rep.data.refunds.total, lang)})</div>
            {rep.data.byTender.map((t: any) => <div key={t.method}>{t.method}: {t.count} x, {formatJOD(t.amount, lang)}</div>)}
            <div className="pt-2 text-xs font-medium text-slate-500">Drawer</div>
            {Object.entries(rep.data.cash).map(([k, v]) => <div key={k}>{k}: {formatJOD(v as string, lang)}</div>)}
            <div className="font-medium">Expected cash: {formatJOD(rep.data.expectedCash, lang)}</div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Report() {
  const { lang } = useI18n();
  const branches = useList('/org/branches');
  const [flt, setFlt] = useState({ branchId: '', from: '', to: '' });
  const q = new URLSearchParams(Object.entries(flt).filter(([, v]) => v)).toString();
  const r = useQuery({ queryKey: ['sales-report', q], queryFn: () => api<any>(`/pos/reports/sales?${q}`) });
  const d = r.data;
  return (
    <div className="space-y-4">
      <ErrorBox error={r.error} />
      <Card><div className="grid gap-3 md:grid-cols-3">
        <Select value={flt.branchId} onChange={(e) => setFlt({ ...flt, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        <Input type="date" value={flt.from} onChange={(e) => setFlt({ ...flt, from: e.target.value })} /><Input type="date" value={flt.to} onChange={(e) => setFlt({ ...flt, to: e.target.value })} />
      </div></Card>
      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {[['Orders', d.orders], ['Total', formatJOD(d.total, lang)], ['Tax', formatJOD(d.tax, lang)], ['Refunds', `${d.refunds.count} / ${formatJOD(d.refunds.total, lang)}`], ['Net after refunds', formatJOD(d.netAfterRefunds, lang)]].map(([k, v]) => (
              <Card key={k as string}><div className="text-xs text-slate-500">{k}</div><div className="text-lg font-semibold">{v}</div></Card>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="By channel">{d.byChannel.map((c: any) => <div key={c.channel} className="text-sm">{c.channel}: {c.orders} orders, {formatJOD(c.total, lang)}</div>)}</Card>
            <Card title="By tender">{d.byTender.map((t: any) => <div key={t.method} className="text-sm">{t.method}: {formatJOD(t.amount, lang)}</div>)}</Card>
            <Card title="Top items">{d.topItems.map((t: any) => <div key={t.menuItemId} className="text-sm">{t.name}: {t.qty} sold, {formatJOD(t.total, lang)}</div>)}</Card>
          </div>
          <p className="text-xs text-slate-400">Average order {formatJOD(d.averageOrder, lang)}; discounts {formatJOD(d.discounts, lang)}.</p>
        </>
      )}
    </div>
  );
}

function Settlements() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['settlements'], queryFn: () => api<any[]>('/pos/settlements') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['settlements'] }); qc.invalidateQueries({ queryKey: ['exceptions'] }); };
  const [f, setF] = useState({ provider: '', settlementDate: new Date().toISOString().slice(0, 10), reference: '', gross: '', fees: '', net: '', lines: [{ reference: '', amount: '' }] });
  const imp = useMutation({
    mutationFn: () => api('/pos/settlements', { body: { provider: f.provider, settlementDate: f.settlementDate, reference: f.reference, gross: Number(f.gross), fees: Number(f.fees), net: Number(f.net), lines: f.lines.filter((l) => l.reference).map((l) => ({ reference: l.reference, amount: Number(l.amount) })) } }),
    onSuccess: refresh,
  });
  const [reason, setReason] = useState<Record<string, string>>({});
  const resolve = useMutation({ mutationFn: (id: string) => api(`/pos/settlements/${id}/resolve`, { body: { accept: true, reason: reason[id] } }), onSuccess: refresh });
  const [missing, setMissing] = useState<any>(null);
  const check = useMutation({ mutationFn: () => api('/pos/settlements/check-missing?olderThanDays=3', { method: 'POST' }), onSuccess: (r) => { setMissing(r); refresh(); } });
  return (
    <div className="space-y-6">
      <ErrorBox error={list.error ?? imp.error ?? resolve.error ?? check.error} />
      <Card title="Settlements" className="space-y-3">
        <div className="mb-3 flex items-center gap-3"><Button variant="ghost" onClick={() => check.mutate()}>Check missing payouts (3+ days)</Button>{missing && <span className="text-sm">{missing.missing} unsettled card payment(s), {formatJOD(missing.total, lang)}</span>}</div>
        {list.data?.length === 0 ? <Empty>No settlements imported.</Empty> : list.data?.map((s) => (
          <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><b>{s.provider} {s.reference}</b><StatusBadge status={s.status} /><span className="text-slate-500">gross {formatJOD(s.gross, lang)}, fees {formatJOD(s.fees, lang)}, net {formatJOD(s.net, lang)}</span></div>
            <ul className="mt-2 text-xs">{s.lines.map((l: any) => <li key={l.id} className={l.matched ? 'text-emerald-700' : 'text-red-700'}>{l.matched ? 'matched' : 'unmatched'} {l.reference} {formatJOD(l.amount, lang)} {l.note && `- ${l.note}`}</li>)}</ul>
            {s.status === 'EXCEPTION' && (
              <div className="mt-2 flex gap-2"><Input placeholder="Reason for accepting" value={reason[s.id] ?? ''} onChange={(e) => setReason({ ...reason, [s.id]: e.target.value })} /><Button disabled={(reason[s.id] ?? '').length < 3} onClick={() => resolve.mutate(s.id)}>Accept with differences</Button></div>
            )}
          </div>
        ))}
      </Card>
      <Card title="Import statement">
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); imp.mutate(); }}>
          <div className="grid gap-3 md:grid-cols-6">
            <Field label="Provider"><Input value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} required /></Field>
            <Field label="Date"><Input type="date" value={f.settlementDate} onChange={(e) => setF({ ...f, settlementDate: e.target.value })} required /></Field>
            <Field label="Statement ref"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required /></Field>
            <Field label="Gross"><Input type="number" step="0.001" value={f.gross} onChange={(e) => setF({ ...f, gross: e.target.value })} required /></Field>
            <Field label="Fees"><Input type="number" step="0.001" value={f.fees} onChange={(e) => setF({ ...f, fees: e.target.value })} required /></Field>
            <Field label="Net"><Input type="number" step="0.001" value={f.net} onChange={(e) => setF({ ...f, net: e.target.value })} required /></Field>
          </div>
          {f.lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Input placeholder="Terminal reference" value={l.reference} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)) })} />
              <Input className="w-36" type="number" step="0.001" placeholder="Amount" value={l.amount} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} />
            </div>
          ))}
          <div className="flex gap-2"><Button type="button" variant="ghost" onClick={() => setF({ ...f, lines: [...f.lines, { reference: '', amount: '' }] })}>Add line</Button><Button type="submit">Import</Button></div>
        </form>
      </Card>
    </div>
  );
}
