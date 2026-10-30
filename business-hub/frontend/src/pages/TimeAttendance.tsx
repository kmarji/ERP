import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { addDays, formatDate, localToIso, mondayOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function TimeAttendance() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emps = useList('/employees');
  const [f, setF] = useState({ branchId: '', status: '', from: mondayOf(), to: addDays(mondayOf(), 6) });
  const [m, setM] = useState({ employeeId: '', branchId: '', clockIn: '', clockOut: '', note: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['time-entries', qs], queryFn: () => api<any[]>(`/time-entries?${qs}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['time-entries'] });
  const approve = useMutation({ mutationFn: (id: string) => api(`/time-entries/${id}/approve`, { method: 'POST' }), onSuccess: refresh });
  const flag = useMutation({ mutationFn: () => api<{ flagged: number }>('/time-entries/flag-missing', { method: 'POST' }), onSuccess: refresh });
  const period = useMutation({ mutationFn: () => api('/time-entries/approve-period', { body: { branchId: f.branchId, from: f.from, to: f.to } }), onSuccess: refresh });
  const manual = useMutation({ mutationFn: () => api('/time-entries/manual', { body: { ...m, clockIn: localToIso(m.clockIn), clockOut: localToIso(m.clockOut), note: m.note || undefined } }), onSuccess: refresh });
  return (
    <div className="space-y-4">
      <PageHeader title={t('Time & attendance')} subtitle="Review punches, fix missing ones, then approve the period before payroll." />
      <ErrorBox error={list.error ?? approve.error ?? flag.error ?? period.error ?? manual.error} />
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option>{['OPEN', 'COMPLETE', 'NEEDS_FIX', 'APPROVED'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Button variant="ghost" disabled={flag.isPending} onClick={() => flag.mutate()}>Flag missing punches</Button>
          <Button disabled={!f.branchId || period.isPending} title={f.branchId ? '' : 'Pick a branch'} onClick={() => period.mutate()}>Approve period</Button>
        </div>
        {flag.data && <p className="mb-2 text-sm text-slate-600">{flag.data.flagged} entries flagged.</p>}
        {list.data?.length === 0 ? <Empty>No time entries.</Empty> : (
          <Table head={['Employee', 'In', 'Out', 'Worked', 'OT', 'Late', 'Flags', 'Status', '']}>
            {list.data?.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 font-medium">{nameOf(emps.data, e.employeeId)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(e.clockIn)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(e.clockOut)}</td>
                <td className="px-3 py-2">{e.workedMinutes ?? '-'}</td>
                <td className="px-3 py-2">{e.overtimeMinutes ?? '-'}</td>
                <td className="px-3 py-2">{e.lateMinutes || '-'}</td>
                <td className="space-x-1 px-3 py-2">{(e.flags ?? []).map((x: any) => <Badge key={x.code} tone="bg-amber-100 text-amber-800">{x.code}</Badge>)}</td>
                <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                <td className="px-3 py-2 text-end">{e.status !== 'APPROVED' && <Button variant="ghost" onClick={() => approve.mutate(e.id)}>Approve</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Manual entry">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); manual.mutate(); }}>
          <Field label="Employee"><Select required value={m.employeeId} onChange={(e) => setM({ ...m, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Branch"><Select required value={m.branchId} onChange={(e) => setM({ ...m, branchId: e.target.value })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Clock in"><Input type="datetime-local" required value={m.clockIn} onChange={(e) => setM({ ...m, clockIn: e.target.value })} /></Field>
          <Field label="Clock out"><Input type="datetime-local" required value={m.clockOut} onChange={(e) => setM({ ...m, clockOut: e.target.value })} /></Field>
          <Field label="Note"><Input value={m.note} onChange={(e) => setM({ ...m, note: e.target.value })} /></Field>
          <Button disabled={manual.isPending}>Add</Button>
        </form>
      </Card>
    </div>
  );
}
