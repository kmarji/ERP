import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Offboarding() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const list = useQuery({ queryKey: ['offboardings'], queryFn: () => api<any[]>('/offboarding') });
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ employeeId: '', reason: 'RESIGNATION', noticeDate: '', lastWorkingDay: '' });
  const initiate = useMutation({ mutationFn: () => api('/offboarding', { body: f }), onSuccess: (o: any) => { qc.invalidateQueries({ queryKey: ['offboardings'] }); setSel(o.id); } });
  return (
    <div>
      <PageHeader title={t('Offboarding')} subtitle="Exit checklist, final settlement, approval, then termination of the employee record and login." />
      <ErrorBox error={list.error ?? initiate.error} />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            {list.data?.length === 0 ? <Empty>No offboardings.</Empty> : (
              <Table head={['Employee', 'Last day', 'Status']}>
                {list.data?.map((o) => (
                  <tr key={o.id} onClick={() => setSel(o.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === o.id ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2 font-medium">{nameOf(emps.data, o.employeeId)}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(o.lastWorkingDay).split(',')[0]}</td>
                    <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Initiate offboarding">
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); initiate.mutate(); }}>
              <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.filter((e) => e.status !== 'TERMINATED').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
              <Field label="Reason"><Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{['RESIGNATION', 'TERMINATION', 'END_OF_CONTRACT', 'OTHER'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Notice date"><Input type="date" required value={f.noticeDate} onChange={(e) => setF({ ...f, noticeDate: e.target.value })} /></Field>
                <Field label="Last working day"><Input type="date" required value={f.lastWorkingDay} onChange={(e) => setF({ ...f, lastWorkingDay: e.target.value })} /></Field>
              </div>
              <Button disabled={initiate.isPending}>Initiate</Button>
            </form>
          </Card>
        </div>
        <div className="lg:col-span-3">{sel ? <Detail id={sel} /> : <Card><Empty>Select an offboarding case.</Empty></Card>}</div>
      </div>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const o = useQuery({ queryKey: ['offboarding', id], queryFn: () => api<any>(`/offboarding/${id}`) });
  const [extra, setExtra] = useState<{ label: string; kind: string; amount: string }[]>([]);
  const [draft, setDraft] = useState({ label: '', kind: 'EARNING', amount: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['offboarding', id] }); qc.invalidateQueries({ queryKey: ['offboardings'] }); };
  const act = useMutation({ mutationFn: (x: { path: string; body?: unknown }) => api(`/offboarding/${id}/${x.path}`, { method: 'POST', body: x.body }), onSuccess: refresh });
  const x = o.data;
  if (!x) return <Card><ErrorBox error={o.error} />{o.isLoading && <Empty>Loading...</Empty>}</Card>;
  const live = ['INITIATED', 'SETTLEMENT_REVIEW'].includes(x.status);
  const items: any[] = x.settlement?.items ?? [];
  return (
    <div className="space-y-4">
      <ErrorBox error={act.error} />
      <Card title={`${nameOf(emps.data, x.employeeId)} · ${x.reason}`}>
        <p className="text-sm"><StatusBadge status={x.status} /> notice {formatDate(x.noticeDate).split(',')[0]} · last day {formatDate(x.lastWorkingDay).split(',')[0]}</p>
        <ul className="mt-3 space-y-1 text-sm">
          {(x.checklist as any[]).map((c) => (
            <li key={c.key}>
              <label className="flex items-center gap-2"><input type="checkbox" checked={c.done} disabled={c.done || !live || act.isPending} onChange={() => act.mutate({ path: `checklist/${c.key}` })} />{c.label}{c.doneAt && <span className="text-xs text-slate-500">{formatDate(c.doneAt)}</span>}</label>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Final settlement">
        {live && (
          <div className="mb-3 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Extra item"><Input placeholder="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field>
              <Select className="w-32" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}><option>EARNING</option><option>DEDUCTION</option></Select>
              <Input className="w-28" type="number" step="0.001" min="0.001" placeholder="Amount" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
              <Button variant="ghost" disabled={draft.label.length < 2 || !(Number(draft.amount) > 0)} onClick={() => { setExtra([...extra, draft]); setDraft({ label: '', kind: 'EARNING', amount: '' }); }}>Add</Button>
            </div>
            {extra.map((e, i) => <p key={i} className="text-sm">{e.kind} {e.label}: {formatJOD(e.amount, lang)} <button className="text-red-600" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>remove</button></p>)}
            <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'settlement', body: { extra: extra.map((e) => ({ ...e, amount: Number(e.amount) })) } })}>Calculate settlement</Button>
            <p className="text-xs text-slate-500">Unused paid leave is added automatically. Recalculating replaces the previous settlement and clears any approval. Include all extra items each time.</p>
          </div>
        )}
        {items.length > 0 && (
          <Table head={['Item', 'Kind', 'Amount']}>
            {items.map((it, i) => <tr key={i}><td className="px-3 py-2">{it.label}</td><td className="px-3 py-2">{it.kind}</td><td className="px-3 py-2">{formatJOD(it.amount, lang)}</td></tr>)}
            <tr className="font-semibold"><td className="px-3 py-2" colSpan={2}>Net settlement</td><td className="px-3 py-2">{formatJOD(x.settlement.total, lang)}</td></tr>
          </Table>
        )}
        {x.settlementApprovedBy && <p className="mt-2 text-sm text-emerald-700">Settlement approved.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {x.status === 'SETTLEMENT_REVIEW' && !x.settlementApprovedBy && <Button variant="ghost" onClick={() => act.mutate({ path: 'request-approval' })}>Request approval</Button>}
          {x.status === 'SETTLEMENT_REVIEW' && <Button disabled={!x.settlementApprovedBy || act.isPending} onClick={() => confirm('Terminate the employee and deactivate their login?') && act.mutate({ path: 'complete' })}>Complete offboarding</Button>}
          {live && <Button variant="danger" onClick={() => confirm('Cancel this offboarding?') && act.mutate({ path: 'cancel' })}>Cancel</Button>}
        </div>
        {act.isSuccess && <p className="mt-2 text-xs text-slate-500">Approval requests are decided on the Approvals screen; return here afterwards.</p>}
      </Card>
    </div>
  );
}
