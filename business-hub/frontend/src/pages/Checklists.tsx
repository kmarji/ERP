import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { AttachPicker, Attachment } from '../components/Attachments';
import { api } from '../lib/api';
import { addDays, formatDate, ymd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Checklists() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Monitor');
  return (
    <div>
      <PageHeader title={t('Checklists')} subtitle="Reusable checklists with evidence and critical-failure rules, assigned on a schedule or on request, with compliance monitoring." />
      <Tabs tabs={['Monitor', 'Templates', 'Assignments', 'Request one']} value={tab} onChange={setTab} />
      {tab === 'Monitor' ? <Monitor /> : tab === 'Templates' ? <Templates /> : tab === 'Assignments' ? <Assignments /> : <RequestOne />}
    </div>
  );
}

function Monitor() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emps = useList('/employees');
  const tpls = useQuery({ queryKey: ['ctpl-all'], queryFn: () => api<any[]>('/ops/checklist-templates?all=1') });
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const from = addDays(ymd(new Date()), -6);
  const qs = `from=${from}${branchId ? `&branchId=${branchId}` : ''}`;
  const sum = useQuery({ queryKey: ['cmon', qs], queryFn: () => api<any>(`/ops/monitor?${qs}`) });
  const runs = useQuery({ queryKey: ['cruns', qs, status], queryFn: () => api<any[]>(`/ops/checklist-runs?${qs}${status ? `&status=${status}` : ''}`) });
  const [open, setOpen] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['crun', open], queryFn: () => api<any>(`/ops/checklist-runs/${open}`), enabled: !!open });
  const review = useMutation({ mutationFn: (id: string) => api(`/ops/checklist-runs/${id}/review`, { method: 'POST' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['cruns'] }); qc.invalidateQueries({ queryKey: ['crun'] }); } });
  const s = sum.data;
  return (
    <div className="space-y-4">
      <ErrorBox error={sum.error ?? runs.error ?? review.error} />
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All my branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{['PENDING', 'OVERDUE', 'COMPLETED', 'REVIEWED'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <span className="text-xs text-slate-500">Last 7 days</span>
        </div>
        {s && <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div><b className="text-xl">{s.compliancePct ?? '-'}{s.compliancePct != null && '%'}</b><br />compliant</div>
          <div><b className="text-xl">{s.completed}</b>/{s.total}<br />completed</div>
          <div><b className="text-xl">{s.overdue}</b><br />overdue</div>
          <div><b className="text-xl">{s.late}</b><br />done late</div>
          <div><b className="text-xl">{s.criticalFailures}</b><br />critical failures</div>
        </div>}
        {runs.data?.length === 0 ? <Empty>No checklist runs.</Empty> : (
          <Table head={['Checklist', 'Employee', 'Branch', 'Due', 'Status', '']}>
            {runs.data?.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-medium">{nameOf(tpls.data, r.templateId)}{!r.assignmentId && <span className="ms-1 text-xs text-slate-500">(on request)</span>}</td>
                <td className="px-3 py-2">{nameOf(emps.data, r.employeeId)}</td><td className="px-3 py-2">{nameOf(branches.data, r.branchId)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(r.dueAt)}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} />{r.criticalFailures > 0 && <span className="ms-1 text-xs text-red-600">{r.criticalFailures} critical</span>}{r.completedLate && <span className="ms-1 text-xs text-amber-600">late</span>}</td>
                <td className="px-3 py-2 text-end">{['COMPLETED', 'REVIEWED'].includes(r.status) && <Button variant="ghost" onClick={() => setOpen(r.id)}>View</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open && detail.data && (
        <Card title={`${detail.data.template.name} v${detail.data.template.version}`}>
          <ul className="space-y-1 text-sm">
            {(detail.data.template.items as any[]).map((it) => {
              const a = (detail.data.run.results as any[])?.find((x) => x.itemId === it.id);
              return <li key={it.id}>{a?.ok ? '✓' : '✗'} {it.label}{it.critical && <b className="ms-1 text-xs text-red-600">critical</b>}{a?.note && <span className="ms-2 text-slate-500">"{a.note}"</span>}{a?.docId && <span className="ms-2 text-xs text-slate-500">evidence attached</span>}</li>;
            })}
          </ul>
          <div className="mt-3 flex gap-2">
            {detail.data.run.status === 'COMPLETED' && <Button disabled={review.isPending} onClick={() => review.mutate(open)}>Mark reviewed</Button>}
            <Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

type Draft = { label: string; critical: boolean; evidenceRequired: boolean };

function Templates() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const list = useQuery({ queryKey: ['ctpl'], queryFn: () => api<any[]>('/ops/checklist-templates') });
  const [f, setF] = useState({ code: '', name: '', branchId: '' });
  const [items, setItems] = useState<Draft[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [d, setD] = useState<Draft>({ label: '', critical: false, evidenceRequired: false });
  const save = useMutation({ mutationFn: () => api('/ops/checklist-templates', { body: { code: f.code || undefined, name: f.name, branchId: f.branchId || undefined, attachmentIds: files.map((a) => a.id), items } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['ctpl'] }); qc.invalidateQueries({ queryKey: ['ctpl-all'] }); setF({ code: '', name: '', branchId: '' }); setItems([]); setFiles([]); } });
  const edit = (t: any) => { setFiles(t.attachments ?? []); setF({ code: t.code, name: t.name, branchId: t.branchId ?? '' }); setItems((t.items as any[]).map((i) => ({ label: i.label, critical: !!i.critical, evidenceRequired: !!i.evidenceRequired }))); };
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No templates yet.</Empty> : (
          <Table head={['Name', 'Items', 'Version', '']}>
            {list.data?.map((t) => <tr key={t.id}><td className="px-3 py-2 font-medium">{t.name}<div className="text-xs text-slate-500">{t.branchId ? nameOf(branches.data, t.branchId) : 'All branches'}</div></td><td className="px-3 py-2">{(t.items as any[]).length}</td><td className="px-3 py-2">v{t.version}</td><td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => edit(t)}>Edit</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title={f.code ? 'New version of a template' : 'New template'} className="lg:col-span-3">
        <ErrorBox error={save.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} disabled={!!f.code}><option value="">All branches (company-wide role)</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          </div>
          {items.map((i, n) => <p key={n} className="text-sm">{n + 1}. {i.label}{i.critical && <b className="ms-1 text-xs text-red-600">critical</b>}{i.evidenceRequired && <span className="ms-1 text-xs text-slate-500">evidence</span>} <button type="button" className="text-red-600" onClick={() => setItems(items.filter((_, j) => j !== n))}>remove</button></p>)}
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
            <Field label="Item"><Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></Field>
            <label className="text-sm"><input type="checkbox" checked={d.critical} onChange={(e) => setD({ ...d, critical: e.target.checked })} /> critical</label>
            <label className="text-sm"><input type="checkbox" checked={d.evidenceRequired} onChange={(e) => setD({ ...d, evidenceRequired: e.target.checked })} /> photo/evidence</label>
            <Button type="button" variant="ghost" disabled={d.label.length < 2} onClick={() => { setItems([...items, d]); setD({ label: '', critical: false, evidenceRequired: false }); }}>Add item</Button>
          </div>
          <Field label="Guides, example photos or videos for the people doing this checklist"><AttachPicker value={files} onChange={setFiles} /></Field>
          <div className="flex gap-2"><Button disabled={save.isPending || !items.length}>Save{f.code ? ' as next version' : ''}</Button>{f.code && <Button type="button" variant="ghost" onClick={() => { setF({ code: '', name: '', branchId: '' }); setItems([]); setFiles([]); }}>New instead</Button>}</div>
          <p className="text-xs text-slate-500">Saving a new version retires the old one for new assignments; completed runs keep the version they were done against. A critical item that fails raises an exception for the manager.</p>
        </form>
      </Card>
    </div>
  );
}

function Assignments() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emps = useList('/employees');
  const tpls = useQuery({ queryKey: ['ctpl'], queryFn: () => api<any[]>('/ops/checklist-templates') });
  const list = useQuery({ queryKey: ['cassign'], queryFn: () => api<any[]>('/ops/checklist-assignments') });
  const [f, setF] = useState({ templateId: '', branchId: '', employeeId: '', recurrence: 'DAILY', weekday: '0', dueTime: '10:00' });
  const staff = useQuery({ queryKey: ['employees', 'branch', f.branchId], queryFn: () => api<any[]>(`/employees?branchId=${f.branchId}&status=ACTIVE`), enabled: !!f.branchId });
  const refresh = () => qc.invalidateQueries({ queryKey: ['cassign'] });
  const add = useMutation({ mutationFn: () => api('/ops/checklist-assignments', { body: { ...f, weekday: f.recurrence === 'WEEKLY' ? Number(f.weekday) : undefined } }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: (id: string) => api(`/ops/checklist-assignments/${id}/stop`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? stop.error} />
        {list.data?.length === 0 ? <Empty>No recurring assignments.</Empty> : (
          <Table head={['Checklist', 'Employee', 'Repeats', 'Due by', '']}>
            {list.data?.map((a) => <tr key={a.id}><td className="px-3 py-2 font-medium">{nameOf(tpls.data, a.templateId)}</td><td className="px-3 py-2">{nameOf(emps.data, a.employeeId)}</td><td className="px-3 py-2 text-xs">{a.recurrence === 'DAILY' ? 'Daily' : `Weekly, ${DAYS[a.weekday]}`}</td><td className="px-3 py-2">{a.dueTime}</td><td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => stop.mutate(a.id)}>Stop</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Assign a recurring checklist" className="lg:col-span-2">
        <ErrorBox error={add.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Checklist"><Select required value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Select...</option>{tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</Select></Field>
          <Field label="Branch"><Select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value, employeeId: '' })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{staff.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Repeats"><Select value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}><option>DAILY</option><option>WEEKLY</option></Select></Field>
            {f.recurrence === 'WEEKLY' && <Field label="Day"><Select value={f.weekday} onChange={(e) => setF({ ...f, weekday: e.target.value })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>}
            <Field label="Due by"><Input type="time" required value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} /></Field>
          </div>
          <Button disabled={add.isPending}>Assign</Button>
        </form>
      </Card>
    </div>
  );
}

function RequestOne() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const tpls = useQuery({ queryKey: ['ctpl'], queryFn: () => api<any[]>('/ops/checklist-templates') });
  const [f, setF] = useState({ templateId: '', branchId: '', employeeId: '', dueAt: '', note: '' });
  const staff = useQuery({ queryKey: ['employees', 'branch', f.branchId], queryFn: () => api<any[]>(`/employees?branchId=${f.branchId}&status=ACTIVE`), enabled: !!f.branchId });
  const send = useMutation({ mutationFn: () => api('/ops/checklist-runs', { body: { ...f, dueAt: new Date(f.dueAt).toISOString(), note: f.note || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['cruns'] }) });
  return (
    <Card title="Ask for a checklist now" className="max-w-lg">
      <ErrorBox error={send.error} />
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <Field label="Checklist"><Select required value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Select...</option>{tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</Select></Field>
        <Field label="Branch"><Select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value, employeeId: '' })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{staff.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
        <Field label="Due"><Input type="datetime-local" required value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <Button disabled={send.isPending}>Send</Button>
        {send.isSuccess && <p className="text-xs text-emerald-700">Sent. It shows in the employee's My space, Tasks tab. Review it from Monitor once done.</p>}
      </form>
    </Card>
  );
}
