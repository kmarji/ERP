import { AttachmentList } from '../components/Attachments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api, ApiError, download, upload } from '../lib/api';
import { cachedGet, flush, isNetworkError, queue, type Photo } from '../lib/offline';
import { addDays, formatDate, formatJOD, formatTime, localToIso, ymd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function MySpace() {
  const { t } = useI18n();
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') ?? 'Tasks');
  const profile = useQuery({ queryKey: ['me-profile'], queryFn: () => api<any>('/me/profile'), retry: false });
  if (profile.error) {
    const none = (profile.error as ApiError).status === 404;
    return <div><PageHeader title={t('My space')} /><Card><Empty>{none ? 'Your login is not linked to an employee record, so there is nothing to show here. Ask HR to link your account.' : (profile.error as Error).message}</Empty></Card></div>;
  }
  return (
    <div>
      <PageHeader title={t('My space')} subtitle={profile.data ? `${profile.data.name} · ${profile.data.number}` : ''} />
      <Punch />
      <Tabs tabs={['Tasks', 'Notifications', 'Safety', 'Learning', 'Schedule', 'Time', 'Leave', 'Swaps', 'Open shifts', 'Warnings', 'Offboarding', 'Payslips']} value={tab} onChange={setTab} />
      {tab === 'Tasks' ? <Tasks /> : tab === 'Notifications' ? <Notifications /> : tab === 'Safety' ? <Safety /> : tab === 'Learning' ? <Learning /> : tab === 'Schedule' ? <Schedule /> : tab === 'Time' ? <MyTime /> : tab === 'Leave' ? <MyLeave /> : tab === 'Swaps' ? <Swaps /> : tab === 'Open shifts' ? <OpenShifts /> : tab === 'Warnings' ? <Warnings /> : tab === 'Offboarding' ? <MyOffboarding /> : <Payslips />}
    </div>
  );
}

function Punch() {
  const qc = useQueryClient();
  const entries = useQuery({ queryKey: ['me-time'], queryFn: () => api<any[]>('/me/time') });
  const open = entries.data?.find((e) => e.status === 'OPEN');
  const [geoDenied, setGeoDenied] = useState(false);
  const where = () => new Promise<{ lat?: number; lng?: number }>((ok) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { setGeoDenied(false); ok({ lat: p.coords.latitude, lng: p.coords.longitude }); }, () => { setGeoDenied(true); ok({}); }, { timeout: 8000 }) : (setGeoDenied(true), ok({})));
  const go = useMutation({ mutationFn: async (p: string) => api(`/me/${p}`, { method: 'POST', body: p === 'clock-in' ? await where() : {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-time'] }) });
  return (
    <Card className="mb-4">
      <ErrorBox error={go.error} />
      {geoDenied && go.error && <p className="mb-2 text-sm text-amber-700">Your browser did not share your location. Allow location access for this site (needs https) and try again.</p>}
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
  const colleagues = useQuery({ queryKey: ['me-colleagues'], queryFn: () => api<any[]>('/me/colleagues') });
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
          <Field label="Colleague"><Select required value={f.toEmployeeId} onChange={(e) => setF({ ...f, toEmployeeId: e.target.value })}><option value="">Select...</option>{colleagues.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
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

// E12 My Tasks / E13 Checklist Execution. Works without a connection: lists and checklists are cached, answers queue and sync later.
function Tasks() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-checklists'], queryFn: async () => { const r = await cachedGet<any[]>('/me/checklists'); r.filter((x) => ['PENDING', 'OVERDUE'].includes(x.status)).forEach((x) => cachedGet(`/me/checklists/${x.id}`).catch(() => undefined)); return r; } });
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const waiting = queue.list();
  const sync = useMutation({ mutationFn: flush, onSuccess: () => { setTick(tick + 1); qc.invalidateQueries({ queryKey: ['me-checklists'] }); } });
  if (open) return <Execute id={open} onDone={() => { setOpen(null); setTick(tick + 1); q.refetch(); }} />;
  const queued = new Set(waiting.map((w) => w.runId));
  return (
    <div className="space-y-4">
      {waiting.length > 0 && (
        <Card title={`Waiting to sync (${waiting.length})`}>
          {waiting.map((w) => <p key={w.runId} className="text-sm">{w.name}: {w.error ? <span className="text-red-700">refused: {w.error}</span> : w.note ? <span className="text-amber-700">{w.note}</span> : 'saved on this device'} {(w.error || w.note) && <button className="text-xs text-brand-600 underline" onClick={() => { queue.remove(w.runId); setTick(tick + 1); }}>dismiss</button>}</p>)}
          <Button variant="ghost" disabled={sync.isPending} onClick={() => sync.mutate()}>Sync now</Button>
          {sync.data && <span className="ms-2 text-xs text-slate-500">{sync.data.synced} synced{sync.data.already ? `, ${sync.data.already} already on the server` : ''}{sync.data.failed ? `, ${sync.data.failed} refused` : ''}</span>}
        </Card>
      )}
      <Card>
        <ErrorBox error={q.error} />
        {q.data?.length === 0 ? <Empty>No tasks.</Empty> : (
          <Table head={['Checklist', 'Due', 'Status', '']}>
            {q.data?.map((r) => <tr key={r.id}><td className="px-3 py-2 font-medium">{r.name}{!r.assignmentId && <span className="ms-1 text-xs text-slate-500">(requested by your manager)</span>}{r.note && <div className="text-xs text-slate-500">{r.note}</div>}</td><td className="px-3 py-2 text-xs">{formatDate(r.dueAt)}</td><td className="px-3 py-2">{queued.has(r.id) ? <span className="text-xs text-amber-700">saved, not synced</span> : <StatusBadge status={r.status} />}</td><td className="px-3 py-2 text-end">{['PENDING', 'OVERDUE'].includes(r.status) && !queued.has(r.id) && <Button onClick={() => setOpen(r.id)}>Start</Button>}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

const toDataUrl = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = no; r.readAsDataURL(f); });

function Execute({ id, onDone }: { id: string; onDone: () => void }) {
  const q = useQuery({ queryKey: ['me-checklist', id], queryFn: () => cachedGet<any>(`/me/checklists/${id}`) });
  const [ans, setAns] = useState<Record<string, { ok?: boolean; note?: string; docId?: string; photo?: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: object) => setAns((a) => ({ ...a, [k]: { ...a[k], ...v } }));
  const items: any[] = q.data?.template.items ?? [];
  const complete = items.length > 0 && items.every((i) => ans[i.id]?.ok !== undefined && (!i.evidenceRequired || ans[i.id]?.docId || ans[i.id]?.photo));
  const submit = useMutation({
    mutationFn: async () => {
      const completedAt = new Date().toISOString();
      const body = { completedAt, answers: items.map((i) => ({ itemId: i.id, ok: ans[i.id].ok!, note: ans[i.id].note || undefined, docId: ans[i.id].docId })) };
      const photos: Photo[] = items.filter((i) => ans[i.id].photo && !ans[i.id].docId).map((i) => ({ itemId: i.id, dataUrl: ans[i.id].photo!, name: `${i.id}.jpg` }));
      const park = () => { if (!queue.add({ runId: id, name: q.data.template.name, answers: body.answers, photos, completedAt })) throw new Error('This device is out of storage: remove the photos or connect to send now.'); setSaved(true); };
      if (!navigator.onLine) return park();
      try {
        for (const p of photos) { const d = await upload('/documents', new File([await (await fetch(p.dataUrl)).blob()], p.name, { type: 'image/jpeg' })); body.answers.find((a) => a.itemId === p.itemId)!.docId = d.id; }
        await api(`/me/checklists/${id}/submit`, { body });
        onDone();
      } catch (e) {
        if (isNetworkError(e)) park(); else throw e;
      }
    },
  });
  const attach = async (itemId: string, file?: File) => {
    if (!file) return;
    setBusy(itemId); setErr(null);
    try {
      if (!navigator.onLine) set(itemId, { photo: await toDataUrl(file) });
      else set(itemId, { docId: (await upload('/documents', file)).id });
    } catch (e) {
      if (isNetworkError(e)) set(itemId, { photo: await toDataUrl(file) }); else setErr(e);
    } finally { setBusy(null); }
  };
  if (saved) return <Card><p className="text-sm text-amber-700">No connection: your answers are saved on this device and will be sent automatically when it is back online.</p><Button className="mt-2" onClick={onDone}>OK</Button></Card>;
  return (
    <Card title={q.data ? q.data.template.name : 'Checklist'}>
      <ErrorBox error={q.error ?? err ?? submit.error} />
      {q.data?.template.attachments?.length > 0 && <div className="mb-3 rounded bg-slate-50 p-2"><div className="mb-1 text-xs font-medium text-slate-600">Guides for this checklist</div><AttachmentList items={q.data.template.attachments} /></div>}
      <div className="space-y-3">
        {items.map((i) => (
          <div key={i.id} className="rounded border border-slate-200 p-2 text-sm">
            <p className="font-medium">{i.label}{i.critical && <b className="ms-2 text-xs text-red-600">critical</b>}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button type="button" variant={ans[i.id]?.ok === true ? 'primary' : 'ghost'} onClick={() => set(i.id, { ok: true })}>Pass</Button>
              <Button type="button" variant={ans[i.id]?.ok === false ? 'danger' : 'ghost'} onClick={() => set(i.id, { ok: false })}>Fail</Button>
              <Input className="w-56" placeholder="Note (optional)" value={ans[i.id]?.note ?? ''} onChange={(e) => set(i.id, { note: e.target.value })} />
              {i.evidenceRequired && <label className="text-xs">{ans[i.id]?.docId ? '✓ photo attached' : ans[i.id]?.photo ? '✓ photo kept on this device' : busy === i.id ? 'Saving...' : 'Photo required:'} <input type="file" accept="image/*" capture="environment" onChange={(e) => attach(i.id, e.target.files?.[0])} /></label>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2"><Button disabled={!complete || submit.isPending || !!busy} onClick={() => submit.mutate()}>Submit</Button><Button variant="ghost" onClick={onDone}>Back</Button></div>
      {!navigator.onLine && <p className="mt-2 text-xs text-amber-700">You are offline. Submitting saves it on this device and syncs later.</p>}
    </Card>
  );
}

// E17: HR and Operations notifications
function Notifications() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<any[]>('/notifications') });
  const read = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['notif-count'] }); } });
  return (
    <Card>
      <ErrorBox error={q.error ?? read.error} />
      {q.data?.length === 0 ? <Empty>No notifications.</Empty> : q.data?.map((n) => (
        <div key={n.id} className={`flex items-start justify-between gap-3 border-t border-slate-100 py-2 text-sm first:border-0 ${n.readAt ? 'text-slate-400' : ''}`}>
          <div><p className="font-medium">{n.title}</p>{n.body && <p className="text-xs">{n.body}</p>}<p className="text-xs text-slate-400">{formatDate(n.createdAt)}</p></div>
          {!n.readAt && <Button variant="ghost" onClick={() => read.mutate(n.id)}>Mark read</Button>}
        </div>
      ))}
    </Card>
  );
}

// E14 Training & SOPs, E15 Mandatory Examinations, E16 Training Results
function Learning() {
  const q = useQuery({ queryKey: ['me-learning'], queryFn: () => api<any[]>('/me/learning') });
  const legacy = useQuery({ queryKey: ['me-training'], queryFn: () => api<any[]>('/me/training').then((r) => r.filter((t) => !t.itemCode)) });
  const res = useQuery({ queryKey: ['me-results'], queryFn: () => api<any>('/me/learning/results') });
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <Study id={open} onDone={() => { setOpen(null); q.refetch(); res.refetch(); }} />;
  return (
    <div className="space-y-4">
      <Card title="My training">
        <ErrorBox error={q.error} />
        {q.data?.length === 0 ? <Empty>No training assigned.</Empty> : (
          <Table head={['Title', 'Due', 'Status', 'Best', '']}>
            {q.data?.map((a) => <tr key={a.id}><td className="px-3 py-2 font-medium">{a.title}</td><td className="px-3 py-2 text-xs">{a.dueDate?.slice(0, 10) ?? '-'}</td><td className="px-3 py-2"><StatusBadge status={a.status} /></td><td className="px-3 py-2">{a.bestScore != null ? `${a.bestScore}%` : '-'}</td><td className="px-3 py-2 text-end">{['ASSIGNED', 'IN_PROGRESS', 'EXAM_PENDING'].includes(a.status) && <Button onClick={() => setOpen(a.id)}>{a.status === 'ASSIGNED' ? 'Start' : 'Continue'}</Button>}{a.status === 'FAILED' && <span className="text-xs text-red-600">No attempts left. Ask your manager.</span>}</td></tr>)}
          </Table>
        )}
      </Card>
      {!!legacy.data?.length && (
        <Card title="Onboarding items (no exam)">
          <Table head={['Title', 'Mandatory', 'Due', 'Status']}>
            {legacy.data.map((t) => <tr key={t.id}><td className="px-3 py-2 font-medium">{t.title}</td><td className="px-3 py-2">{t.mandatory ? 'Yes' : 'No'}</td><td className="px-3 py-2 text-xs">{t.dueDate?.slice(0, 10) ?? '-'}</td><td className="px-3 py-2"><StatusBadge status={t.status} /></td></tr>)}
          </Table>
        </Card>
      )}
      <Card title="My evaluations">
        {res.data?.evaluations.length === 0 ? <Empty>None yet.</Empty> : res.data?.evaluations.map((v: any) => <p key={v.id} className="py-1 text-sm"><b>{v.topic}</b> {'★'.repeat(v.rating)}{'☆'.repeat(5 - v.rating)} <span className="text-slate-500">{v.notes}</span></p>)}
      </Card>
    </div>
  );
}

function Study({ id, onDone }: { id: string; onDone: () => void }) {
  const doc = useQuery({ queryKey: ['me-study', id], queryFn: () => api<any>(`/me/learning/${id}/open`, { method: 'POST' }) });
  const [exam, setExam] = useState<any>(null);
  const [ans, setAns] = useState<Record<string, number>>({});
  const [result, setResult] = useState<any>(null);
  const start = useMutation({ mutationFn: () => api<any>(`/me/learning/${id}/exam`, { method: 'POST' }), onSuccess: (r) => { setExam(r); setAns({}); } });
  const submit = useMutation({ mutationFn: () => api<any>(`/me/learning/attempts/${exam.attemptId}/submit`, { body: { answers: Object.entries(ans).map(([questionId, index]) => ({ questionId, index })) } }), onSuccess: (r) => { setResult(r); setExam(null); } });
  const item = doc.data?.item;
  return (
    <Card title={item?.title ?? 'Training'}>
      <ErrorBox error={doc.error ?? start.error ?? submit.error} />
      {result ? (
        <div className="space-y-2 text-sm">
          <p className={result.passed ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>{result.passed ? 'Passed' : 'Not passed'}: {result.score}% (pass mark {result.passScore}%)</p>
          {!result.passed && result.attemptsLeft > 0 && <Button onClick={() => { setResult(null); start.mutate(); }}>Try again ({result.attemptsLeft} left)</Button>}
          <Button variant="ghost" onClick={onDone}>Back</Button>
        </div>
      ) : exam ? (
        <div className="space-y-3">
          {exam.questions.map((q: any, n: number) => (
            <div key={q.id} className="text-sm"><p className="font-medium">{n + 1}. {q.text}</p>
              {q.options.map((o: string, i: number) => <label key={i} className="block"><input type="radio" name={q.id} checked={ans[q.id] === i} onChange={() => setAns({ ...ans, [q.id]: i })} /> {o}</label>)}</div>
          ))}
          <Button disabled={submit.isPending || Object.keys(ans).length < exam.questions.length} onClick={() => submit.mutate()}>Submit exam</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="whitespace-pre-wrap text-sm">{item?.body}</div>
          <AttachmentList items={item?.attachments} />
          <div className="flex gap-2"><Button disabled={start.isPending} onClick={() => start.mutate()}>I have read this: take the exam</Button><Button variant="ghost" onClick={onDone}>Back</Button></div>
          {item && <p className="text-xs text-slate-500">Pass mark {item.passScore}% · up to {item.maxAttempts} attempts · {item.questionsPerAttempt} questions, drawn at random.</p>}
        </div>
      )}
    </Card>
  );
}

function OpenShifts() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const q = useQuery({ queryKey: ['me-open-shifts'], queryFn: () => api<any[]>('/me/open-shifts') });
  const req = useMutation({ mutationFn: (id: string) => api(`/me/open-shifts/${id}/request`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-open-shifts'] }) });
  return (
    <Card>
      <ErrorBox error={q.error ?? req.error} />
      {q.data?.length === 0 ? <Empty>No open shifts you can take.</Empty> : (
        <Table head={['Date', 'Time', 'Branch', '']}>
          {q.data?.map((o) => <tr key={o.id}><td className="px-3 py-2">{o.date.slice(0, 10)}</td><td className="px-3 py-2">{formatTime(o.startAt)}-{formatTime(o.endAt)}</td><td className="px-3 py-2">{nameOf(branches.data, o.branchId)}</td><td className="px-3 py-2 text-end"><Button variant="ghost" disabled={req.isPending} onClick={() => req.mutate(o.id)}>Request</Button></td></tr>)}
        </Table>
      )}
      {req.isSuccess && <p className="mt-2 text-xs text-emerald-700">Requested. Your manager decides.</p>}
    </Card>
  );
}

// E10: respond, acknowledge receipt (not agreement) and appeal.
function Warnings() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-warnings'], queryFn: () => api<any[]>('/me/warnings') });
  const [text, setText] = useState<Record<string, string>>({});
  const act = useMutation({ mutationFn: (x: { id: string; path: string; body?: unknown }) => api(`/me/warnings/${x.id}/${x.path}`, { body: x.body ?? {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-warnings'] }) });
  return (
    <div className="space-y-4">
      <ErrorBox error={q.error ?? act.error} />
      {q.data?.length === 0 && <Card><Empty>No notices.</Empty></Card>}
      {q.data?.map((c) => (
        <Card key={c.id} title={`${c.number} · ${c.category}`}>
          <p className="text-sm"><StatusBadge status={c.status} /> {c.description}</p>
          {c.sanction && <p className="mt-1 text-sm"><b>Decision:</b> {c.sanctionLabel ?? c.sanction}{c.fineAmount ? ` · deduction ${formatJOD(c.fineAmount, lang)}` : ''}{c.legalBasis ? ` · ${c.legalBasis}` : ''}</p>}
          {['EMPLOYEE_RESPONSE', 'NOTIFIED'].includes(c.status) && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label={c.status === 'NOTIFIED' ? 'Appeal (optional)' : 'Your response'}><Input value={text[c.id] ?? ''} onChange={(e) => setText({ ...text, [c.id]: e.target.value })} /></Field>
              {c.status === 'EMPLOYEE_RESPONSE' && <Button disabled={act.isPending || (text[c.id] ?? '').length < 3} onClick={() => act.mutate({ id: c.id, path: 'respond', body: { text: text[c.id] } })}>Send response</Button>}
              {c.status === 'NOTIFIED' && <>
                {!c.acknowledgedAt && <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: c.id, path: 'acknowledge' })}>Acknowledge receipt</Button>}
                <Button variant="danger" disabled={act.isPending || (text[c.id] ?? '').length < 3} onClick={() => act.mutate({ id: c.id, path: 'appeal', body: { text: text[c.id] } })}>Appeal</Button>
              </>}
            </div>
          )}
          {c.status === 'NOTIFIED' && <p className="mt-1 text-xs text-slate-500">Acknowledging receipt does not mean you agree.</p>}
        </Card>
      ))}
    </div>
  );
}

function MyOffboarding() {
  const { lang } = useI18n();
  const q = useQuery({ queryKey: ['me-offboarding'], queryFn: () => api<any>('/me/offboarding') });
  const o = q.data;
  return (
    <Card>
      <ErrorBox error={q.error} />
      {!o ? <Empty>No offboarding in progress.</Empty> : (
        <div className="space-y-2 text-sm">
          <p><StatusBadge status={o.status} /> {o.reason} · notice {o.noticeDate.slice(0, 10)} · last day {o.lastWorkingDay.slice(0, 10)}</p>
          <ul>{(o.checklist as any[]).map((c) => <li key={c.key}>{c.done ? '✓' : '○'} {c.label}</li>)}</ul>
          {o.settlement ? <p><b>Approved settlement:</b> {formatJOD(o.settlement.total, lang)}</p> : <p className="text-xs text-slate-500">Settlement figures appear once approved.</p>}
        </div>
      )}
    </Card>
  );
}

// Food-safety readings and corrective actions assigned to me
function Safety() {
  const qc = useQueryClient();
  const points = useQuery({ queryKey: ['me-fs-points'], queryFn: () => api<any[]>('/me/food-safety/points') });
  const acts = useQuery({ queryKey: ['me-actions'], queryFn: () => api<any[]>('/me/actions') });
  const [v, setV] = useState<Record<string, string>>({});
  const [last, setLast] = useState<Record<string, boolean>>({});
  const rec = useMutation({ mutationFn: (p: any) => api<any>('/me/food-safety/readings', { body: { pointId: p.id, value: Number(v[p.id]) } }), onSuccess: (r, p) => { setLast({ ...last, [p.id]: r.inRange }); setV({ ...v, [p.id]: '' }); qc.invalidateQueries({ queryKey: ['me-actions'] }); qc.invalidateQueries({ queryKey: ['me-fs-points'] }); } });
  const [open, setOpen] = useState<string | null>(null);
  const [fix, setFix] = useState({ note: '', docId: '' });
  const [err, setErr] = useState<unknown>(null);
  const done = useMutation({ mutationFn: () => api(`/me/actions/${open}/complete`, { body: { note: fix.note, docIds: [fix.docId] } }), onSuccess: () => { setOpen(null); setFix({ note: '', docId: '' }); qc.invalidateQueries({ queryKey: ['me-actions'] }); } });
  const attach = async (file?: File) => { if (!file) return; setErr(null); try { setFix((x) => ({ ...x, docId: '' })); const d = await upload('/documents', file); setFix((x) => ({ ...x, docId: d.id })); } catch (e) { setErr(e); } };
  return (
    <div className="space-y-4">
      <Card title="Record a measurement">
        <ErrorBox error={points.error ?? rec.error} />
        {points.data?.length === 0 ? <Empty>No measurement points at your branch.</Empty> : points.data?.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 border-t border-slate-100 py-2 text-sm first:border-0">
            <span className="w-44 font-medium">{p.name}<span className="block text-xs text-slate-500">allowed {p.minValue ?? '-'} to {p.maxValue ?? '-'} {p.unit}{p.readingTimes?.length > 0 && <span className="block">scheduled {p.readingTimes.join(', ')}</span>}{p.dueSlots?.length > 0 && <span className="block font-semibold text-amber-700">Due: {p.dueSlots.join(', ')}</span>}</span></span>
            <Input className="w-28" type="number" step="0.1" placeholder={p.unit} value={v[p.id] ?? ''} onChange={(e) => setV({ ...v, [p.id]: e.target.value })} />
            <Button disabled={!v[p.id] || rec.isPending} onClick={() => rec.mutate(p)}>Record</Button>
            {last[p.id] === true && <span className="text-xs text-emerald-700">OK</span>}
            {last[p.id] === false && <span className="text-xs font-semibold text-red-700">Out of range. Your manager has been alerted.</span>}
          </div>
        ))}
      </Card>
      <Card title="Corrective actions for me">
        <ErrorBox error={acts.error ?? err ?? done.error} />
        {acts.data?.length === 0 ? <Empty>Nothing assigned.</Empty> : acts.data?.map((a) => (
          <div key={a.id} className="border-t border-slate-100 py-2 text-sm first:border-0">
            <div className="flex items-center justify-between"><span><b>{a.number}</b> {a.title} <span className="text-xs text-slate-500">due {a.dueAt?.slice(0, 10) ?? '-'}</span></span><span className="flex items-center gap-2"><StatusBadge status={a.status} />{a.status === 'IN_PROGRESS' && <Button variant="ghost" onClick={() => setOpen(a.id)}>Report fix</Button>}</span></div>
            {open === a.id && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="What you did"><Input value={fix.note} onChange={(e) => setFix({ ...fix, note: e.target.value })} /></Field>
                <label className="text-xs">{fix.docId ? '✓ photo attached' : 'Photo required:'} <input type="file" accept="image/*" capture="environment" onChange={(e) => attach(e.target.files?.[0])} /></label>
                <Button disabled={fix.note.length < 3 || !fix.docId || done.isPending} onClick={() => done.mutate()}>Submit</Button>
              </div>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
