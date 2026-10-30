import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api, ApiError, download } from '../lib/api';
import { addDays, formatDate, formatJOD, formatTime, localToIso, ymd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function MySpace() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Schedule');
  const profile = useQuery({ queryKey: ['me-profile'], queryFn: () => api<any>('/me/profile'), retry: false });
  if (profile.error) {
    const none = (profile.error as ApiError).status === 404;
    return <div><PageHeader title={t('My space')} /><Card><Empty>{none ? 'Your login is not linked to an employee record, so there is nothing to show here. Ask HR to link your account.' : (profile.error as Error).message}</Empty></Card></div>;
  }
  return (
    <div>
      <PageHeader title={t('My space')} subtitle={profile.data ? `${profile.data.name} · ${profile.data.number}` : ''} />
      <Punch />
      <Tabs tabs={['Schedule', 'Time', 'Leave', 'Swaps', 'Payslips', 'Training']} value={tab} onChange={setTab} />
      {tab === 'Schedule' ? <Schedule /> : tab === 'Time' ? <MyTime /> : tab === 'Leave' ? <MyLeave /> : tab === 'Swaps' ? <Swaps /> : tab === 'Payslips' ? <Payslips /> : <Training />}
    </div>
  );
}

function Punch() {
  const qc = useQueryClient();
  const entries = useQuery({ queryKey: ['me-time'], queryFn: () => api<any[]>('/me/time') });
  const open = entries.data?.find((e) => e.status === 'OPEN');
  const go = useMutation({ mutationFn: (p: string) => api(`/me/${p}`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-time'] }) });
  return (
    <Card className="mb-4">
      <ErrorBox error={go.error} />
      <div className="flex items-center gap-3">
        {open ? <><span className="text-sm">Clocked in since {formatDate(open.clockIn)}</span><Button variant="danger" disabled={go.isPending} onClick={() => go.mutate('clock-out')}>Clock out</Button></> : <><span className="text-sm text-slate-600">Not clocked in</span><Button disabled={go.isPending} onClick={() => go.mutate('clock-in')}>Clock in</Button></>}
      </div>
    </Card>
  );
}

function Schedule() {
  const from = ymd(new Date());
  const q = useQuery({ queryKey: ['me-schedule', from], queryFn: () => api<any[]>(`/me/schedule?from=${from}&to=${addDays(from, 14)}`) });
  const branches = useList('/org/branches');
  return (
    <Card title="Next 14 days">
      <ErrorBox error={q.error} />
      {q.data?.length === 0 ? <Empty>No shifts scheduled.</Empty> : (
        <Table head={['Date', 'Time', 'Branch', 'Status']}>
          {q.data?.map((s) => <tr key={s.id}><td className="px-3 py-2">{s.date.slice(0, 10)}</td><td className="px-3 py-2">{formatTime(s.startAt)}-{formatTime(s.endAt)}</td><td className="px-3 py-2">{nameOf(branches.data, s.branchId)}</td><td className="px-3 py-2"><StatusBadge status={s.status} /></td></tr>)}
        </Table>
      )}
    </Card>
  );
}

function MyTime() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-time'], queryFn: () => api<any[]>('/me/time') });
  const [sel, setSel] = useState<string | null>(null);
  const [c, setC] = useState({ clockIn: '', clockOut: '', note: '' });
  const correct = useMutation({ mutationFn: () => api(`/me/time/${sel}/correct`, { body: { clockIn: localToIso(c.clockIn), clockOut: localToIso(c.clockOut), note: c.note } }), onSuccess: () => { setSel(null); qc.invalidateQueries({ queryKey: ['me-time'] }); } });
  return (
    <Card>
      <ErrorBox error={q.error ?? correct.error} />
      {q.data?.length === 0 ? <Empty>No time entries.</Empty> : (
        <Table head={['In', 'Out', 'Worked (min)', 'Status', '']}>
          {q.data?.map((e) => (
            <tr key={e.id}>
              <td className="px-3 py-2 text-xs">{formatDate(e.clockIn)}</td><td className="px-3 py-2 text-xs">{formatDate(e.clockOut)}</td><td className="px-3 py-2">{e.workedMinutes ?? '-'}</td>
              <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
              <td className="px-3 py-2 text-end">{e.status !== 'APPROVED' && <Button variant="ghost" onClick={() => setSel(e.id)}>Request correction</Button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {sel && (
        <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); correct.mutate(); }}>
          <Field label="Correct clock in"><Input type="datetime-local" required value={c.clockIn} onChange={(e) => setC({ ...c, clockIn: e.target.value })} /></Field>
          <Field label="Correct clock out"><Input type="datetime-local" required value={c.clockOut} onChange={(e) => setC({ ...c, clockOut: e.target.value })} /></Field>
          <Field label="Reason"><Input required minLength={3} value={c.note} onChange={(e) => setC({ ...c, note: e.target.value })} /></Field>
          <Button disabled={correct.isPending}>Submit</Button><Button type="button" variant="ghost" onClick={() => setSel(null)}>Close</Button>
        </form>
      )}
    </Card>
  );
}

function MyLeave() {
  const qc = useQueryClient();
  const bal = useQuery({ queryKey: ['me-balances'], queryFn: () => api<any[]>('/me/leave/balances') });
  const reqs = useQuery({ queryKey: ['me-leave'], queryFn: () => api<any[]>('/me/leave/requests') });
  const [f, setF] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['me-leave'] }); qc.invalidateQueries({ queryKey: ['me-balances'] }); };
  const create = useMutation({ mutationFn: () => api('/me/leave/requests', { body: { ...f, reason: f.reason || undefined } }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/me/leave/requests/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <Card title="Balances">
          <Table head={['Type', 'Accrued', 'Used', 'Available']}>
            {bal.data?.map((b) => <tr key={b.leaveTypeId}><td className="px-3 py-2">{b.name}</td><td className="px-3 py-2">{b.accrued}</td><td className="px-3 py-2">{b.used}</td><td className="px-3 py-2 font-medium">{b.available}</td></tr>)}
          </Table>
        </Card>
        <Card title="My requests">
          <ErrorBox error={reqs.error ?? cancel.error} />
          {reqs.data?.length === 0 ? <Empty>No leave requests.</Empty> : (
            <Table head={['Type', 'From', 'To', 'Days', 'Status', '']}>
              {reqs.data?.map((r) => (
                <tr key={r.id}><td className="px-3 py-2">{nameOf(bal.data?.map((b) => ({ id: b.leaveTypeId, name: b.name })), r.leaveTypeId)}</td><td className="px-3 py-2 text-xs">{r.startDate.slice(0, 10)}</td><td className="px-3 py-2 text-xs">{r.endDate.slice(0, 10)}</td><td className="px-3 py-2">{r.days}</td><td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-3 py-2 text-end">{['PENDING', 'APPROVED'].includes(r.status) && <Button variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card title="Request leave" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Type"><Select required value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}><option value="">Select...</option>{bal.data?.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From"><Input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="To"><Input type="date" required value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Submit request</Button>
        </form>
      </Card>
    </div>
  );
}

function Swaps() {
  const qc = useQueryClient();
  const from = ymd(new Date());
  const shifts = useQuery({ queryKey: ['me-schedule', from], queryFn: () => api<any[]>(`/me/schedule?from=${from}&to=${addDays(from, 14)}`) });
  const list = useQuery({ queryKey: ['me-swaps'], queryFn: () => api<any[]>('/me/swaps') });
  const [f, setF] = useState({ scheduleId: '', toEmployeeId: '', reason: '' });
  const create = useMutation({ mutationFn: () => api('/me/swaps', { body: { ...f, reason: f.reason || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-swaps'] }) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No swap requests.</Empty> : (
          <Table head={['Shift', 'With', 'Reason', 'Status']}>
            {list.data?.map((s) => <tr key={s.id}><td className="px-3 py-2 text-xs">{s.scheduleId.slice(0, 8)}</td><td className="px-3 py-2 text-xs">{s.toEmployeeId.slice(0, 8)}</td><td className="px-3 py-2">{s.reason ?? '-'}</td><td className="px-3 py-2"><StatusBadge status={s.status} /></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Request a swap" className="lg:col-span-2">
        <ErrorBox error={create.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="My shift"><Select required value={f.scheduleId} onChange={(e) => setF({ ...f, scheduleId: e.target.value })}><option value="">Select...</option>{shifts.data?.filter((s) => s.status === 'PUBLISHED').map((s) => <option key={s.id} value={s.id}>{s.date.slice(0, 10)} {formatTime(s.startAt)}-{formatTime(s.endAt)}</option>)}</Select></Field>
          <Field label="Colleague's employee id"><Input required value={f.toEmployeeId} onChange={(e) => setF({ ...f, toEmployeeId: e.target.value })} /></Field>
          <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Request</Button>
          <p className="text-xs text-slate-500">Your manager approves the swap.</p>
        </form>
      </Card>
    </div>
  );
}

function Payslips() {
  const { lang } = useI18n();
  const q = useQuery({ queryKey: ['me-payslips'], queryFn: () => api<any[]>('/me/payslips') });
  const dl = useMutation({ mutationFn: (p: any) => download(`/me/payslips/${p.lineId}/download`, `payslip-${p.runNumber}.pdf`) });
  return (
    <Card>
      <ErrorBox error={q.error ?? dl.error} />
      {q.data?.length === 0 ? <Empty>No payslips yet.</Empty> : (
        <Table head={['Run', 'Period', 'Gross', 'Net', '']}>
          {q.data?.map((p) => (
            <tr key={p.lineId}><td className="px-3 py-2 font-medium">{p.runNumber}</td><td className="px-3 py-2 text-xs">{p.periodStart.slice(0, 10)} - {p.periodEnd.slice(0, 10)}</td><td className="px-3 py-2">{formatJOD(p.gross, lang)}</td><td className="px-3 py-2 font-medium">{formatJOD(p.net, lang)}</td>
              <td className="px-3 py-2 text-end">{p.hasPayslip ? <Button variant="ghost" onClick={() => dl.mutate(p)}>Download</Button> : <span className="text-xs text-slate-400">Not generated</span>}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Training() {
  const q = useQuery({ queryKey: ['me-training'], queryFn: () => api<any[]>('/me/training') });
  return (
    <Card>
      <ErrorBox error={q.error} />
      {q.data?.length === 0 ? <Empty>No training assigned.</Empty> : (
        <Table head={['Title', 'Mandatory', 'Due', 'Status']}>
          {q.data?.map((t) => <tr key={t.id}><td className="px-3 py-2 font-medium">{t.title}</td><td className="px-3 py-2">{t.mandatory ? 'Yes' : 'No'}</td><td className="px-3 py-2 text-xs">{t.dueDate ? t.dueDate.slice(0, 10) : '-'}</td><td className="px-3 py-2"><StatusBadge status={t.status} /></td></tr>)}
        </Table>
      )}
    </Card>
  );
}
