import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Discipline() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const cats = useQuery({ queryKey: ['dcats'], queryFn: () => api<any[]>('/discipline/categories') });
  const list = useQuery({ queryKey: ['dcases'], queryFn: () => api<any[]>('/discipline/cases') });
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ employeeId: '', category: 'ATTENDANCE', description: '', incidentDate: '' });
  const report = useMutation({ mutationFn: () => api('/discipline/cases', { body: f }), onSuccess: (c: any) => { qc.invalidateQueries({ queryKey: ['dcases'] }); setSel(c.id); setF({ ...f, description: '' }); } });
  return (
    <div>
      <PageHeader title={t('Discipline')} subtitle="An incident is an allegation, not a finding. HR reviews, the employee responds, then a decision, notice and appeal. Any action can carry a deduction: it needs the owner and reaches payroll as one deduction." />
      <ErrorBox error={list.error ?? report.error} />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            {list.data?.length === 0 ? <Empty>No cases.</Empty> : (
              <Table head={['Case', 'Employee', 'Status']}>
                {list.data?.map((c) => (
                  <tr key={c.id} onClick={() => setSel(c.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === c.id ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2 font-medium">{c.number}</td>
                    <td className="px-3 py-2">{nameOf(emps.data, c.employeeId)}</td>
                    <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Report an incident">
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); report.mutate(); }}>
              <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.filter((e) => e.status !== 'TERMINATED').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{cats.data?.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select></Field>
                <Field label="Incident date"><Input type="date" required value={f.incidentDate} onChange={(e) => setF({ ...f, incidentDate: e.target.value })} /></Field>
              </div>
              <Field label="What happened (facts only)"><Input required minLength={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
              <Button disabled={report.isPending}>Report</Button>
            </form>
          </Card>
          <Ladder />
          <Categories />
        </div>
        <div className="lg:col-span-3">{sel ? <Detail id={sel} /> : <Card><Empty>Select a case.</Empty></Card>}</div>
      </div>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const q = useQuery({ queryKey: ['dcase', id], queryFn: () => api<any>(`/discipline/cases/${id}`) });
  const actions = useQuery({ queryKey: ['dactions'], queryFn: () => api<any[]>('/discipline/actions') });
  const [d, setD] = useState({ sanction: '', fineAmount: '', legalBasis: '', note: '', deduct: false });
  const [touched, setTouched] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['dcase', id] }); qc.invalidateQueries({ queryKey: ['dcases'] }); };
  const act = useMutation({ mutationFn: (x: { path: string; body?: unknown }) => api(`/discipline/cases/${id}/${x.path}`, { body: x.body ?? {} }), onSuccess: refresh });
  const c = q.data;
  const sug = useQuery({ queryKey: ['dsuggest', c?.employeeId], queryFn: () => api<any>(`/discipline/suggest?employeeId=${c!.employeeId}`), enabled: !!c });
  const chosen = d.sanction || (!touched && sug.data?.suggested) || actions.data?.[0]?.key || 'NONE';
  const pickAction = (key: string) => { const a = actions.data?.find((x) => x.key === key); setTouched(true); setD({ ...d, sanction: key, deduct: key === 'FINE' || (!!a?.defaultDeduction && Number(a.defaultDeduction) > 0), fineAmount: a?.defaultDeduction ? String(Number(a.defaultDeduction)) : d.fineAmount }); };
  const label = (k: string) => actions.data?.find((x) => x.key === k)?.label ?? k;
  if (!c) return <Card><ErrorBox error={q.error} />{q.isLoading && <Empty>Loading...</Empty>}</Card>;
  const run = (path: string, body?: unknown) => <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ path, body })}>{path.replace(/-/g, ' ')}</Button>;
  return (
    <div className="space-y-4">
      <ErrorBox error={act.error} />
      <Card title={`${c.number} · ${nameOf(emps.data, c.employeeId)}`}>
        <p className="text-sm"><StatusBadge status={c.status} /> {c.category} · incident {c.incidentDate.slice(0, 10)}</p>
        <p className="mt-2 text-sm">{c.description}</p>
        {c.employeeResponse && <p className="mt-2 text-sm"><b>Employee response:</b> {c.employeeResponse}</p>}
        {c.sanction && <p className="mt-2 text-sm"><b>Decision:</b> {label(c.sanction)}{c.fineAmount ? ` · deduction ${formatJOD(c.fineAmount, lang)}` : ''}{c.legalBasis ? ` · ${c.legalBasis}` : ''}{c.decidedAt ? ` · ${formatDate(c.decidedAt)}` : ''}</p>}
        {c.acknowledgedAt && <p className="mt-1 text-xs text-slate-500">Receipt acknowledged {formatDate(c.acknowledgedAt)} (not agreement).</p>}
        {c.appealText && <p className="mt-2 text-sm"><b>Appeal:</b> {c.appealText}{c.appealOutcome ? ` → ${c.appealOutcome}` : ''}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {c.status === 'REPORTED' && run('review')}
          {c.status === 'UNDER_REVIEW' && run('request-response')}
          {c.status === 'APPROVED' && <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'notify' })}>Notify employee{c.fineAmount ? ' and create deduction' : ''}</Button>}
          {c.status === 'NOTIFIED' && run('close')}
          {c.status === 'APPEALED' && <><Button disabled={act.isPending} onClick={() => act.mutate({ path: 'appeal-decision', body: { outcome: 'UPHELD' } })}>Uphold</Button><Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ path: 'appeal-decision', body: { outcome: 'OVERTURNED' } })}>Overturn</Button></>}
        </div>
      </Card>
      {['UNDER_REVIEW', 'DECISION_PENDING'].includes(c.status) && (
        <Card title="Decision">
          {sug.data && (
            <div className="mb-3 rounded bg-slate-50 p-2 text-sm">
              <b>{sug.data.priorWarnings}</b> warning(s) still counting for this employee.{' '}
              {sug.data.suggested && <>Next step on your ladder: <b>{label(sug.data.suggested)}</b>{sug.data.atTopOfLadder ? ' (already at the top: consider escalating beyond warnings)' : ''}.</>}
              {sug.data.history.length > 0 && <ul className="mt-1 text-xs text-slate-600">{sug.data.history.map((h: any) => <li key={h.number}>{h.number}: {label(h.sanction)}{Number(h.fineAmount) ? ` + deduction ${formatJOD(h.fineAmount, lang)}` : ''} · {h.decidedAt ? formatDate(h.decidedAt) : ''}{h.counts ? '' : ' (no longer counts)'}</li>)}</ul>}
            </div>
          )}
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ path: 'decide', body: { sanction: chosen, fineAmount: chosen !== 'NONE' && (d.deduct || chosen === 'FINE') ? Number(d.fineAmount) : undefined, legalBasis: d.legalBasis || undefined, note: d.note || undefined } }); }}>
            <Field label="Action (you can follow the suggestion or pick another)"><Select value={chosen} onChange={(e) => pickAction(e.target.value)}>{actions.data?.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}<option value="NONE">Dismiss the case (no action)</option></Select></Field>
            {chosen !== 'NONE' && chosen !== 'FINE' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.deduct} onChange={(e) => setD({ ...d, deduct: e.target.checked })} /> Also deduct from pay</label>}
            {chosen !== 'NONE' && (d.deduct || chosen === 'FINE') && <div className="grid grid-cols-2 gap-2"><Field label="Deduction amount (JOD)"><Input type="number" step="0.001" min="0.001" required value={d.fineAmount} onChange={(e) => setD({ ...d, fineAmount: e.target.value })} /></Field><Field label="Legal / policy basis"><Input required value={d.legalBasis} onChange={(e) => setD({ ...d, legalBasis: e.target.value })} /></Field></div>}
            <Field label="Note"><Input value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></Field>
            <Button disabled={act.isPending}>Record decision</Button>
            {(d.deduct || chosen === 'FINE') && chosen !== 'NONE' && <p className="text-xs text-slate-500">Only an owner can approve a deduction. The cap is one day's basic salary unless the company changes the discipline.settings policy (placeholder, not legally verified).</p>}
          </form>
        </Card>
      )}
    </div>
  );
}

function Ladder() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dactions-all'], queryFn: () => api<any[]>('/discipline/actions?all=1') });
  const blank = { label: '', step: '', countsAsWarning: true, defaultDeduction: '' };
  const [f, setF] = useState(blank);
  const save = useMutation({ mutationFn: (x: any) => api('/discipline/actions', { body: x }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['dactions'] }); qc.invalidateQueries({ queryKey: ['dactions-all'] }); qc.invalidateQueries({ queryKey: ['dsuggest'] }); setF(blank); } });
  const same = (a: any, over: object = {}) => ({ key: a.key, label: a.label, step: a.step || undefined, countsAsWarning: a.countsAsWarning, defaultDeduction: a.defaultDeduction ? Number(a.defaultDeduction) : null, active: a.active, ...over });
  return (
    <Card title="Warning ladder (company-defined)">
      <ErrorBox error={q.error ?? save.error} />
      <Table head={['Step', 'Action', 'Default deduction', '']}>
        {q.data?.map((a) => (
          <tr key={a.id} className={a.active ? '' : 'text-slate-400'}>
            <td className="px-3 py-2 text-xs">{a.countsAsWarning ? a.step : '-'}</td><td className="px-3 py-2">{a.label}{!a.countsAsWarning && <span className="ms-1 text-xs text-slate-500">(not a warning)</span>}</td>
            <td className="px-3 py-2 text-xs">{a.defaultDeduction ? Number(a.defaultDeduction).toFixed(3) : '-'}</td>
            <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => save.mutate(same(a, { active: !a.active }))}>{a.active ? 'Turn off' : 'Turn on'}</Button></td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-xs text-slate-500">Steps run in order: an employee with one warning on record is suggested step 2, and so on. Warnings stop counting when they expire or an appeal overturns them.</p>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ key: f.label, label: f.label, step: f.countsAsWarning ? Number(f.step) : undefined, countsAsWarning: f.countsAsWarning, defaultDeduction: f.defaultDeduction ? Number(f.defaultDeduction) : null }); }}>
        <Field label="New action"><Input required minLength={2} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Step"><Input className="w-16" type="number" min="1" max="20" required={f.countsAsWarning} disabled={!f.countsAsWarning} value={f.step} onChange={(e) => setF({ ...f, step: e.target.value })} /></Field>
        <Field label="Default deduction"><Input className="w-28" type="number" step="0.001" min="0" value={f.defaultDeduction} onChange={(e) => setF({ ...f, defaultDeduction: e.target.value })} /></Field>
        <label className="mb-2 flex items-center gap-1 text-xs"><input type="checkbox" checked={f.countsAsWarning} onChange={(e) => setF({ ...f, countsAsWarning: e.target.checked })} /> counts as a warning</label>
        <Button disabled={save.isPending}>Add</Button>
      </form>
    </Card>
  );
}

function Categories() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dcats-all'], queryFn: () => api<any[]>('/discipline/categories?all=1') });
  const [f, setF] = useState({ key: '', label: '', expiryMonths: '' });
  const save = useMutation({ mutationFn: (x: any) => api('/discipline/categories', { body: x }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['dcats'] }); qc.invalidateQueries({ queryKey: ['dcats-all'] }); setF({ key: '', label: '', expiryMonths: '' }); } });
  return (
    <Card title="Categories (company-defined)">
      <ErrorBox error={q.error ?? save.error} />
      <Table head={['Category', 'Expires after', '']}>
        {q.data?.map((c) => (
          <tr key={c.id} className={c.active ? '' : 'text-slate-400'}><td className="px-3 py-2">{c.label}</td><td className="px-3 py-2 text-xs">{c.expiryMonths ? `${c.expiryMonths} months` : 'never'}</td>
            <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => save.mutate({ key: c.key, label: c.label, expiryMonths: c.expiryMonths, active: !c.active })}>{c.active ? 'Turn off' : 'Turn on'}</Button></td></tr>
        ))}
      </Table>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ key: f.key || f.label, label: f.label, expiryMonths: f.expiryMonths ? Number(f.expiryMonths) : null }); }}>
        <Field label="New category"><Input required minLength={2} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Expiry (months)"><Input className="w-24" type="number" min="1" max="120" value={f.expiryMonths} onChange={(e) => setF({ ...f, expiryMonths: e.target.value })} /></Field>
        <Button disabled={save.isPending}>Add</Button>
      </form>
    </Card>
  );
}
