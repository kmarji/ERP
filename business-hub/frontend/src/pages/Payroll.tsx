import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Payroll() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Runs');
  return (
    <div>
      <PageHeader title={t('Payroll')} subtitle="Monthly runs, the statutory rules they use, advances, one-off adjustments and statutory payments." />
      <Tabs tabs={['Runs', 'Rules', 'Advances', 'Adjustments', 'Obligations']} value={tab} onChange={setTab} />
      {tab === 'Runs' ? <Runs /> : tab === 'Rules' ? <Rules /> : tab === 'Advances' ? <Advances /> : tab === 'Adjustments' ? <Adjustments /> : <Obligations />}
    </div>
  );
}

// Money amounts come back as strings; JSON from the API may also carry plain numbers.
const useLang = () => useI18n().lang;

function Runs() {
  const lang = useLang();
  const qc = useQueryClient();
  const entities = useList('/org/legal-entities');
  const list = useQuery({ queryKey: ['payroll-runs'], queryFn: () => api<any[]>('/payroll/runs') });
  const [f, setF] = useState({ legalEntityId: '', periodStart: '', periodEnd: '' });
  const create = useMutation({ mutationFn: () => api('/payroll/runs', { body: f }), onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-runs'] }) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No payroll runs.</Empty> : (
          <Table head={['No.', 'Period', 'Status', 'Net', 'Rules']}>
            {list.data?.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-medium"><Link className="underline" to={`/payroll/runs/${r.id}`}>{r.number}</Link></td>
                <td className="px-3 py-2 text-xs">{formatDate(r.periodStart).split(',')[0]} - {formatDate(r.periodEnd).split(',')[0]}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2">{r.totals?.net ? formatJOD(r.totals.net, lang) : '-'}</td>
                <td className="px-3 py-2 text-xs">v{r.ruleVersion}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="New run" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Legal entity"><Select required value={f.legalEntityId} onChange={(e) => setF({ ...f, legalEntityId: e.target.value })}><option value="">Select...</option>{entities.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Period start"><Input type="date" required value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} /></Field>
            <Field label="Period end"><Input type="date" required value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} /></Field>
          </div>
          <Button disabled={create.isPending}>Create run</Button>
        </form>
      </Card>
    </div>
  );
}

function Rules() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['payroll-rules'], queryFn: () => api<any[]>('/payroll/rules') });
  const [f, setF] = useState({ effectiveFrom: '', notes: '', rules: '{\n  \n}' });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['payroll-rules'] });
  const create = useMutation({
    mutationFn: () => {
      let rules: unknown;
      try { rules = JSON.parse(f.rules); } catch { throw new Error('Rules must be valid JSON'); }
      return api('/payroll/rules', { body: { effectiveFrom: f.effectiveFrom, notes: f.notes || undefined, rules } });
    },
    onSuccess: refresh,
  });
  const activate = useMutation({ mutationFn: (id: string) => api(`/payroll/rules/${id}/activate`, { method: 'POST' }), onSuccess: refresh });
  const verify = useMutation({ mutationFn: (id: string) => api(`/payroll/rules/${id}/verify`, { body: { note: notes[id] } }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? activate.error ?? verify.error} />
        <p className="mb-3 rounded bg-amber-50 p-2 text-xs text-amber-800">Shipped rule values are placeholders. Payroll cannot be finalized until a finance user verifies the rule set against the current statutory rates.</p>
        {list.data?.length === 0 ? <Empty>No rule sets.</Empty> : (
          <Table head={['Ver.', 'Effective', 'Status', 'Verified', '']}>
            {list.data?.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-medium">v{r.version}</td>
                <td className="px-3 py-2 text-xs">{formatDate(r.effectiveFrom).split(',')[0]}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-xs">{r.verifiedAt ? <Badge tone="bg-emerald-100 text-emerald-800">{formatDate(r.verifiedAt)}</Badge> : <Badge tone="bg-red-100 text-red-800">UNVERIFIED</Badge>}{r.verificationNote && <div className="text-slate-500">{r.verificationNote}</div>}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {!r.verifiedAt && <><Input className="w-32" placeholder="Verification note" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} /><Button variant="ghost" disabled={(notes[r.id] ?? '').length < 5} onClick={() => verify.mutate(r.id)}>Verify</Button></>}
                    {r.status === 'DRAFT' && <Button onClick={() => activate.mutate(r.id)}>Activate</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="New rule set (draft)" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Effective from"><Input type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="Rules (JSON)"><textarea className="h-40 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" value={f.rules} onChange={(e) => setF({ ...f, rules: e.target.value })} /></Field>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Create</Button>
        </form>
      </Card>
    </div>
  );
}

function Advances() {
  const lang = useLang();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const list = useQuery({ queryKey: ['advances'], queryFn: () => api<any[]>('/payroll/advances') });
  const [f, setF] = useState({ employeeId: '', amount: '', installments: '1', reason: '' });
  const create = useMutation({ mutationFn: () => api('/payroll/advances', { body: { employeeId: f.employeeId, amount: Number(f.amount), installments: Number(f.installments), reason: f.reason || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['advances'] }) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No advances.</Empty> : (
          <Table head={['Employee', 'Amount', 'Installments', 'Remaining', 'Status']}>
            {list.data?.map((a) => <tr key={a.id}><td className="px-3 py-2 font-medium">{nameOf(emps.data, a.employeeId)}</td><td className="px-3 py-2">{formatJOD(a.amount, lang)}</td><td className="px-3 py-2">{a.installments} x {formatJOD(a.installmentAmount, lang)}</td><td className="px-3 py-2">{formatJOD(a.remaining, lang)}</td><td className="px-3 py-2"><StatusBadge status={a.status} /></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Issue advance" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Amount (JOD)"><Input type="number" step="0.001" min="0.001" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Installments"><Input type="number" min={1} max={36} required value={f.installments} onChange={(e) => setF({ ...f, installments: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Issue</Button>
        </form>
      </Card>
    </div>
  );
}

function Adjustments() {
  const lang = useLang();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const list = useQuery({ queryKey: ['adjustments'], queryFn: () => api<any[]>('/payroll/adjustments') });
  const [f, setF] = useState({ employeeId: '', kind: 'EARNING', label: '', amount: '' });
  const create = useMutation({ mutationFn: () => api('/payroll/adjustments', { body: { ...f, amount: Number(f.amount) } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['adjustments'] }) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No adjustments.</Empty> : (
          <Table head={['Employee', 'Kind', 'Label', 'Amount', 'Applied']}>
            {list.data?.map((a) => <tr key={a.id}><td className="px-3 py-2 font-medium">{nameOf(emps.data, a.employeeId)}</td><td className="px-3 py-2">{a.kind}</td><td className="px-3 py-2">{a.label}</td><td className="px-3 py-2">{formatJOD(a.amount, lang)}</td><td className="px-3 py-2">{a.appliedRunId ? 'Yes' : 'Pending'}</td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Add adjustment" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option>EARNING</option><option>DEDUCTION</option></Select></Field>
            <Field label="Amount (JOD)"><Input type="number" step="0.001" min="0.001" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          </div>
          <Field label="Label"><Input required minLength={2} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Add</Button>
          <p className="text-xs text-slate-500">Picked up by the next payroll calculation.</p>
        </form>
      </Card>
    </div>
  );
}

function Obligations() {
  const lang = useLang();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['obligations'], queryFn: () => api<any[]>('/payroll/obligations') });
  const [ref, setRef] = useState<Record<string, string>>({});
  const pay = useMutation({ mutationFn: (id: string) => api(`/payroll/obligations/${id}/pay`, { body: { reference: ref[id] } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['obligations'] }) });
  return (
    <Card>
      <ErrorBox error={list.error ?? pay.error} />
      {list.data?.length === 0 ? <Empty>No statutory obligations (created when a run is finalized).</Empty> : (
        <Table head={['Kind', 'Amount', 'Due', 'Status', 'Reference / pay']}>
          {list.data?.map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2 font-medium">{o.kind.replace('_', ' ')}</td>
              <td className="px-3 py-2">{formatJOD(o.amount, lang)}</td>
              <td className="px-3 py-2 text-xs">{formatDate(o.dueDate).split(',')[0]}</td>
              <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
              <td className="px-3 py-2">
                {o.status === 'PAID' ? o.reference : (
                  <div className="flex gap-1"><Input className="w-40" placeholder="Payment reference" value={ref[o.id] ?? ''} onChange={(e) => setRef({ ...ref, [o.id]: e.target.value })} /><Button disabled={(ref[o.id] ?? '').length < 2} onClick={() => pay.mutate(o.id)}>Pay</Button></div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
