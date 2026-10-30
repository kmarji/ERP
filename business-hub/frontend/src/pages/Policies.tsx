import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Table, TierBadge } from '../components/ui';
import { api } from '../lib/api';
import { formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Policies() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => api<any[]>('/policies') });
  const limits = useQuery({ queryKey: ['limits'], queryFn: () => api<any[]>('/policies/limits') });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['policies'] });
    qc.invalidateQueries({ queryKey: ['limits'] });
  };

  const [pol, setPol] = useState({ key: '', riskTier: 'MEDIUM', rules: '{\n  "maxAutoAmount": 100\n}' });
  const createPolicy = useMutation({
    mutationFn: () => api('/policies', { body: { key: pol.key, riskTier: pol.riskTier, rules: JSON.parse(pol.rules) } }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (v: { key: string; version: number | null }) =>
      api(v.version === null ? `/policies/${v.key}/deactivate` : `/policies/${v.key}/activate/${v.version}`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const [lim, setLim] = useState({ policyKey: '', roleKey: 'BRANCH_MANAGER', maxAmount: '' });
  const addLimit = useMutation({
    mutationFn: () => api('/policies/limits', { body: { ...lim, maxAmount: Number(lim.maxAmount) } }),
    onSuccess: refresh,
  });
  const removeLimit = useMutation({ mutationFn: (id: string) => api(`/policies/limits/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  const [ev, setEv] = useState({ policyKey: '', amount: '' });
  const evaluate = useMutation({ mutationFn: () => api('/policies/evaluate', { body: { policyKey: ev.policyKey, amount: ev.amount ? Number(ev.amount) : undefined } }) });

  return (
    <div className="space-y-6">
      <PageHeader title={t('Policies')} subtitle="Versioned automation policies and approval limits. Roll back by activating an older version." />
      <ErrorBox error={createPolicy.error ?? toggle.error ?? addLimit.error ?? removeLimit.error} />

      <Card title="Policies">
        <Table head={['Key', 'Version', 'Tier', 'Rules', 'Status', '']}>
          {policies.data?.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 font-medium">{p.key}</td>
              <td className="px-3 py-2">v{p.version}</td>
              <td className="px-3 py-2"><TierBadge tier={p.riskTier} /></td>
              <td className="px-3 py-2 font-mono text-xs text-slate-500">{JSON.stringify(p.rules)}</td>
              <td className="px-3 py-2">{p.active ? <Badge tone="bg-emerald-100 text-emerald-800">active</Badge> : <Badge>inactive</Badge>}</td>
              <td className="px-3 py-2 text-end">
                {p.active
                  ? <Button variant="ghost" onClick={() => toggle.mutate({ key: p.key, version: null })}>Deactivate</Button>
                  : <Button variant="ghost" onClick={() => toggle.mutate({ key: p.key, version: p.version })}>Activate</Button>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="New policy version">
          <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); createPolicy.mutate(); }}>
            <Field label="Key (e.g. purchase_order.issue)"><Input value={pol.key} onChange={(e) => setPol({ ...pol, key: e.target.value })} required /></Field>
            <Field label="Risk tier">
              <Select value={pol.riskTier} onChange={(e) => setPol({ ...pol, riskTier: e.target.value })}>
                {['LOW', 'MEDIUM', 'HIGH', 'REGULATED'].map((x) => <option key={x}>{x}</option>)}
              </Select>
            </Field>
            <Field label="Rules (JSON: maxAutoAmount, maxVariancePct, minConfidence, blocked)">
              <textarea className="h-24 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={pol.rules} onChange={(e) => setPol({ ...pol, rules: e.target.value })} />
            </Field>
            <Button type="submit">Create version</Button>
          </form>
        </Card>

        <Card title="Approval limits">
          <ul className="mb-3 space-y-1 text-sm">
            {limits.data?.map((l) => (
              <li key={l.id} className="flex items-center justify-between">
                <span>{l.policyKey}: <b>{l.roleKey}</b> up to {formatJOD(l.maxAmount, lang)}</span>
                <button className="text-xs text-red-600" onClick={() => removeLimit.mutate(l.id)}>remove</button>
              </li>
            ))}
          </ul>
          <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); addLimit.mutate(); }}>
            <Input placeholder="Policy key" value={lim.policyKey} onChange={(e) => setLim({ ...lim, policyKey: e.target.value })} required />
            <Select value={lim.roleKey} onChange={(e) => setLim({ ...lim, roleKey: e.target.value })}>
              {['PROCUREMENT', 'BRANCH_MANAGER', 'HR', 'FINANCE'].map((x) => <option key={x}>{x}</option>)}
            </Select>
            <Input type="number" step="0.001" placeholder="Max amount (JOD)" value={lim.maxAmount} onChange={(e) => setLim({ ...lim, maxAmount: e.target.value })} required />
            <Button type="submit">Add limit</Button>
          </form>
        </Card>

        <Card title="Test a decision">
          <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); evaluate.mutate(); }}>
            <Input placeholder="Policy key" value={ev.policyKey} onChange={(e) => setEv({ ...ev, policyKey: e.target.value })} required />
            <Input type="number" step="0.001" placeholder="Amount (JOD)" value={ev.amount} onChange={(e) => setEv({ ...ev, amount: e.target.value })} />
            <Button type="submit" variant="ghost">Evaluate</Button>
          </form>
          {evaluate.data && <pre className="mt-3 rounded bg-slate-50 p-2 text-xs">{JSON.stringify(evaluate.data, null, 2)}</pre>}
        </Card>
      </div>
    </div>
  );
}
