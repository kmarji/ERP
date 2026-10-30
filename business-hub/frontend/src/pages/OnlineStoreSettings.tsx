import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select } from '../components/ui';
import { api } from '../lib/api';
import { useList } from '../lib/lookups';

const num = (v: unknown) => (v === '' || v === undefined ? 0 : Number(v));

function Form({ branchId, cfg }: { branchId: string; cfg: any }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ...cfg, deliveryFee: String(cfg.deliveryFee), minOrder: String(cfg.minOrder), serviceAreas: cfg.serviceAreas as string[] });
  const [area, setArea] = useState('');
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: (body: object) => api(`/online-store/${branchId}`, { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['online-store', branchId] }),
  });
  const slug = localStorage.getItem('bh_tenant') ?? '<business>';
  const link = `${location.protocol}//${location.hostname}:5175/${slug}`;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const addArea = () => { const a = area.trim(); if (a && !f.serviceAreas.includes(a)) set('serviceAreas', [...f.serviceAreas, a]); setArea(''); };
  const Check = ({ k, label }: { k: string; label: string }) => <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f[k]} onChange={(e) => set(k, e.target.checked)} />{label}</label>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ enabled: f.enabled, pickupEnabled: f.pickupEnabled, deliveryEnabled: f.deliveryEnabled, deliveryFee: num(f.deliveryFee), minOrder: num(f.minOrder), serviceAreas: f.serviceAreas, prepMinutes: Number(f.prepMinutes), autoAccept: f.autoAccept, scheduledOrdering: f.scheduledOrdering });
  };
  return (
    <div className="space-y-4">
      <ErrorBox error={save.error} />
      <div className={`flex items-center justify-between rounded-xl border-2 p-4 ${cfg.acceptingOrders ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
        <div>
          <div className="text-lg font-semibold">{cfg.acceptingOrders ? 'Accepting online orders' : 'Orders are paused'}</div>
          <div className="text-sm text-slate-600">Pause when the kitchen is overwhelmed; customers see the store as busy.</div>
        </div>
        <Button variant={cfg.acceptingOrders ? 'danger' : 'primary'} disabled={save.isPending} onClick={() => save.mutate({ acceptingOrders: !cfg.acceptingOrders })}>{cfg.acceptingOrders ? 'Pause orders' : 'Resume orders'}</Button>
      </div>
      <Card title="Public storefront link">
        <div className="flex items-center gap-2"><code className="break-all rounded bg-slate-50 px-2 py-1 text-sm">{link}</code>
          <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
          {!cfg.enabled && <Badge tone="MEDIUM">not visible until enabled</Badge>}</div>
        <p className="mt-1 text-xs text-slate-500">Hint only: the storefront app runs on port 5175 in development; adjust the host in production.</p>
      </Card>
      <Card title="Settings">
        <form className="space-y-4" onSubmit={submit}>
          <div className="flex flex-wrap gap-6"><Check k="enabled" label="Online store enabled" /><Check k="pickupEnabled" label="Pickup" /><Check k="deliveryEnabled" label="Delivery" /><Check k="autoAccept" label="Auto-accept orders" /><Check k="scheduledOrdering" label="Scheduled orders" /></div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Delivery fee (JOD)"><Input type="number" step="0.001" min="0" value={f.deliveryFee} onChange={(e) => set('deliveryFee', e.target.value)} /></Field>
            <Field label="Minimum order (JOD)"><Input type="number" step="0.001" min="0" value={f.minOrder} onChange={(e) => set('minOrder', e.target.value)} /></Field>
            <Field label="Preparation time (minutes)"><Input type="number" min="1" value={f.prepMinutes} onChange={(e) => set('prepMinutes', e.target.value)} /></Field>
          </div>
          <Field label="Delivery areas (press Enter to add)">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-300 p-2">
              {f.serviceAreas.map((a: string) => <span key={a} className="rounded-full bg-brand-100 px-2 py-0.5 text-xs">{a} <button type="button" className="ms-1 text-slate-500" onClick={() => set('serviceAreas', f.serviceAreas.filter((x: string) => x !== a))}>x</button></span>)}
              <input className="min-w-[8rem] flex-1 text-sm outline-none" value={area} placeholder="e.g. Abdoun" onChange={(e) => setArea(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addArea(); } }} onBlur={addArea} />
            </div>
          </Field>
          <Button type="submit" disabled={save.isPending}>Save settings</Button>
        </form>
      </Card>
    </div>
  );
}

export default function OnlineStoreSettings() {
  const branches = useList('/org/branches');
  const [branchId, setBranchId] = useState('');
  const cfg = useQuery({ queryKey: ['online-store', branchId], queryFn: () => api<any>(`/online-store/${branchId}`), enabled: !!branchId });
  return (
    <div className="space-y-4">
      <PageHeader title="Online store" subtitle="Direct ordering per branch: what is offered, where it delivers and when to pause." actions={
        <Select className="w-52" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Choose branch...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>} />
      <ErrorBox error={cfg.error} />
      {/* key remounts the form with fresh values after each save */}
      {cfg.data && <Form key={`${branchId}-${JSON.stringify(cfg.data)}`} branchId={branchId} cfg={cfg.data} />}
    </div>
  );
}
