import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

const TABS = ['Counts', 'Wastage', 'Transfers', 'Replenishment', 'Losses'];
const REASONS = ['EXPIRED', 'SPOILED', 'DAMAGED', 'PREP_WASTE', 'OTHER'];

interface Ref { id: string; name?: string; code?: string; sku?: string; baseUnit?: string }

// Names for ids, shared by every tab.
function useRefs() {
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<Ref[]>('/products') });
  const locations = useQuery({ queryKey: ['stock-locations'], queryFn: () => api<Ref[]>('/org/stock-locations') });
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<Ref[]>('/suppliers') });
  const name = (list: Ref[] | undefined, id: string | null | undefined) => {
    const r = list?.find((x) => x.id === id);
    return r ? r.name ?? r.code ?? r.sku : id ? id.slice(0, 8) : '-';
  };
  return {
    products: products.data ?? [],
    locations: locations.data ?? [],
    suppliers: suppliers.data ?? [],
    product: (id?: string | null) => name(products.data, id),
    location: (id?: string | null) => name(locations.data, id),
    supplier: (id?: string | null) => name(suppliers.data, id),
  };
}
type Refs = ReturnType<typeof useRefs>;

const Options = ({ items, label }: { items: Ref[]; label: (r: Ref) => string | undefined }) => (
  <>
    <option value="">Select...</option>
    {items.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
  </>
);

export default function StockOperations() {
  const { t } = useI18n();
  const [tab, setTab] = useState(TABS[0]);
  const refs = useRefs();
  return (
    <div>
      <PageHeader title={t('Stock operations')} subtitle="Physical counts, wastage, transfers and automatic replenishment." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'Counts' && <Counts refs={refs} />}
      {tab === 'Wastage' && <Wastage refs={refs} />}
      {tab === 'Transfers' && <Transfers refs={refs} />}
      {tab === 'Replenishment' && <Replenishment refs={refs} />}
      {tab === 'Losses' && <Losses />}
    </div>
  );
}

// ---------------------------------------------------------------- counts

function Counts({ refs }: { refs: Refs }) {
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [entered, setEntered] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['counts'], queryFn: () => api<any[]>('/inventory/counts') });
  const detail = useQuery({ queryKey: ['count', openId], queryFn: () => api<any>(`/inventory/counts/${openId}`), enabled: !!openId });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['counts'] });
    qc.invalidateQueries({ queryKey: ['count', openId] });
  };
  const create = useMutation({
    mutationFn: () => api<any>('/inventory/counts', { body: { locationId } }),
    onSuccess: (c) => { setOpenId(c.id); setEntered({}); refresh(); },
  });
  const save = useMutation({
    mutationFn: () => api(`/inventory/counts/${openId}/lines`, { method: 'PUT', body: { entries: Object.entries(entered).filter(([, v]) => v !== '').map(([productId, qty]) => ({ productId, qty: Number(qty) })) } }),
    onSuccess: refresh,
  });
  // Saves what was typed, then submits, so nothing entered is lost.
  const submit = useMutation({
    mutationFn: async () => {
      if (Object.values(entered).some((v) => v !== '')) await save.mutateAsync();
      return api(`/inventory/counts/${openId}/submit`, { method: 'POST' });
    },
    onSuccess: refresh,
  });
  const c = detail.data;
  const open = c?.status === 'OPEN';

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Start a count">
          <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Location"><Select value={locationId} onChange={(e) => setLocationId(e.target.value)} required><Options items={refs.locations} label={(l) => l.name} /></Select></Field>
            <Button type="submit" disabled={!locationId || create.isPending}>Start count</Button>
          </form>
        </Card>
        <Card title="Counts">
          <ErrorBox error={list.error ?? create.error} />
          {list.data?.length === 0 ? <Empty>No counts yet.</Empty> : (
            <Table head={['Number', 'Location', 'Status']}>
              {list.data?.map((x) => (
                <tr key={x.id} onClick={() => { setOpenId(x.id); setEntered({}); }} className={`cursor-pointer hover:bg-slate-50 ${openId === x.id ? 'bg-brand-50' : ''}`}>
                  <td className="px-3 py-2 font-medium">{x.number}</td>
                  <td className="px-3 py-2">{refs.location(x.locationId)}</td>
                  <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card className="lg:col-span-3" title={c ? `Count ${c.number}` : 'Count'}>
        <ErrorBox error={detail.error ?? save.error ?? submit.error} />
        {!c ? <Empty>Select or start a count.</Empty> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm"><StatusBadge status={c.status} /><span className="text-slate-500">{refs.location(c.locationId)}</span></div>
            {c.status === 'PENDING_APPROVAL' && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                The variance is above the auto limit. Stock is unchanged until a delegated approver decides on the <Link className="underline" to="/approvals">Approvals</Link> screen.
              </p>
            )}
            {c.status === 'APPLIED' && <p className="text-xs text-slate-500">Applied {formatDate(c.appliedAt)}. Stock and ledger were adjusted together.</p>}
            <Table head={open ? ['Product', 'Counted (base unit)'] : ['Product', 'Expected', 'Counted', 'Variance', 'Value']}>
              {c.lines.map((l: any) => (
                <tr key={l.id}>
                  <td className="px-3 py-2">{refs.product(l.productId)} <span className="text-xs text-slate-400">{refs.products.find((p) => p.id === l.productId)?.baseUnit}</span></td>
                  {open ? (
                    // Blind count: expected quantity is deliberately not shown while counting.
                    <td className="px-3 py-2"><Input className="w-32" type="number" step="0.0001" min="0" placeholder={l.countedQtyBase ?? ''} value={entered[l.productId] ?? ''} onChange={(e) => setEntered({ ...entered, [l.productId]: e.target.value })} /></td>
                  ) : (
                    <>
                      <td className="px-3 py-2">{l.expectedQtyBase ?? '-'}</td>
                      <td className="px-3 py-2">{l.countedQtyBase ?? '-'}</td>
                      <td className={`px-3 py-2 ${Number(l.varianceQty) < 0 ? 'text-red-600' : ''}`}>{l.varianceQty ?? '-'}</td>
                      <td className="px-3 py-2">{l.varianceValue !== null ? formatJOD(l.varianceValue) : '-'}</td>
                    </>
                  )}
                </tr>
              ))}
            </Table>
            {open && (
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
                <Button onClick={() => submit.mutate()} disabled={submit.isPending}>Submit count</Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- wastage

function Wastage({ refs }: { refs: Refs }) {
  const qc = useQueryClient();
  const blank = { locationId: '', productId: '', qty: '', unit: '', reason: 'SPOILED', notes: '' };
  const [f, setF] = useState(blank);
  const list = useQuery({ queryKey: ['wastage'], queryFn: () => api<any[]>('/inventory/wastage') });
  const record = useMutation({
    mutationFn: () => api('/inventory/wastage', { body: { locationId: f.locationId, productId: f.productId, qty: Number(f.qty), unit: f.unit || undefined, reason: f.reason, notes: f.notes || undefined } }),
    onSuccess: () => { setF(blank); qc.invalidateQueries({ queryKey: ['wastage'] }); },
  });
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Record wastage">
        <ErrorBox error={record.error} />
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); record.mutate(); }}>
          <Field label="Location"><Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} required><Options items={refs.locations} label={(l) => l.name} /></Select></Field>
          <Field label="Product"><Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} required><Options items={refs.products} label={(p) => `${p.sku} ${p.name}`} /></Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Quantity"><Input type="number" step="0.0001" min="0" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} required /></Field>
            <Field label="Unit (blank = base)"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{REASONS.map((r) => <option key={r}>{r}</option>)}</Select></Field>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <Button type="submit" disabled={record.isPending}>Record</Button>
          <p className="text-xs text-slate-400">Wastage is posted immediately; unusual amounts are also flagged for review.</p>
        </form>
      </Card>
      <Card className="lg:col-span-2" title="Wastage log">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No wastage recorded.</Empty> : (
          <Table head={['When', 'Location', 'Product', 'Qty (base)', 'Reason', 'Value', 'Status']}>
            {list.data?.map((w) => (
              <tr key={w.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(w.createdAt)}</td>
                <td className="px-3 py-2">{refs.location(w.locationId)}</td>
                <td className="px-3 py-2">{refs.product(w.productId)}</td>
                <td className="px-3 py-2">{w.qtyBase}</td>
                <td className="px-3 py-2">{w.reason}</td>
                <td className="px-3 py-2">{formatJOD(w.value)}</td>
                <td className="px-3 py-2"><StatusBadge status={w.status} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- transfers

function Transfers({ refs }: { refs: Refs }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState([{ productId: '', qty: '', unit: '' }]);
  const list = useQuery({ queryKey: ['transfers'], queryFn: () => api<any[]>('/inventory/transfers') });
  const create = useMutation({
    mutationFn: () => api('/inventory/transfers', { body: { fromLocationId: from, toLocationId: to, lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty), unit: l.unit || undefined })) } }),
    onSuccess: () => { setLines([{ productId: '', qty: '', unit: '' }]); qc.invalidateQueries({ queryKey: ['transfers'] }); },
  });
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="New transfer">
        <ErrorBox error={create.error} />
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="From"><Select value={from} onChange={(e) => setFrom(e.target.value)} required><Options items={refs.locations} label={(l) => l.name} /></Select></Field>
          <Field label="To"><Select value={to} onChange={(e) => setTo(e.target.value)} required><Options items={refs.locations} label={(l) => l.name} /></Select></Field>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-5 gap-2">
              <Select className="col-span-2" value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })} required><Options items={refs.products} label={(p) => p.sku} /></Select>
              <Input type="number" step="0.0001" min="0" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} required />
              <Input placeholder="Unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
              <button type="button" className="text-xs text-red-600 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setLines([...lines, { productId: '', qty: '', unit: '' }])}>Add line</Button>
            <Button type="submit" disabled={create.isPending}>Transfer</Button>
          </div>
        </form>
      </Card>
      <Card className="lg:col-span-2" title="Transfers">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No transfers yet.</Empty> : (
          <Table head={['Number', 'When', 'From', 'To', 'Lines', 'Value']}>
            {list.data?.map((x) => (
              <tr key={x.id}>
                <td className="px-3 py-2 font-medium">{x.number}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(x.createdAt)}</td>
                <td className="px-3 py-2">{refs.location(x.fromLocationId)}</td>
                <td className="px-3 py-2">{refs.location(x.toLocationId)}</td>
                <td className="px-3 py-2 text-xs">{x.lines.map((l: any) => `${refs.product(l.productId)} ${l.qtyBase}`).join(', ')}</td>
                <td className="px-3 py-2">{formatJOD(x.lines.reduce((s: number, l: any) => s + Number(l.value), 0))}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- replenishment

function Replenishment({ refs }: { refs: Refs }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ productId: '', locationId: '', minQtyBase: '', maxQtyBase: '', leadTimeDays: '2', supplierId: '', orderUnit: '' });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<any[]>('/replenishment/rules') });
  const save = useMutation({
    mutationFn: () => api('/replenishment/rules', { body: { productId: f.productId, locationId: f.locationId, minQtyBase: Number(f.minQtyBase), maxQtyBase: Number(f.maxQtyBase), leadTimeDays: Number(f.leadTimeDays), supplierId: f.supplierId || undefined, orderUnit: f.orderUnit || undefined } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const preview = useMutation({ mutationFn: () => api<any>('/replenishment/run?dryRun=true', { method: 'POST' }) });
  const run = useMutation({
    mutationFn: () => api<any>('/replenishment/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules'] });
      qc.invalidateQueries({ queryKey: ['po-list'] });
    },
  });
  const result = run.data ?? preview.data;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Add or update a rule">
          <ErrorBox error={save.error} />
          <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
            <Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} required><Options items={refs.products} label={(p) => `${p.sku} ${p.name}`} /></Select>
            <Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} required><Options items={refs.locations} label={(l) => l.name} /></Select>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Min (base)"><Input type="number" step="0.0001" min="0" value={f.minQtyBase} onChange={(e) => setF({ ...f, minQtyBase: e.target.value })} required /></Field>
              <Field label="Par (base)"><Input type="number" step="0.0001" min="0" value={f.maxQtyBase} onChange={(e) => setF({ ...f, maxQtyBase: e.target.value })} required /></Field>
              <Field label="Lead days"><Input type="number" min="0" value={f.leadTimeDays} onChange={(e) => setF({ ...f, leadTimeDays: e.target.value })} /></Field>
            </div>
            <Field label="Supplier (blank = preferred)"><Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><Options items={refs.suppliers} label={(s) => s.name} /></Select></Field>
            <Field label="Order unit (blank = supplier unit)"><Input value={f.orderUnit} onChange={(e) => setF({ ...f, orderUnit: e.target.value })} /></Field>
            <Button type="submit" disabled={save.isPending}>Save rule</Button>
          </form>
        </Card>
        <Card className="lg:col-span-2" title="Rules">
          <ErrorBox error={rules.error} />
          {rules.data?.length === 0 ? <Empty>No replenishment rules.</Empty> : (
            <Table head={['Product', 'Location', 'Min', 'Par', 'Lead', 'Supplier', 'Active']}>
              {rules.data?.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">{refs.product(r.productId)}</td>
                  <td className="px-3 py-2">{refs.location(r.locationId)}</td>
                  <td className="px-3 py-2">{r.minQtyBase}</td>
                  <td className="px-3 py-2">{r.maxQtyBase}</td>
                  <td className="px-3 py-2">{r.leadTimeDays}d</td>
                  <td className="px-3 py-2">{r.supplierId ? refs.supplier(r.supplierId) : 'preferred'}</td>
                  <td className="px-3 py-2">{r.active ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Suggestions">
        <ErrorBox error={preview.error ?? run.error} />
        <div className="mb-4 flex gap-2">
          <Button variant="ghost" onClick={() => { run.reset(); preview.mutate(); }} disabled={preview.isPending}>Preview suggestions</Button>
          <Button onClick={() => { preview.reset(); run.mutate(); }} disabled={run.isPending}>Create requests now</Button>
        </div>
        {!result ? <Empty>Preview what the rules would order, or create the purchase requests.</Empty> : (
          <div className="space-y-4">
            {result.suggestions.length === 0 ? <Empty>Everything is above its reorder point or already on order.</Empty> : (
              <Table head={['Product', 'Location', 'On hand', 'On order', 'Daily use', 'Reorder at', 'Suggest', 'Supplier']}>
                {result.suggestions.map((s: any) => (
                  <tr key={s.ruleId}>
                    <td className="px-3 py-2">{refs.product(s.productId)}</td>
                    <td className="px-3 py-2">{refs.location(s.locationId)}</td>
                    <td className="px-3 py-2">{s.onHandBase}</td>
                    <td className="px-3 py-2">{s.onOrderBase}</td>
                    <td className="px-3 py-2">{s.dailyUsageBase}</td>
                    <td className="px-3 py-2">{s.reorderPointBase}</td>
                    <td className="px-3 py-2">{s.orderQty ? `${s.orderQty} ${s.orderUnit}` : `${s.suggestedBase} (base)`}</td>
                    <td className="px-3 py-2">{s.problem === 'NO_SUPPLIER' ? <span className="text-red-600">No supplier: raised for procurement</span> : refs.supplier(s.supplierId)}</td>
                  </tr>
                ))}
              </Table>
            )}
            {result.requests.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Purchase requests created</div>
                <ul className="space-y-1 text-sm">
                  {result.requests.map((r: any) => {
                    const pr = r.request ?? r; // auto-approved requests come back as { request, orders }
                    return (
                      <li key={pr.id} className="flex items-center gap-2">
                        <span className="font-medium">{pr.number}</span><StatusBadge status={pr.status} />
                        {pr.status === 'PENDING_APPROVAL' && <Link className="text-xs text-brand-600 underline" to="/approvals">needs approval</Link>}
                        {r.orders?.length > 0 && <span className="text-xs text-slate-500">PO {r.orders.map((o: any) => o.number).join(', ')}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- losses

function Losses() {
  const { lang } = useI18n();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = new URLSearchParams({ ...(from && { from }), ...(to && { to }) }).toString();
  const report = useQuery({ queryKey: ['losses', q], queryFn: () => api<any>(`/inventory/reports/losses?${q}`) });
  return (
    <Card title="Stock losses">
      <ErrorBox error={report.error} />
      <div className="mb-4 flex gap-3">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {report.data && (
        <>
          <div className="mb-3 text-2xl font-semibold text-red-600">{formatJOD(report.data.totalLossValue, lang)}<span className="ms-2 text-xs font-normal text-slate-500">total loss at cost</span></div>
          {report.data.items.length === 0 ? <Empty>No wastage or count shrinkage in this period.</Empty> : (
            <Table head={['Product', 'Type', 'Qty (base)', 'Value']}>
              {report.data.items.map((i: any) => (
                <tr key={`${i.productId}-${i.type}`}>
                  <td className="px-3 py-2">{i.sku} {i.name}</td>
                  <td className="px-3 py-2">{i.type.replace(/_/g, ' ')}</td>
                  <td className="px-3 py-2">{i.qtyBase}</td>
                  <td className="px-3 py-2">{formatJOD(i.value, lang)}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Card>
  );
}
