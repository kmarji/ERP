import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { addDays, formatTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';
import ScheduleBoard, { Jump, OverLimit } from './ScheduleBoard';

export default function Scheduling() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Schedule');
  const [jump, setJump] = useState<Jump | null>(null);
  // Only HR and the owner may read these, so a successful read also means "reviewer".
  const escalations = useQuery({ queryKey: ['escalations'], queryFn: () => api<any[]>('/schedule-escalations'), retry: false, refetchInterval: 60_000 });
  const reviewer = escalations.isSuccess;
  const overTab = `Over limit${escalations.data?.length ? ` (${escalations.data.length})` : ''}`;
  const current = tab === 'Over limit' ? overTab : tab;
  return (
    <div>
      <PageHeader title={t('Scheduling')} subtitle="Rota per branch for any period, shift templates and swap requests. Shifts publish immediately unless the schedule.approval policy is switched on." />
      <Tabs tabs={['Schedule', ...(reviewer ? [overTab] : []), 'Templates', 'Swaps', 'Approvals', 'Open shifts', 'No-shows', 'Geofence']} value={current} onChange={(t) => { setJump(null); setTab(t.startsWith('Over limit') ? 'Over limit' : t); }} />
      {tab === 'Schedule' ? <ScheduleBoard jump={jump} reviewer={reviewer} /> : tab === 'Over limit' ? <OverLimit rows={escalations.data ?? []} onView={(j) => { setJump(j); setTab('Schedule'); }} /> : tab === 'Templates' ? <Templates /> : tab === 'Swaps' ? <Swaps /> : tab === 'Approvals' ? <ShiftApprovals /> : tab === 'Open shifts' ? <OpenShifts /> : tab === 'No-shows' ? <NoShows /> : <Geofence />}
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

function OpenShifts() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emps = useList('/employees');
  const [branchId, setBranchId] = useState('');
  const [f, setF] = useState({ date: '', start: '09:00', end: '17:00' });
  const list = useQuery({ queryKey: ['open-shifts'], queryFn: () => api<any[]>('/open-shifts') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['open-shifts'] });
  const publish = useMutation({ mutationFn: () => api('/open-shifts', { body: { branchId, date: f.date, startAt: new Date(`${f.date}T${f.start}:00+03:00`).toISOString(), endAt: new Date(new Date(`${f.date}T${f.end}:00+03:00`).getTime() + (f.end <= f.start ? 86_400_000 : 0)).toISOString() } }), onSuccess: refresh });
  const assign = useMutation({ mutationFn: (x: { id: string; employeeId: string }) => api(`/open-shifts/${x.id}/assign`, { body: { employeeId: x.employeeId } }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/open-shifts/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? assign.error ?? cancel.error} />
        {list.data?.length === 0 ? <Empty>No open shifts.</Empty> : (
          <Table head={['When', 'Branch', 'Requests', '']}>
            {list.data?.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2 text-xs">{o.date.slice(0, 10)} {formatTime(o.startAt)}-{formatTime(o.endAt)}</td>
                <td className="px-3 py-2">{nameOf(branches.data, o.branchId)}</td>
                <td className="space-y-1 px-3 py-2">{o.requests.length === 0 ? <span className="text-xs text-slate-400">none yet</span> : o.requests.map((r: any) => <div key={r.id} className="flex items-center gap-2 text-sm">{nameOf(emps.data, r.employeeId)}<Button variant="ghost" disabled={assign.isPending} onClick={() => assign.mutate({ id: o.id, employeeId: r.employeeId })}>Assign</Button></div>)}</td>
                <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => cancel.mutate(o.id)}>Cancel</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Publish an open shift" className="lg:col-span-2">
        <ErrorBox error={publish.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); publish.mutate(); }}>
          <Field label="Branch"><Select required value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Date"><Input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Start"><Input type="time" required value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field><Field label="End"><Input type="time" required value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field></div>
          <Button disabled={publish.isPending}>Publish</Button>
          <p className="text-xs text-slate-500">Employees see it only if they pass the rest, overlap, leave and weekly-hours checks. Assigning runs the checks again.</p>
        </form>
      </Card>
    </div>
  );
}

// A flag is not a disciplinary finding; this tab only finds cover for the shift.
function NoShows() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const branches = useList('/org/branches');
  const from = addDays(new Date().toISOString().slice(0, 10), -2);
  const [sel, setSel] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['noshows'], queryFn: () => api<any[]>(`/schedules?from=${from}`).then((r) => r.filter((s) => s.noShowAt && s.status === 'PUBLISHED')) });
  const cands = useQuery({ queryKey: ['coverage', sel], queryFn: () => api<any[]>(`/schedules/${sel}/coverage-candidates`), enabled: !!sel });
  const flag = useMutation({ mutationFn: () => api('/schedules/flag-no-shows', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['noshows'] }) });
  const cover = useMutation({ mutationFn: (employeeId: string) => api(`/schedules/${sel}/cover`, { body: { employeeId } }), onSuccess: () => { setSel(null); qc.invalidateQueries({ queryKey: ['noshows'] }); } });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Missed clock-ins awaiting cover">
        <ErrorBox error={list.error ?? flag.error} />
        <Button variant="ghost" disabled={flag.isPending} onClick={() => flag.mutate()}>Check now</Button>
        {list.data?.length === 0 ? <Empty>No uncovered no-shows.</Empty> : (
          <Table head={['Employee', 'Shift', 'Branch', '']}>
            {list.data?.map((s) => <tr key={s.id}><td className="px-3 py-2">{nameOf(emps.data, s.employeeId)}</td><td className="px-3 py-2 text-xs">{s.date.slice(0, 10)} {formatTime(s.startAt)}-{formatTime(s.endAt)}</td><td className="px-3 py-2">{nameOf(branches.data, s.branchId)}</td><td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => setSel(s.id)}>Find cover</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Eligible replacements">
        <ErrorBox error={cands.error ?? cover.error} />
        {!sel ? <Empty>Pick a shift.</Empty> : cands.data?.length === 0 ? <Empty>No eligible replacement.</Empty> : cands.data?.map((c) => <div key={c.employeeId} className="flex items-center justify-between py-1 text-sm">{c.name}<Button disabled={cover.isPending} onClick={() => cover.mutate(c.employeeId)}>Authorize cover</Button></div>)}
      </Card>
    </div>
  );
}

function Geofence() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const blank = { branchId: '', latitude: '', longitude: '', radiusM: '100' };
  const [f, setF] = useState(blank);
  const refresh = () => qc.invalidateQueries({ queryKey: ['list', '/org/branches'] });
  const save = useMutation({ mutationFn: () => api(`/branches/${f.branchId}/geofence`, { body: { latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: Number(f.radiusM) } }), onSuccess: () => { refresh(); setF(blank); } });
  const clear = useMutation({ mutationFn: (id: string) => api(`/branches/${id}/geofence/clear`, { method: 'POST' }), onSuccess: refresh });
  // Choosing a branch loads what is saved for it (or blanks the form), never the previous branch's coordinates.
  const pick = (id: string) => {
    const b = branches.data?.find((x) => x.id === id);
    setF(b?.geofenceM ? { branchId: id, latitude: String(Number(b.latitude)), longitude: String(Number(b.longitude)), radiusM: String(b.geofenceM) } : { ...blank, branchId: id });
    save.reset();
  };
  const here = () => navigator.geolocation.getCurrentPosition((p) => setF((x) => ({ ...x, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })));
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card title="Saved geofences" className="lg:col-span-3">
        <ErrorBox error={clear.error} />
        <Table head={['Branch', 'Latitude', 'Longitude', 'Radius', 'Status', '']}>
          {branches.data?.map((b) => {
            const on = !!b.geofenceM;
            return (
              <tr key={b.id}>
                <td className="px-3 py-2 font-medium">{b.name}</td>
                <td className="px-3 py-2 text-xs">{on ? Number(b.latitude).toFixed(6) : '-'}</td>
                <td className="px-3 py-2 text-xs">{on ? Number(b.longitude).toFixed(6) : '-'}</td>
                <td className="px-3 py-2 text-xs">{on ? `${b.geofenceM} m` : '-'}</td>
                <td className="px-3 py-2">{on ? <Badge tone="bg-emerald-100 text-emerald-800">On</Badge> : <Badge>Off</Badge>}</td>
                <td className="space-x-1 px-3 py-2 text-end"><Button variant="ghost" onClick={() => pick(b.id)}>{on ? 'Edit' : 'Set'}</Button>{on && <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate(b.id)}>Turn off</Button>}</td>
              </tr>
            );
          })}
        </Table>
        <p className="mt-2 text-xs text-slate-500">With a geofence on, employees must share their location to clock in and be within the radius. Off means they can clock in from anywhere.</p>
      </Card>
      <Card title="Set a branch geofence (owner / HR)" className="lg:col-span-2">
        <ErrorBox error={save.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Branch"><Select required value={f.branchId} onChange={(e) => pick(e.target.value)}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Latitude"><Input type="number" step="any" required value={f.latitude} onChange={(e) => setF({ ...f, latitude: e.target.value })} /></Field>
            <Field label="Longitude"><Input type="number" step="any" required value={f.longitude} onChange={(e) => setF({ ...f, longitude: e.target.value })} /></Field>
            <Field label="Radius (m)"><Input type="number" min="20" max="5000" required value={f.radiusM} onChange={(e) => setF({ ...f, radiusM: e.target.value })} /></Field>
          </div>
          <div className="flex gap-2"><Button disabled={save.isPending}>Save</Button><Button type="button" variant="ghost" onClick={here}>Use my location</Button></div>
          {save.isSuccess && <p className="text-xs text-emerald-700">Saved. It now shows in the table.</p>}
        </form>
      </Card>
    </div>
  );
}

function ShiftApprovals() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const branches = useList('/org/branches');
  const list = useQuery({ queryKey: ['shift-approvals'], queryFn: () => api<any[]>(`/schedules?from=${addDays(new Date().toISOString().slice(0, 10), -1)}`).then((r) => r.filter((s) => s.status === 'PENDING_APPROVAL')) });
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/schedules/${x.id}/decide`, { body: { approve: x.approve } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['shift-approvals'] }); qc.invalidateQueries({ queryKey: ['schedules'] }); } });
  return (
    <Card>
      <ErrorBox error={list.error ?? decide.error} />
      {list.data?.length === 0 ? <Empty>No shifts waiting. Approval is only used when the schedule.approval policy is on (Policies screen).</Empty> : (
        <Table head={['Employee', 'Shift', 'Branch', '']}>
          {list.data?.map((s) => (
            <tr key={s.id}><td className="px-3 py-2">{nameOf(emps.data, s.employeeId)}</td><td className="px-3 py-2 text-xs">{s.date.slice(0, 10)} {formatTime(s.startAt)}-{formatTime(s.endAt)}</td><td className="px-3 py-2">{nameOf(branches.data, s.branchId)}</td>
              <td className="space-x-1 px-3 py-2 text-end"><Button variant="ghost" onClick={() => decide.mutate({ id: s.id, approve: false })}>Reject</Button><Button onClick={() => decide.mutate({ id: s.id, approve: true })}>Approve</Button></td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
