import { EvidenceList } from '../components/Attachments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Actions() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emps = useList('/employees');
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['actions', status], queryFn: () => api<any[]>(`/ops/actions${status ? `?status=${status}` : ''}`) });
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ branchId: '', title: '', severity: 'MEDIUM', dueAt: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['actions'] }); qc.invalidateQueries({ queryKey: ['action'] }); };
  const create = useMutation({ mutationFn: () => api('/ops/actions', { body: { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined } }), onSuccess: (a: any) => { refresh(); setSel(a.id); setF({ ...f, title: '' }); } });
  const now = Date.now();
  return (
    <div>
      <PageHeader title={t('Corrective actions')} subtitle="Raised by audits, food-safety breaches or by hand. Assigned, evidenced, then closed by someone other than the person who did the work." />
      <ErrorBox error={list.error ?? create.error} />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-2 w-48"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
            {list.data?.length === 0 ? <Empty>No actions.</Empty> : (
              <Table head={['No.', 'Action', 'Due', 'Status']}>
                {list.data?.map((a) => (
                  <tr key={a.id} onClick={() => setSel(a.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === a.id ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2 text-xs">{a.number}</td>
                    <td className="px-3 py-2 font-medium">{a.title}<div className="text-xs text-slate-500">{a.source} · {a.severity}</div></td>
                    <td className={`px-3 py-2 text-xs ${a.dueAt && new Date(a.dueAt).getTime() < now && ['OPEN', 'IN_PROGRESS'].includes(a.status) ? 'font-semibold text-red-700' : ''}`}>{a.dueAt?.slice(0, 10) ?? '-'}</td>
                    <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Raise an action">
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <Field label="Branch"><Select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
              <Field label="What needs fixing"><Input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Severity"><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
                <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
              </div>
              <Button disabled={create.isPending}>Raise</Button>
            </form>
          </Card>
        </div>
        <div className="lg:col-span-3">{sel ? <Detail id={sel} emps={emps.data} onChange={refresh} /> : <Card><Empty>Select an action.</Empty></Card>}</div>
      </div>
    </div>
  );
}

function Detail({ id, emps, onChange }: { id: string; emps?: any[]; onChange: () => void }) {
  const q = useQuery({ queryKey: ['action', id], queryFn: () => api<any>(`/ops/actions/${id}`) });
  const staff = useQuery({ queryKey: ['employees', 'branch', q.data?.branchId], queryFn: () => api<any[]>(`/employees?branchId=${q.data.branchId}&status=ACTIVE`), enabled: !!q.data });
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const act = useMutation({ mutationFn: (x: { path: string; body: unknown }) => api(`/ops/actions/${id}/${x.path}`, { body: x.body }), onSuccess: onChange });
  const a = q.data;
  if (!a) return <Card><ErrorBox error={q.error} />{q.isLoading && <Empty>Loading...</Empty>}</Card>;
  return (
    <Card title={`${a.number} · ${a.title}`}>
      <ErrorBox error={act.error} />
      <p className="text-sm"><StatusBadge status={a.status} /> {a.source} · {a.severity}{a.assigneeEmployeeId && <> · assigned to <b>{nameOf(emps, a.assigneeEmployeeId)}</b></>}{a.dueAt && <> · due {formatDate(a.dueAt)}</>}</p>
      {a.description && <p className="mt-1 text-sm text-slate-600">{a.description}</p>}
      {a.completionNote && <div className="mt-2 text-sm"><b>Reported fix:</b> {a.completionNote} <span className="text-xs text-slate-500">({(a.evidenceDocIds as string[]).length} evidence file(s))</span><EvidenceList ids={a.evidenceDocIds} /></div>}
      {['OPEN', 'IN_PROGRESS'].includes(a.status) && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Assign to"><Select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Select...</option>{staff.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <Field label="Due"><Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Button disabled={!who || act.isPending} onClick={() => act.mutate({ path: 'assign', body: { employeeId: who, dueAt: due ? new Date(due).toISOString() : undefined } })}>{a.assigneeEmployeeId ? 'Reassign' : 'Assign'}</Button>
        </div>
      )}
      {a.status === 'PENDING_VERIFICATION' && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Verification note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button disabled={act.isPending} onClick={() => act.mutate({ path: 'verify', body: { approve: true, note: note || undefined } })}>Verify and close</Button>
          <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ path: 'verify', body: { approve: false, note: note || undefined } })}>Send back</Button>
        </div>
      )}
      {!['CLOSED', 'CANCELLED'].includes(a.status) && <div className="mt-3"><Button variant="danger" disabled={act.isPending} onClick={() => { const r = prompt('Reason for cancelling?'); if (r && r.length >= 3) act.mutate({ path: 'cancel', body: { reason: r } }); }}>Cancel action</Button></div>}
      <ul className="mt-4 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
        {(a.history as any[]).map((h, i) => <li key={i}>{formatDate(h.at)} · {h.event}{h.note ? `: ${h.note}` : ''}</li>)}
      </ul>
      {a.severity === 'CRITICAL' && <p className="mt-2 text-xs text-slate-500">Closing a critical action needs a company-wide role. Food-safety actions also need a later in-range reading.</p>}
    </Card>
  );
}
