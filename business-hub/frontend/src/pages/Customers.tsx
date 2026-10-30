import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useList } from '../lib/lookups';

const TABS = ['Customers', 'Vouchers', 'Gift cards', 'Floor plans'];

export default function Customers() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <div className="space-y-4">
      <PageHeader title="Customers" subtitle="Profiles exist only with explicit consent and can be erased. Vouchers, gift cards and floor plans live here too." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'Customers' && <People />}
      {tab === 'Vouchers' && <Vouchers />}
      {tab === 'Gift cards' && <GiftCards />}
      {tab === 'Floor plans' && <Floor />}
    </div>
  );
}

function People() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['customers', q], queryFn: () => api<any[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const [sel, setSel] = useState('');
  const loyalty = useQuery({ queryKey: ['loyalty', sel], queryFn: () => api<any[]>(`/customers/${sel}/loyalty`), enabled: !!sel });
  const refresh = () => qc.invalidateQueries({ queryKey: ['customers'] });
  const [f, setF] = useState({ name: '', phone: '', email: '', consent: false, marketingConsent: false });
  const create = useMutation({
    mutationFn: () => api('/customers', { body: { name: f.name, phone: f.phone || undefined, email: f.email || undefined, consent: f.consent, marketingConsent: f.marketingConsent } }),
    onSuccess: () => { setF({ name: '', phone: '', email: '', consent: false, marketingConsent: false }); refresh(); },
  });
  const erase = useMutation({ mutationFn: (id: string) => api(`/customers/${id}`, { method: 'DELETE' }), onSuccess: () => { setSel(''); refresh(); } });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <ErrorBox error={list.error ?? create.error ?? erase.error} />
        <Card>
          <Input className="mb-3 max-w-xs" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.data?.length === 0 ? <Empty>No customers.</Empty> : (
            <Table head={['Name', 'Phone', 'Points', 'Marketing', '']}>
              {list.data?.map((c) => (
                <tr key={c.id} onClick={() => setSel(c.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === c.id ? 'bg-brand-50' : ''}`}>
                  <td className="px-3 py-2 font-medium">{c.name}</td><td className="px-3 py-2">{c.phone ?? '-'}</td><td className="px-3 py-2">{c.points}</td>
                  <td className="px-3 py-2">{c.marketingConsent ? <Badge tone="bg-emerald-100 text-emerald-800">opted in</Badge> : <Badge>no</Badge>}</td>
                  <td className="px-3 py-2"><Button variant="danger" onClick={(e) => { e.stopPropagation(); if (confirm(`Erase ${c.name}? Name, phone and email are removed permanently.`)) erase.mutate(c.id); }}>Erase</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="New customer">
          <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
              <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />The customer explicitly consents to us storing their profile (required)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} />The customer also consents to marketing messages</label>
            <Button type="submit" disabled={!f.consent}>Create customer</Button>
          </form>
        </Card>
      </div>
      <Card className="lg:col-span-2" title="Loyalty history">
        {!sel ? <Empty>Select a customer.</Empty> : loyalty.data?.length === 0 ? <Empty>No loyalty activity.</Empty> : (
          <Table head={['When', 'Reason', 'Points']}>
            {loyalty.data?.map((t) => <tr key={t.id}><td className="px-3 py-2 text-xs text-slate-500">{formatDate(t.createdAt)}</td><td className="px-3 py-2">{t.reason}</td><td className={`px-3 py-2 ${t.points < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{t.points > 0 ? '+' : ''}{t.points}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Vouchers() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['vouchers'], queryFn: () => api<any[]>('/vouchers') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['vouchers'] });
  const [f, setF] = useState({ code: '', kind: 'PERCENT', value: '', minSubtotal: '', maxUses: '', validFrom: '', validTo: '' });
  const create = useMutation({
    mutationFn: () => api('/vouchers', { body: { code: f.code, kind: f.kind, value: Number(f.value), minSubtotal: f.minSubtotal ? Number(f.minSubtotal) : undefined, maxUses: f.maxUses ? Number(f.maxUses) : undefined, validFrom: f.validFrom || undefined, validTo: f.validTo || undefined } }),
    onSuccess: () => { setF({ ...f, code: '', value: '' }); refresh(); },
  });
  const toggle = useMutation({ mutationFn: (v: { id: string; active: boolean }) => api(`/vouchers/${v.id}`, { method: 'PATCH', body: { active: v.active } }), onSuccess: refresh });
  return (
    <div className="space-y-6">
      <ErrorBox error={list.error ?? create.error ?? toggle.error} />
      <Card>
        {list.data?.length === 0 ? <Empty>No vouchers.</Empty> : (
          <Table head={['Code', 'Discount', 'Min spend', 'Used', 'Valid', 'Status', '']}>
            {list.data?.map((v) => (
              <tr key={v.id}>
                <td className="px-3 py-2 font-mono font-medium">{v.code}</td>
                <td className="px-3 py-2">{v.kind === 'PERCENT' ? `${Number(v.value)}%` : formatJOD(v.value, lang)}</td>
                <td className="px-3 py-2">{Number(v.minSubtotal) > 0 ? formatJOD(v.minSubtotal, lang) : '-'}</td>
                <td className="px-3 py-2">{v.usedCount}{v.maxUses ? ` / ${v.maxUses}` : ''}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{v.validFrom ? formatDate(v.validFrom) : 'any'} - {v.validTo ? formatDate(v.validTo) : 'any'}</td>
                <td className="px-3 py-2">{v.active ? <Badge tone="bg-emerald-100 text-emerald-800">active</Badge> : <Badge>inactive</Badge>}</td>
                <td className="px-3 py-2"><Button variant="ghost" onClick={() => toggle.mutate({ id: v.id, active: !v.active })}>{v.active ? 'Deactivate' : 'Activate'}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="New voucher">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></Field>
          <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PERCENT">Percent</option><option value="AMOUNT">Amount (JOD)</option></Select></Field>
          <Field label="Value"><Input type="number" step="0.001" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required /></Field>
          <Field label="Min spend (JOD)"><Input type="number" step="0.001" value={f.minSubtotal} onChange={(e) => setF({ ...f, minSubtotal: e.target.value })} /></Field>
          <Field label="Max uses"><Input type="number" min="1" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></Field>
          <Field label="Valid from"><Input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></Field>
          <Field label="Valid to"><Input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></Field>
          <div className="mt-5"><Button type="submit">Create voucher</Button></div>
        </form>
      </Card>
    </div>
  );
}

function GiftCards() {
  const { lang } = useI18n();
  const [issue, setIssue] = useState({ amount: '', method: 'CASH' });
  const [issued, setIssued] = useState<any>(null);
  const create = useMutation({ mutationFn: () => api('/pos/gift-cards', { body: { amount: Number(issue.amount), method: issue.method } }), onSuccess: (c) => { setIssued(c); setIssue({ ...issue, amount: '' }); } });
  const [code, setCode] = useState('');
  const [card, setCard] = useState<any>(null);
  const lookup = useMutation({ mutationFn: () => api<any>(`/pos/gift-cards/${encodeURIComponent(code.trim())}`), onSuccess: setCard });
  const voidCard = useMutation({ mutationFn: () => api<any>(`/pos/gift-cards/${encodeURIComponent(card.code)}/void`, { method: 'POST' }), onSuccess: (c) => setCard({ code: c.code, balance: c.balance, status: c.status }) });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ErrorBox error={create.error ?? lookup.error ?? voidCard.error} />
      <Card title="Issue a gift card">
        <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <p className="text-xs text-slate-500">Cash sales need an open shift for your user. The amount is held as a liability until redeemed.</p>
          <Field label="Amount (JOD)"><Input type="number" step="0.001" value={issue.amount} onChange={(e) => setIssue({ ...issue, amount: e.target.value })} required /></Field>
          <Field label="Paid by"><Select value={issue.method} onChange={(e) => setIssue({ ...issue, method: e.target.value })}><option>CASH</option><option>CARD</option></Select></Field>
          <Button type="submit">Issue</Button>
        </form>
        {issued && <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm">Issued <code className="font-mono font-semibold">{issued.code}</code> for {formatJOD(issued.initialAmount, lang)}</div>}
      </Card>
      <Card title="Look up a card">
        <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); lookup.mutate(); }}>
          <Input placeholder="Gift card code" value={code} onChange={(e) => setCode(e.target.value)} required /><Button type="submit">Check</Button>
        </form>
        {card && (
          <div className="mt-4 space-y-2 text-sm">
            <div><code className="font-mono font-semibold">{card.code}</code> <StatusBadge status={card.status} /></div>
            <div>Balance: <b>{formatJOD(card.balance, lang)}</b></div>
            {card.status !== 'VOID' && <Button variant="danger" onClick={() => { if (confirm('Void this card? Finance/owner only; the liability stays until adjusted manually.')) voidCard.mutate(); }}>Void card</Button>}
          </div>
        )}
      </Card>
    </div>
  );
}

function Floor() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const [branchId, setBranchId] = useState('');
  const plans = useQuery({ queryKey: ['floor-plans', branchId], queryFn: () => api<any[]>(`/floor/plans?branchId=${branchId}`), enabled: !!branchId });
  const refresh = () => qc.invalidateQueries({ queryKey: ['floor-plans'] });
  const [name, setName] = useState('');
  const addPlan = useMutation({ mutationFn: () => api('/floor/plans', { body: { branchId, name } }), onSuccess: () => { setName(''); refresh(); } });
  const [t, setT] = useState<Record<string, { name: string; seats: string }>>({});
  const addTable = useMutation({ mutationFn: (id: string) => api(`/floor/plans/${id}/tables`, { body: { name: t[id].name, seats: Number(t[id].seats || 4) } }), onSuccess: refresh });
  const removeTable = useMutation({ mutationFn: (id: string) => api(`/floor/tables/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  return (
    <div className="space-y-6">
      <ErrorBox error={plans.error ?? addPlan.error ?? addTable.error ?? removeTable.error} />
      <Card><div className="max-w-xs"><Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Choose...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field></div></Card>
      {branchId && (
        <>
          {plans.data?.length === 0 && <Empty>No floor plans for this branch yet.</Empty>}
          {plans.data?.map((p) => (
            <Card key={p.id} title={p.name}>
              <div className="mb-3 flex flex-wrap gap-2">
                {p.tables.map((x: any) => <span key={x.id} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1 text-sm">{x.name} <span className="text-xs text-slate-400">{x.seats} seats</span><button className="text-xs text-red-600" onClick={() => removeTable.mutate(x.id)}>remove</button></span>)}
                {p.tables.length === 0 && <span className="text-sm text-slate-400">No tables.</span>}
              </div>
              <div className="flex gap-2">
                <Input className="w-40" placeholder="Table name" value={t[p.id]?.name ?? ''} onChange={(e) => setT({ ...t, [p.id]: { name: e.target.value, seats: t[p.id]?.seats ?? '4' } })} />
                <Input className="w-24" type="number" min="1" placeholder="Seats" value={t[p.id]?.seats ?? '4'} onChange={(e) => setT({ ...t, [p.id]: { name: t[p.id]?.name ?? '', seats: e.target.value } })} />
                <Button variant="ghost" disabled={!t[p.id]?.name} onClick={() => addTable.mutate(p.id)}>Add table</Button>
              </div>
            </Card>
          ))}
          <Card title="New floor plan"><form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); addPlan.mutate(); }}><Input placeholder="e.g. Main hall" value={name} onChange={(e) => setName(e.target.value)} required /><Button type="submit">Add plan</Button></form></Card>
        </>
      )}
    </div>
  );
}
