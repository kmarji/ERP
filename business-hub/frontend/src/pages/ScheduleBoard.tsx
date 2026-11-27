import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, Select, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { addDays, addMonths, formatTime, weekStartOf, ymd } from '../lib/format';
import { nameOf, useList } from '../lib/lookups';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIODS = { week: '1 week', fortnight: '2 weeks', month: 'Month', custom: 'Custom' };
type Period = keyof typeof PERIODS;
export type Jump = { branchId: string; start: string; search: string };

const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const hours = (min: number) => `${+(min / 60).toFixed(2)} h`;
const length = (s: any) => (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60_000;
const counted = (s: any) => s.status === 'PUBLISHED' || s.status === 'PENDING_APPROVAL';

export const useScheduleSettings = () => useQuery({ queryKey: ['schedule-settings'], queryFn: () => api<{ weekStartsOn: number; maxWeeklyMinutes: number }>('/schedule-settings') });

export default function ScheduleBoard({ jump, reviewer }: { jump: Jump | null; reviewer: boolean }) {
  const qc = useQueryClient();
  const settings = useScheduleSettings();
  const branches = useList('/org/branches');
  const positions = useList('/recruitment/positions');
  const [branchId, setBranchId] = useState(jump?.branchId ?? '');
  const [picked, setPicked] = useState(jump?.start ?? '');
  const [period, setPeriod] = useState<Period>('week');
  const [customEnd, setCustomEnd] = useState('');
  const [filter, setFilter] = useState({ search: jump?.search ?? '', positionId: '', department: '', section: '' });
  const [edit, setEdit] = useState<{ employee: any; date: string; shift?: any } | null>(null);

  const start = picked || (settings.data ? weekStartOf(settings.data.weekStartsOn) : '');
  const maxEnd = start && addDays(start, 61);
  const end = !start ? '' : period === 'week' ? addDays(start, 6) : period === 'fortnight' ? addDays(start, 13) : period === 'month' ? addDays(addMonths(start, 1), -1)
    : customEnd < start ? start : customEnd > maxEnd ? maxEnd : customEnd;
  const days = start ? Array.from({ length: (utc(end).getTime() - utc(start).getTime()) / 86_400_000 + 1 }, (_, i) => addDays(start, i)) : [];
  const move = (dir: 1 | -1) => {
    if (period === 'month') return setPicked(addMonths(start, dir));
    setPicked(addDays(start, dir * days.length));
    if (period === 'custom') setCustomEnd(addDays(end, dir * days.length));
  };

  const ready = !!branchId && !!start;
  const emps = useQuery({ queryKey: ['employees', 'branch', branchId], queryFn: () => api<any[]>(`/employees?branchId=${branchId}&status=ACTIVE`), enabled: !!branchId });
  // All branches, so hours worked elsewhere are visible too.
  const shifts = useQuery({ queryKey: ['schedules', start, end], queryFn: () => api<any[]>(`/schedules?from=${start}&to=${end}`), enabled: ready });
  const weeks = useQuery({ queryKey: ['schedules', 'summary', start, end, settings.data?.weekStartsOn], queryFn: () => api<any[]>(`/schedules/summary?from=${start}&to=${end}`), enabled: ready });
  const setWeekStart = useMutation({ mutationFn: (weekStartsOn: number) => api('/schedule-settings', { method: 'PUT', body: { weekStartsOn } }), onSuccess: () => { setPicked(''); qc.invalidateQueries({ queryKey: ['schedule-settings'] }); qc.invalidateQueries({ queryKey: ['schedules'] }); } });

  const options = (key: 'department' | 'section') => [...new Set((emps.data ?? []).map((e) => e[key]).filter(Boolean))].sort() as string[];
  const q = filter.search.trim().toLowerCase();
  const shown = (emps.data ?? []).filter((e) =>
    (!q || [e.name, e.nameAr, e.number].some((v) => v?.toLowerCase().includes(q))) &&
    (!filter.positionId || e.positionId === filter.positionId) &&
    (!filter.department || e.department === filter.department) &&
    (!filter.section || e.section === filter.section));
  const setF = (k: keyof typeof filter) => (ev: { target: { value: string } }) => setFilter({ ...filter, [k]: ev.target.value });

  return (
    <div className="space-y-4">
      <ErrorBox error={settings.error ?? emps.error ?? shifts.error ?? weeks.error ?? setWeekStart.error} />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Branch"><Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setEdit(null); }}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Start date"><Input type="date" value={start} onChange={(e) => e.target.value && setPicked(e.target.value)} /></Field>
          <Field label="Period"><Select value={period} onChange={(e) => { setPeriod(e.target.value as Period); setCustomEnd(end); }}>{Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          {period === 'custom' && <Field label="End date (up to 62 days)"><Input type="date" min={start} max={maxEnd} value={end} onChange={(e) => e.target.value && setCustomEnd(e.target.value)} /></Field>}
          <Button variant="ghost" aria-label="Previous period" disabled={!start} onClick={() => move(-1)}>&lt;</Button>
          <Button variant="ghost" aria-label="Next period" disabled={!start} onClick={() => move(1)}>&gt;</Button>
          <Button variant="ghost" onClick={() => setPicked('')}>This week</Button>
          {reviewer && <Field label="Company week starts on"><Select value={settings.data?.weekStartsOn ?? 1} disabled={setWeekStart.isPending} onChange={(e) => setWeekStart.mutate(Number(e.target.value))}>{DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Search employee"><Input type="search" placeholder="Name or number" value={filter.search} onChange={setF('search')} /></Field>
          <Field label="Job role"><Select value={filter.positionId} onChange={setF('positionId')}><option value="">All</option>{positions.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field>
          <Field label="Department"><Select value={filter.department} onChange={setF('department')}><option value="">All</option>{options('department').map((v) => <option key={v}>{v}</option>)}</Select></Field>
          <Field label="Section"><Select value={filter.section} onChange={setF('section')}><option value="">All</option>{options('section').map((v) => <option key={v}>{v}</option>)}</Select></Field>
        </div>
      </Card>

      {edit && <ShiftPanel key={`${edit.employee.id}:${edit.date}:${edit.shift?.id}`} {...edit} branchId={branchId} onClose={() => setEdit(null)} />}

      <Card>
        {!branchId ? <Empty>Select a branch.</Empty> : shown.length === 0 ? <Empty>{emps.isLoading ? 'Loading...' : 'No employees match.'}</Empty> : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-xs uppercase text-slate-500">
                  <th className="sticky start-0 top-0 z-20 min-w-48 border-b bg-white px-3 py-2 text-start font-medium">Employee ({shown.length})</th>
                  {days.map((d) => <th key={d} className={`sticky top-0 z-10 min-w-24 border-b bg-white px-2 py-2 text-start font-medium ${d === ymd(new Date()) ? 'text-brand-700' : ''}`}>{DAY_NAMES[utc(d).getUTCDay()].slice(0, 3)} {d.slice(8)}/{d.slice(5, 7)}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const mine = (shifts.data ?? []).filter((s) => s.employeeId === e.id && s.status !== 'CANCELLED');
                  const flagged = (weeks.data ?? []).filter((w) => w.employeeId === e.id && (w.overLimit || w.expectedOvertimeMinutes > 0)).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
                  return (
                    <tr key={e.id}>
                      <td className="sticky start-0 z-10 border-b bg-white px-3 py-2 align-top">
                        <div className="font-medium">{e.name}</div>
                        <div className="text-xs text-slate-500">{hours(mine.filter(counted).reduce((t, s) => t + length(s), 0))} scheduled</div>
                        {flagged.map((w) => <div key={w.weekStart} className={`text-xs ${w.overLimit ? 'font-medium text-red-700' : 'text-amber-700'}`}>Week {w.weekStart.slice(5)}: {hours(w.minutes)}{w.overLimit && ' over limit'} · OT {hours(w.expectedOvertimeMinutes)}</div>)}
                      </td>
                      {days.map((d) => (
                        <td key={d} className="border-b border-s px-1 py-1 align-top text-xs">
                          {mine.filter((s) => s.date.slice(0, 10) === d).map((s) => (
                            <button key={s.id} onClick={() => setEdit({ employee: e, date: d, shift: s })} className={`mb-1 block w-full rounded border px-1 py-0.5 text-start ${s.status === 'PENDING_APPROVAL' ? 'border-amber-400 bg-amber-50' : s.branchId === branchId ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-100'}`}>
                              {formatTime(s.startAt)}-{formatTime(s.endAt)}
                              {s.branchId !== branchId && <span className="block text-slate-500">{nameOf(branches.data, s.branchId)}</span>}
                              {s.status === 'LEAVE_CONFLICT' && <StatusBadge status={s.status} />}
                            </button>
                          ))}
                          <button aria-label={`Add shift for ${e.name} on ${d}`} onClick={() => setEdit({ employee: e, date: d })} className="block w-full rounded border border-dashed border-transparent text-slate-300 hover:border-slate-300 hover:text-brand-700">+</button>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ShiftPanel({ employee, date: initial, shift, branchId, onClose }: { employee: any; date: string; shift?: any; branchId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const at = shift?.branchId ?? branchId;
  const tpls = useQuery({ queryKey: ['templates', at], queryFn: () => api<any[]>(`/shift-templates?branchId=${at}`) });
  const [f, setF] = useState({
    date: initial, templateId: shift?.templateId ?? '',
    start: shift ? formatTime(shift.startAt) : '09:00', end: shift ? formatTime(shift.endAt) : '17:00',
    rest: shift?.restOverrideReason ?? '', over: shift?.overLimitReason ?? '',
  });
  const [ask, setAsk] = useState({ rest: false, over: false });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const done = () => { qc.invalidateQueries({ queryKey: ['schedules'] }); qc.invalidateQueries({ queryKey: ['escalations'] }); onClose(); };
  const instant = (time: string, plus = 0) => new Date(new Date(`${f.date}T${time}:00+03:00`).getTime() + plus * 86_400_000).toISOString();
  const save = useMutation({
    mutationFn: () => {
      const body = {
        date: f.date,
        ...(f.templateId ? { templateId: f.templateId } : { startAt: instant(f.start), endAt: instant(f.end, f.end <= f.start ? 1 : 0) }),
        ...(ask.rest && { overrideRestReason: f.rest.trim() }),
        ...(ask.over && { overLimitReason: f.over.trim() }),
      };
      return shift ? api(`/schedules/${shift.id}`, { method: 'PATCH', body }) : api('/schedules', { body: { ...body, employeeId: employee.id, branchId } });
    },
    onSuccess: done,
    onError: (e: Error) => setAsk((a) => ({ rest: a.rest || /hours of rest/.test(e.message), over: a.over || /weekly maximum/.test(e.message) })),
  });
  const cancel = useMutation({ mutationFn: () => api(`/schedules/${shift.id}/cancel`, { method: 'POST' }), onSuccess: done });
  const missing = (ask.rest && f.rest.trim().length < 3) || (ask.over && f.over.trim().length < 3);
  return (
    <Card title={`${shift ? 'Edit shift' : 'Add shift'}: ${employee.name}`} className="border-brand-500">
      <ErrorBox error={save.error ?? cancel.error ?? tpls.error} />
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date"><Input type="date" required value={f.date} onChange={set('date')} /></Field>
          <Field label="Shift"><Select value={f.templateId} onChange={set('templateId')}><option value="">Own times</option>{tpls.data?.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name} {t.startTime}-{t.endTime}</option>)}</Select></Field>
          {!f.templateId && <>
            <Field label="Start"><Input type="time" required value={f.start} onChange={set('start')} /></Field>
            <Field label={f.end <= f.start ? 'End (next day)' : 'End'}><Input type="time" required value={f.end} onChange={set('end')} /></Field>
          </>}
        </div>
        {(ask.rest || ask.over) && (
          <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {ask.rest && <Field label="Reason for less rest between shifts (recorded)"><Input required minLength={3} value={f.rest} onChange={set('rest')} /></Field>}
            {ask.over && <>
              <p>You can save anyway. HR and the owner are told and can approve it or ask for a change.</p>
              <Field label="Reason for going over the weekly limit"><Input required minLength={3} value={f.over} onChange={set('over')} /></Field>
            </>}
          </div>
        )}
        <div className="flex gap-2">
          <Button disabled={save.isPending || missing}>{ask.rest || ask.over ? 'Save anyway' : 'Save shift'}</Button>
          {shift && <Button type="button" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel shift</Button>}
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </form>
    </Card>
  );
}

export function OverLimit({ rows, onView }: { rows: any[]; onView: (j: Jump) => void }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (x: { id: string; action: 'approve' | 'instruct'; minutes?: number }) => api(`/schedule-escalations/${x.id}/decide`, { body: { action: x.action, minutes: x.minutes, comment: notes[x.id]?.trim() || undefined } }),
    onError: () => qc.invalidateQueries({ queryKey: ['escalations'] }),
    onSuccess: (_d, x) => { setNotes((n) => ({ ...n, [x.id]: '' })); qc.invalidateQueries({ queryKey: ['escalations'] }); },
  });
  return (
    <div className="space-y-4">
      <ErrorBox error={decide.error} />
      {rows.length === 0 && <Card><Empty>No schedules over the weekly limit are waiting for you.</Empty></Card>}
      {rows.map((r) => (
        <Card key={r.id} title={r.evidence.employeeName}>
          <p className="text-sm">{hours(r.evidence.minutes)} scheduled in the week of {r.evidence.weekStart} (limit {hours(r.evidence.limitMinutes)}).</p>
          <p className="mt-1 text-sm text-slate-500">Reasons given: {r.evidence.reasons.join('; ')}</p>
          {r.history.filter((h: any) => h.instruction).map((h: any) => <p key={h.at} className="mt-1 text-sm text-slate-500">Instruction sent: {h.instruction}</p>)}
          <div className="mt-3 flex flex-wrap gap-2">
            <Input className="max-w-md" placeholder="Comment or instruction" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
            <Button disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: 'approve', minutes: r.evidence.minutes })}>Approve {hours(r.evidence.minutes)}</Button>
            <Button variant="ghost" disabled={decide.isPending || !notes[r.id]?.trim()} onClick={() => decide.mutate({ id: r.id, action: 'instruct' })}>Send instruction</Button>
            <Button variant="ghost" onClick={() => onView({ branchId: r.branchId ?? '', start: r.evidence.weekStart, search: r.evidence.employeeName })}>Amend or cancel shifts</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
