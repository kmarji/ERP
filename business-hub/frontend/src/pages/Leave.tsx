import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Leave() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Requests');
  return (
    <div>
      <PageHeader title={t('Leave')} subtitle="Leave requests are approved through the approval workflow (policy decides who may approve)." />
      <Tabs tabs={['Requests', 'Balances', 'Types']} value={tab} onChange={setTab} />
      {tab === 'Requests' ? <Requests /> : tab === 'Balances' ? <Balances /> : <Types />}
    </div>
  );
}

function Requests() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const types = useList('/leave/types');
  const [status, setStatus] = useState('PENDING');
  const list = useQuery({ queryKey: ['leave-requests', status], queryFn: () => api<any[]>(`/leave/requests?status=${status}`) });
  // The backend has no approve endpoint for leave: the decision lives on the generic approval for the request.
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: () => api<any[]>('/approvals?status=PENDING') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['leave-requests'] }); qc.invalidateQueries({ queryKey: ['approvals'] }); };
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/approvals/${x.id}/decide`, { body: { approve: x.approve } }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/leave/requests/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  return (
    <Card>
      <ErrorBox error={list.error ?? decide.error ?? cancel.error} />
      <div className="mb-3 w-40"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      {list.data?.length === 0 ? <Empty>No leave requests.</Empty> : (
        <Table head={['Employee', 'Type', 'From', 'To', 'Days', 'Reason', 'Status', '']}>
          {list.data?.map((r) => {
            const ap = approvals.data?.find((a) => a.subjectType === 'LeaveRequest' && a.subjectId === r.id);
            return (
              <tr key={r.id}>
                <td className="px-3 py-2 font-medium">{nameOf(emps.data, r.employeeId)}</td>
                <td className="px-3 py-2">{nameOf(types.data, r.leaveTypeId)}</td>
                <td className="px-3 py-2 text-xs">{formatDate(r.startDate).split(',')[0]}</td>
                <td className="px-3 py-2 text-xs">{formatDate(r.endDate).split(',')[0]}</td>
                <td className="px-3 py-2">{r.days}</td>
                <td className="px-3 py-2 text-slate-600">{r.reason ?? '-'}</td>
                <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="space-x-1 px-3 py-2 text-end">
                  {ap && <><Button variant="ghost" onClick={() => decide.mutate({ id: ap.id, approve: false })}>Reject</Button><Button onClick={() => decide.mutate({ id: ap.id, approve: true })}>Approve</Button></>}
                  {['PENDING', 'APPROVED'].includes(r.status) && <Button variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p className="mt-2 text-xs text-slate-500">Approve/Reject appears only when the request is waiting for your role (and you did not raise it).</p>
    </Card>
  );
}

function Balances() {
  const emps = useList('/employees');
  const [id, setId] = useState('');
  const bal = useQuery({ queryKey: ['leave-balances', id], queryFn: () => api<any[]>(`/leave/balances/${id}`), enabled: !!id });
  return (
    <Card>
      <div className="mb-3 w-64"><Field label="Employee"><Select value={id} onChange={(e) => setId(e.target.value)}><option value="">Select...</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field></div>
      <ErrorBox error={bal.error} />
      {id && (
        <Table head={['Type', 'Accrued', 'Carried', 'Used', 'Available']}>
          {bal.data?.map((b) => <tr key={b.leaveTypeId}><td className="px-3 py-2 font-medium">{b.name}</td><td className="px-3 py-2">{b.accrued}</td><td className="px-3 py-2">{b.carried}</td><td className="px-3 py-2">{b.used}</td><td className="px-3 py-2 font-medium">{b.available}</td></tr>)}
        </Table>
      )}
    </Card>
  );
}

function Types() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['list', '/leave/types'], queryFn: () => api<any[]>('/leave/types') });
  const accrue = useMutation({ mutationFn: () => api('/leave/accrue', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['leave-balances'] }) });
  return (
    <Card>
      <ErrorBox error={list.error ?? accrue.error} />
      <Table head={['Key', 'Name', 'Paid', 'Days / year', 'Monthly accrual', 'Certificate after (days)', 'Carry-over max']}>
        {list.data?.map((x) => <tr key={x.id}><td className="px-3 py-2 font-medium">{x.key}</td><td className="px-3 py-2">{x.name}</td><td className="px-3 py-2">{x.paid ? 'Yes' : 'No'}</td><td className="px-3 py-2">{x.annualDays}</td><td className="px-3 py-2">{x.accrualMonthly ? 'Yes' : 'No'}</td><td className="px-3 py-2">{x.requiresCertificateAfterDays ?? '-'}</td><td className="px-3 py-2">{x.carryOverMax ?? '-'}</td></tr>)}
      </Table>
      <Button variant="ghost" className="mt-3" disabled={accrue.isPending} onClick={() => accrue.mutate()}>Run accrual now (Owner/HR)</Button>
      {accrue.isSuccess && <span className="ms-2 text-sm text-emerald-700">Done.</span>}
      <p className="mt-2 text-xs text-slate-500">Leave types are fixed by the system; the API has no endpoint to create or edit them.</p>
    </Card>
  );
}
