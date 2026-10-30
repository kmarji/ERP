import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useList } from '../lib/lookups';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const HEALTH: Record<string, string> = { OK: 'bg-emerald-100 text-emerald-800', WARNING: 'bg-amber-100 text-amber-800', DEGRADED: 'bg-red-100 text-red-800' };
const slug = () => localStorage.getItem('bh_tenant') ?? '<tenant>';
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function Connections() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const conns = useQuery({ queryKey: ['agg-conns'], queryFn: () => api<any[]>('/aggregators/connections') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['agg-conns'] });
  const [f, setF] = useState({ provider: 'TALABAT', branchId: '', storeRef: '', autoAccept: true, commissionPct: '0' });
  const [fresh, setFresh] = useState<any>(null);
  const [result, setResult] = useState('');
  const create = useMutation({
    mutationFn: () => api('/aggregators/connections', { body: { provider: f.provider, branchId: f.branchId, storeRef: f.storeRef, autoAccept: f.autoAccept, commissionRate: Number(f.commissionPct) / 100 } }),
    onSuccess: (r) => { setFresh(r); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (c: any) => api(`/aggregators/connections/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } }), onSuccess: refresh });
  const poll = useMutation({ mutationFn: (id: string) => api(`/aggregators/connections/${id}/poll`, { method: 'POST' }), onSuccess: (r) => { setResult(`Poll: ${pretty(r)}`); refresh(); } });
  const sync = useMutation({ mutationFn: (id: string) => api(`/aggregators/connections/${id}/settlements/sync`, { method: 'POST' }), onSuccess: (r) => setResult(`Settlements: ${pretty(r)}`) });
  return (
    <div className="space-y-6">
      <ErrorBox error={conns.error ?? create.error ?? toggle.error ?? poll.error ?? sync.error} />
      {fresh && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm">
          <div className="font-semibold">Webhook secret for {fresh.provider} / {fresh.storeRef}</div>
          <div className="mt-1 text-amber-800">Copy it now. It is shown only once; if lost, disconnect and connect the store again.</div>
          <div className="mt-2 flex items-center gap-2"><code className="break-all rounded bg-white px-2 py-1">{fresh.webhookSecret}</code>
            <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(fresh.webhookSecret)}>Copy</Button><Button variant="ghost" onClick={() => setFresh(null)}>Done</Button></div>
          <div className="mt-2 text-xs text-slate-600">POST <code>{API}/aggregators/webhook/{slug()}/{fresh.id}</code> with header <code>x-webhook-secret</code>.</div>
        </div>
      )}
      <Card title="Connections">
        {conns.data?.length === 0 ? <Empty>No marketplace connected.</Empty> : (
          <Table head={['Provider', 'Store', 'Health', 'Last poll', 'Expected commission', '']}>
            {conns.data?.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2 font-medium">{c.provider}{!c.enabled && <> <Badge>disabled</Badge></>}</td>
                <td className="px-3 py-2">{c.storeRef}<div className="text-xs text-slate-400">{branches.data?.find((b) => b.id === c.branchId)?.name}</div></td>
                <td className="px-3 py-2"><Badge tone={HEALTH[c.health]}>{c.health}</Badge>{c.lastError && <div className="max-w-xs truncate text-xs text-red-600" title={c.lastError}>{c.lastError}</div>}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(c.lastPollAt)}</td>
                <td className="px-3 py-2">{(Number(c.commissionRate) * 100).toFixed(2)}%</td>
                <td className="space-x-2 px-3 py-2 text-end">
                  <Button variant="ghost" onClick={() => poll.mutate(c.id)}>Poll now</Button>
                  <Button variant="ghost" onClick={() => sync.mutate(c.id)}>Sync settlements</Button>
                  <Button variant="ghost" onClick={() => toggle.mutate(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {result && <pre className="mt-3 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs">{result}</pre>}
      </Card>
      <Card title="Connect a store">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Marketplace"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option>TALABAT</option><option>CAREEM</option></Select></Field>
          <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} required><option value="">Choose...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Store reference"><Input value={f.storeRef} onChange={(e) => setF({ ...f, storeRef: e.target.value })} required /></Field>
          <Field label="Expected commission %"><Input className="w-28" type="number" step="0.01" min="0" max="100" value={f.commissionPct} onChange={(e) => setF({ ...f, commissionPct: e.target.value })} /></Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={f.autoAccept} onChange={(e) => setF({ ...f, autoAccept: e.target.checked })} />Auto-accept</label>
          <Button type="submit" disabled={create.isPending}>Connect</Button>
        </form>
      </Card>
    </div>
  );
}

interface MapRow { externalItemId: string; menuItemId: string; variantId: string; modifierMap: string }

function Mapping() {
  const conns = useQuery({ queryKey: ['agg-conns'], queryFn: () => api<any[]>('/aggregators/connections') });
  const items = useList('/menu/items');
  const [connId, setConnId] = useState('');
  const maps = useQuery({ queryKey: ['agg-maps', connId], queryFn: () => api<any[]>(`/aggregators/connections/${connId}/mappings`), enabled: !!connId });
  const [rows, setRows] = useState<MapRow[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (maps.data) setRows(maps.data.map((m) => ({ externalItemId: m.externalItemId, menuItemId: m.menuItemId, variantId: m.variantId ?? '', modifierMap: JSON.stringify(m.modifierMap ?? {}) })));
  }, [maps.data]);
  const save = useMutation({
    mutationFn: () => {
      const mappings = rows.filter((r) => r.externalItemId && r.menuItemId).map((r) => ({ externalItemId: r.externalItemId, menuItemId: r.menuItemId, variantId: r.variantId || undefined, modifierMap: JSON.parse(r.modifierMap || '{}') }));
      return api(`/aggregators/connections/${connId}/mappings`, { method: 'PUT', body: { mappings } });
    },
    onSuccess: () => { setErr(''); maps.refetch(); },
    onError: (e: any) => setErr(e.message),
  });
  const upd = (i: number, patch: Partial<MapRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-4">
      <ErrorBox error={maps.error} />
      <Select className="w-72" value={connId} onChange={(e) => setConnId(e.target.value)}><option value="">Choose a connection...</option>{conns.data?.map((c) => <option key={c.id} value={c.id}>{c.provider} / {c.storeRef}</option>)}</Select>
      {connId && (
        <Card title="External item to menu item">
          {err && <p className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err.includes('JSON') ? `Modifier map is not valid JSON: ${err}` : err}</p>}
          <Table head={['External item id', 'Menu item', 'Variant', 'Modifier map (external id to modifier id, JSON)', '']}>
            {rows.map((r, i) => {
              const item = items.data?.find((x) => x.id === r.menuItemId);
              return (
                <tr key={i}>
                  <td className="px-2 py-1"><Input value={r.externalItemId} onChange={(e) => upd(i, { externalItemId: e.target.value })} /></td>
                  <td className="px-2 py-1"><Select value={r.menuItemId} onChange={(e) => upd(i, { menuItemId: e.target.value, variantId: '' })}><option value="">Choose...</option>{items.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></td>
                  <td className="px-2 py-1"><Select value={r.variantId} onChange={(e) => upd(i, { variantId: e.target.value })}><option value="">(none)</option>{(item?.variants ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></td>
                  <td className="px-2 py-1"><Input className="font-mono text-xs" value={r.modifierMap} onChange={(e) => upd(i, { modifierMap: e.target.value })} /></td>
                  <td className="px-2 py-1"><button className="text-xs text-red-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}>remove</button></td>
                </tr>
              );
            })}
          </Table>
          <div className="mt-3 flex gap-2">
            <Button variant="ghost" onClick={() => setRows([...rows, { externalItemId: '', menuItemId: '', variantId: '', modifierMap: '{}' }])}>Add row</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>Save mappings</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Inbound() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('NEEDS_MAPPING');
  const list = useQuery({ queryKey: ['agg-inbound', status], queryFn: () => api<any[]>(`/aggregators/inbound${status ? `?status=${status}` : ''}`) });
  const re = useMutation({ mutationFn: (id: string) => api(`/aggregators/inbound/${id}/reprocess`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['agg-inbound'] }) });
  return (
    <div className="space-y-4">
      <ErrorBox error={list.error ?? re.error} />
      <Select className="w-52" value={status} onChange={(e) => setStatus(e.target.value)}>{['', 'NEEDS_MAPPING', 'ERROR', 'REJECTED', 'ACCEPTED', 'CANCELLED', 'RECEIVED'].map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}</Select>
      <Card>
        {list.data?.length === 0 ? <Empty>Nothing here.</Empty> : (
          <Table head={['External id', 'Status', 'Received', 'Problem', 'Payload', '']}>
            {list.data?.map((i) => (
              <tr key={i.id} className="align-top">
                <td className="px-3 py-2 font-medium">{i.externalId}</td>
                <td className="px-3 py-2"><StatusBadge status={i.status} /></td>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(i.receivedAt)}</td>
                <td className="max-w-xs px-3 py-2 text-xs text-red-700">{i.error}{i.error && <div><Link className="text-brand-600 underline" to="/exceptions">Open exceptions</Link></div>}</td>
                <td className="px-3 py-2"><details><summary className="cursor-pointer text-xs text-brand-600">View</summary><pre className="mt-1 max-h-48 max-w-md overflow-auto rounded bg-slate-50 p-2 text-xs">{pretty(i.payload)}</pre></details></td>
                <td className="px-3 py-2 text-end">{!i.orderId && i.status !== 'CANCELLED' && <Button variant="ghost" disabled={re.isPending} onClick={() => re.mutate(i.id)}>Reprocess</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Report() {
  const q = useQuery({ queryKey: ['agg-report'], queryFn: () => api<any>('/aggregators/report') });
  const r = q.data;
  return (
    <div className="space-y-4">
      <ErrorBox error={q.error} />
      {r && (
        <>
          <Card title="Owed by marketplaces (delivered, not yet settled)"><div className="text-2xl font-semibold">{formatJOD(r.receivableFromMarketplaces)}</div></Card>
          <Card title="By marketplace">
            {r.providers.length === 0 ? <Empty>No marketplace orders yet.</Empty> : (
              <Table head={['Provider', 'Orders', 'Delivered', 'Cancelled', 'Gross delivered', 'Settled gross', 'Commission and fees', 'Effective %', 'Net payouts']}>
                {r.providers.map((p: any) => (
                  <tr key={p.provider}>
                    <td className="px-3 py-2 font-medium">{p.provider}</td><td className="px-3 py-2">{p.orders}</td><td className="px-3 py-2">{p.delivered}</td><td className="px-3 py-2">{p.cancelled}</td>
                    <td className="px-3 py-2">{formatJOD(p.grossDelivered)}</td><td className="px-3 py-2">{formatJOD(p.settledGross)}</td><td className="px-3 py-2">{formatJOD(p.commissionAndFees)}</td>
                    <td className="px-3 py-2">{p.effectiveCommissionPct}%</td><td className="px-3 py-2">{formatJOD(p.netPayouts)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

const SAMPLE_ORDER = {
  externalId: 'SIM-1001',
  placedAt: new Date().toISOString(),
  customer: { name: 'Sim Customer', phone: '0790000000' },
  address: { text: 'Test street 1' },
  lines: [{ externalItemId: 'EXT-ITEM-1', name: 'Item', qty: 1, unitPrice: 3.48 }],
  merchantFundedDiscount: 0,
  marketplaceFundedDiscount: 0,
  total: 3.48,
  paymentMethod: 'ONLINE_PREPAID',
};
const SAMPLE_STATEMENT = { reference: 'SIM-WK-1', settlementDate: new Date().toISOString().slice(0, 10), gross: 3.48, fees: 0.87, net: 2.61, lines: [{ reference: 'SIM-1001', amount: 3.48 }] };

function Simulator() {
  const conns = useQuery({ queryKey: ['agg-conns'], queryFn: () => api<any[]>('/aggregators/connections') });
  const [connId, setConnId] = useState('');
  const [order, setOrder] = useState(pretty(SAMPLE_ORDER));
  const [stmt, setStmt] = useState(pretty(SAMPLE_STATEMENT));
  const [msg, setMsg] = useState('');
  const conn = conns.data?.find((c) => c.id === connId);
  const outbox = useQuery({ queryKey: ['agg-outbox'], queryFn: () => api<any[]>('/aggregators/stub/outbox'), retry: false });
  const run = useMutation({
    mutationFn: async (kind: 'order' | 'statement' | 'down' | 'up') => {
      if (kind === 'down' || kind === 'up') return api('/aggregators/stub/outage', { body: { provider: conn.provider, down: kind === 'down' } });
      if (kind === 'order') {
        await api('/aggregators/stub/orders', { body: { provider: conn.provider, storeRef: conn.storeRef, order: JSON.parse(order) } });
        return api(`/aggregators/connections/${conn.id}/poll`, { method: 'POST' });
      }
      return api('/aggregators/stub/statements', { body: { provider: conn.provider, storeRef: conn.storeRef, statement: JSON.parse(stmt) } });
    },
    onSuccess: (r) => { setMsg(pretty(r)); outbox.refetch(); },
  });
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Development simulator. It only works while the backend runs stub adapters (no real marketplace is contacted).</div>
      <ErrorBox error={run.error} />
      <Select className="w-72" value={connId} onChange={(e) => setConnId(e.target.value)}><option value="">Choose a connection...</option>{conns.data?.map((c) => <option key={c.id} value={c.id}>{c.provider} / {c.storeRef}</option>)}</Select>
      {conn && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Inject an order, then poll">
            <textarea className="h-64 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={order} onChange={(e) => setOrder(e.target.value)} />
            <Button className="mt-2" disabled={run.isPending} onClick={() => run.mutate('order')}>Inject and poll</Button>
          </Card>
          <Card title="Inject a settlement statement">
            <textarea className="h-64 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={stmt} onChange={(e) => setStmt(e.target.value)} />
            <Button className="mt-2" disabled={run.isPending} onClick={() => run.mutate('statement')}>Inject statement</Button>
            <span className="ms-2 text-xs text-slate-500">then use "Sync settlements" on Connections</span>
          </Card>
          <Card title="API outage">
            <div className="flex gap-2"><Button variant="danger" onClick={() => run.mutate('down')}>Simulate outage</Button><Button variant="ghost" onClick={() => run.mutate('up')}>Restore</Button></div>
            {msg && <pre className="mt-3 max-h-32 overflow-auto rounded bg-slate-50 p-2 text-xs">{msg}</pre>}
          </Card>
          <Card title="Messages sent to the marketplace (outbox)">
            <Button variant="ghost" onClick={() => outbox.refetch()}>Refresh</Button>
            <ErrorBox error={outbox.error} />
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 text-xs">{pretty(outbox.data ?? [])}</pre>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function Marketplaces() {
  const [tab, setTab] = useState('Connections');
  return (
    <div>
      <PageHeader title="Marketplaces" subtitle="Talabat and Careem stores: connections, menu mapping, inbound orders and payout reconciliation." />
      <Tabs tabs={['Connections', 'Menu mapping', 'Inbound', 'Report', 'Simulator (dev)']} value={tab} onChange={setTab} />
      {tab === 'Connections' && <Connections />}
      {tab === 'Menu mapping' && <Mapping />}
      {tab === 'Inbound' && <Inbound />}
      {tab === 'Report' && <Report />}
      {tab === 'Simulator (dev)' && <Simulator />}
    </div>
  );
}
