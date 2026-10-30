import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { addDays, formatTime, mondayOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Scheduling() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Week');
  return (
    <div>
      <PageHeader title={t('Scheduling')} subtitle="Weekly rota per branch, shift templates and swap requests. New shifts are published immediately." />
      <Tabs tabs={['Week', 'Templates', 'Swaps']} value={tab} onChange={setTab} />
      {tab === 'Week' ? <Week /> : tab === 'Templates' ? <Templates /> : <Swaps />}
    </div>
  );
}

function Week() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(mondayOf());
  const to = addDays(from, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const emps = useQuery({ queryKey: ['employees', 'branch', branchId], queryFn: () => api<any[]>(`/employees?branchId=${branchId}&status=ACTIVE`), enabled: !!branchId });
  const tpls = useQuery({ queryKey: ['templates', branchId], queryFn: () => api<any[]>(`/shift-templates?branchId=${branchId}`), enabled: !!branchId });
  const shifts = useQuery({ queryKey: ['schedules', branchId, from], queryFn: () => api<any[]>(`/schedules?branchId=${branchId}&from=${from}&to=${to}`), enabled: !!branchId });
  const [f, setF] = useState({ employeeId: '', date: from, templateId: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules'] });
  const add = useMutation({ mutationFn: () => api('/schedules', { body: { branchId, employeeId: f.employeeId, date: f.date, templateId: f.templateId } }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/schedules/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="space-y-4">
      <ErrorBox error={emps.error ?? shifts.error ?? add.error ?? cancel.error} />
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Branch"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Week starting (Monday)"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(mondayOf(new Date(`${e.target.value}T00:00:00Z`)))} /></Field>
          <Button variant="ghost" onClick={() => setFrom(addDays(from, -7))}>&lt;</Button>
          <Button variant="ghost" onClick={() => setFrom(addDays(from, 7))}>&gt;</Button>
        </div>
        {!branchId ? <Empty>Select a branch.</Empty> : (
          <Table head={['Employee', ...days.map((d) => d.slice(5))]}>
            {emps.data?.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 font-medium">{e.name}</td>
                {days.map((d) => (
                  <td key={d} className="px-2 py-2 align-top text-xs">
                    {shifts.data?.filter((s) => s.employeeId === e.id && s.date.slice(0, 10) === d).map((s) => (
                      <div key={s.id} className={`mb-1 rounded border px-1 py-0.5 ${s.status === 'PUBLISHED' ? 'border-brand-500 bg-brand-50' : 'border-slate-200 text-slate-400 line-through'}`}>
                        {formatTime(s.startAt)}-{formatTime(s.endAt)}
                        {s.status === 'PUBLISHED' && <button className="ms-1 text-red-600" title="Cancel shift" onClick={() => cancel.mutate(s.id)}>x</button>}
                        {s.status === 'LEAVE_CONFLICT' && <StatusBadge status={s.status} />}
                      </div>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {branchId && (
        <Card title="Publish a shift">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Employee"><Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Template"><Select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Select...</option>{tpls.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} {x.startTime}-{x.endTime}</option>)}</Select></Field>
            <Button disabled={!f.employeeId || !f.date || !f.templateId || add.isPending} onClick={() => add.mutate()}>Publish</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Templates() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const list = useQuery({ queryKey: ['templates', 'all'], queryFn: () => api<any[]>('/shift-templates') });
  const [f, setF] = useState({ branchId: '', name: '', startTime: '09:00', endTime: '17:00', breakMinutes: '30' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['templates'] });
  const create = useMutation({ mutationFn: () => api('/shift-templates', { body: { ...f, branchId: f.branchId || undefined, breakMinutes: Number(f.breakMinutes) } }), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (x: any) => api(`/shift-templates/${x.id}`, { method: 'PATCH', body: { active: !x.active } }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? toggle.error} />
        {list.data?.length === 0 ? <Empty>No templates.</Empty> : (
          <Table head={['Name', 'Branch', 'Time', 'Break', 'Active', '']}>
            {list.data?.map((x) => (
              <tr key={x.id}>
                <td className="px-3 py-2 font-medium">{x.name}</td>
                <td className="px-3 py-2">{x.branchId ? nameOf(branches.data, x.branchId) : 'All'}</td>
                <td className="px-3 py-2">{x.startTime}-{x.endTime}</td>
                <td className="px-3 py-2">{x.breakMinutes}m</td>
                <td className="px-3 py-2">{x.active ? 'Yes' : 'No'}</td>
                <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => toggle.mutate(x)}>{x.active ? 'Deactivate' : 'Activate'}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="New template" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Branch (optional)"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Start"><Input type="time" required value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
            <Field label="End"><Input type="time" required value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
            <Field label="Break (min)"><Input type="number" min={0} max={240} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: e.target.value })} /></Field>
          </div>
          <Button disabled={create.isPending}>Create</Button>
        </form>
      </Card>
    </div>
  );
}

function Swaps() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const [status, setStatus] = useState('PENDING');
  const list = useQuery({ queryKey: ['swaps', status], queryFn: () => api<any[]>(`/shift-swaps?status=${status}`) });
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/shift-swaps/${x.id}/decide`, { body: { approve: x.approve } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['swaps'] }) });
  return (
    <Card>
      <ErrorBox error={list.error ?? decide.error} />
      <div className="mb-3 w-40"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      {list.data?.length === 0 ? <Empty>No swap requests.</Empty> : (
        <Table head={['From', 'To', 'Reason', 'Status', '']}>
          {list.data?.map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2">{nameOf(emps.data, s.fromEmployeeId)}</td>
              <td className="px-3 py-2">{nameOf(emps.data, s.toEmployeeId)}</td>
              <td className="px-3 py-2 text-slate-600">{s.reason ?? '-'}</td>
              <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
              <td className="space-x-1 px-3 py-2 text-end">
                {s.status === 'PENDING' && <><Button variant="ghost" onClick={() => decide.mutate({ id: s.id, approve: false })}>Reject</Button><Button onClick={() => decide.mutate({ id: s.id, approve: true })}>Approve</Button></>}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
