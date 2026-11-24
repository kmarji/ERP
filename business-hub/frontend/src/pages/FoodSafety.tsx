import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, ymd, addDays } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function FoodSafety() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Readings');
  return (
    <div>
      <PageHeader title={t('Food safety')} subtitle="Temperature and other measurements against thresholds. A reading out of range raises an exception and one corrective action per point." />
      <Tabs tabs={['Readings', 'Points']} value={tab} onChange={setTab} />
      {tab === 'Readings' ? <Readings /> : <Points />}
    </div>
  );
}

function Readings() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const points = useQuery({ queryKey: ['fs-points'], queryFn: () => api<any[]>('/ops/food-safety/points') });
  const from = addDays(ymd(new Date()), -6);
  const [bad, setBad] = useState(false);
  const readings = useQuery({ queryKey: ['fs-readings', bad], queryFn: () => api<any[]>(`/ops/food-safety/readings?from=${from}${bad ? '&outOfRange=1' : ''}`) });
  const [f, setF] = useState({ pointId: '', value: '', note: '' });
  const rec = useMutation({ mutationFn: () => api('/ops/food-safety/readings', { body: { pointId: f.pointId, value: Number(f.value), note: f.note || undefined } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['fs-readings'] }); qc.invalidateQueries({ queryKey: ['actions'] }); setF({ ...f, value: '', note: '' }); } });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={readings.error} />
        <label className="mb-2 block text-sm"><input type="checkbox" checked={bad} onChange={(e) => setBad(e.target.checked)} /> Out of range only <span className="text-xs text-slate-500">(last 7 days)</span></label>
        {readings.data?.length === 0 ? <Empty>No readings.</Empty> : (
          <Table head={['When', 'Point', 'Branch', 'Value', '']}>
            {readings.data?.map((r) => { const p = points.data?.find((x) => x.id === r.pointId); return (
              <tr key={r.id}><td className="px-3 py-2 text-xs">{formatDate(r.takenAt)}</td><td className="px-3 py-2 font-medium">{p?.name ?? r.pointId.slice(0, 8)}</td><td className="px-3 py-2">{nameOf(branches.data, r.branchId)}</td>
                <td className={`px-3 py-2 ${r.inRange ? '' : 'font-semibold text-red-700'}`}>{r.value} {p?.unit}</td><td className="px-3 py-2 text-xs text-slate-500">{r.note}</td></tr>
            ); })}
          </Table>
        )}
      </Card>
      <Card title="Record a reading" className="lg:col-span-2">
        <ErrorBox error={rec.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); rec.mutate(); }}>
          <Field label="Point"><Select required value={f.pointId} onChange={(e) => setF({ ...f, pointId: e.target.value })}><option value="">Select...</option>{points.data?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({nameOf(branches.data, p.branchId)})</option>)}</Select></Field>
          <Field label="Value"><Input type="number" step="0.01" required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Button disabled={rec.isPending}>Record</Button>
          {rec.isSuccess && !(rec.data as any).inRange && <p className="text-xs text-red-700">Out of range. A corrective action and an exception were raised.</p>}
        </form>
      </Card>
    </div>
  );
}

// Reading times as HH:MM. "Every N hours" steps from the start; "N times a day" spreads them evenly from start to end.
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function presetTimes(mode: 'every' | 'count', n: number, from: string, to: string): string[] {
  const a = toMin(from), b = toMin(to);
  if (!(n > 0) || b < a) return [];
  if (mode === 'every') { const out: string[] = []; for (let m = a; m <= b && out.length < 48; m += n * 60) out.push(hhmm(m)); return out; }
  if (n === 1) return [hhmm(a)];
  return Array.from({ length: Math.min(n, 48) }, (_, i) => hhmm(a + ((b - a) * i) / (n - 1)));
}
const parseTimes = (s: string) => [...new Set(s.split(/[,\s]+/).filter(Boolean))].sort();
const validTimes = (s: string) => parseTimes(s).every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));

function Points() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const list = useQuery({ queryKey: ['fs-points'], queryFn: () => api<any[]>('/ops/food-safety/points') });
  const [f, setF] = useState({ branchId: '', name: '', kind: 'FRIDGE', minValue: '', maxValue: '', times: '' });
  const [pre, setPre] = useState({ mode: 'count' as 'every' | 'count', n: '5', from: '08:00', to: '22:00' });
  const save = useMutation({ mutationFn: (x: any) => api('/ops/food-safety/points', { body: x }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['fs-points'] }); setF({ ...f, name: '', minValue: '', maxValue: '', times: '' }); } });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? save.error} />
        {list.data?.length === 0 ? <Empty>No measurement points.</Empty> : (
          <Table head={['Point', 'Branch', 'Allowed', 'Schedule', '']}>
            {list.data?.map((p) => <tr key={p.id} className={p.active ? '' : 'text-slate-400'}><td className="px-3 py-2 font-medium">{p.name}<div className="text-xs text-slate-500">{p.kind}</div></td><td className="px-3 py-2">{nameOf(branches.data, p.branchId)}</td><td className="px-3 py-2">{p.minValue ?? '-'} to {p.maxValue ?? '-'} {p.unit}</td><td className="px-3 py-2 text-xs">{p.readingTimes?.length ? p.readingTimes.join(', ') : <span className="text-slate-400">none</span>}{p.dueSlots?.length > 0 && <div className="font-semibold text-amber-700">missed: {p.dueSlots.join(', ')}</div>}</td>
              <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => { const t = window.prompt('Reading times, HH:MM separated by commas (empty = no schedule)', (p.readingTimes ?? []).join(', ')); if (t !== null && validTimes(t)) save.mutate({ id: p.id, branchId: p.branchId, name: p.name, kind: p.kind, unit: p.unit, minValue: p.minValue == null ? null : Number(p.minValue), maxValue: p.maxValue == null ? null : Number(p.maxValue), active: p.active, readingTimes: parseTimes(t) }); }}>Schedule</Button><Button variant="ghost" onClick={() => save.mutate({ id: p.id, branchId: p.branchId, name: p.name, kind: p.kind, unit: p.unit, minValue: p.minValue == null ? null : Number(p.minValue), maxValue: p.maxValue == null ? null : Number(p.maxValue), active: !p.active })}>{p.active ? 'Turn off' : 'Turn on'}</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Add a measurement point" className="lg:col-span-2">
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ branchId: f.branchId, name: f.name, kind: f.kind, minValue: f.minValue === '' ? null : Number(f.minValue), maxValue: f.maxValue === '' ? null : Number(f.maxValue), readingTimes: parseTimes(f.times) }); }}>
          <Field label="Branch"><Select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['FRIDGE', 'FREEZER', 'HOT_HOLD', 'COOKING', 'OTHER'].map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <Field label="Minimum (°C)"><Input type="number" step="0.1" value={f.minValue} onChange={(e) => setF({ ...f, minValue: e.target.value })} /></Field>
            <Field label="Maximum (°C)"><Input type="number" step="0.1" value={f.maxValue} onChange={(e) => setF({ ...f, maxValue: e.target.value })} /></Field>
          </div>
          <div className="rounded border border-slate-200 p-2">
            <p className="mb-1 text-xs font-medium">Reading schedule (optional)</p>
            <div className="flex flex-wrap items-end gap-2">
              <Select className="w-32" value={pre.mode} onChange={(e) => setPre({ ...pre, mode: e.target.value as 'every' | 'count' })}><option value="count">Times a day</option><option value="every">Every N hours</option></Select>
              <Input className="w-16" type="number" min="1" value={pre.n} onChange={(e) => setPre({ ...pre, n: e.target.value })} />
              <Input className="w-28" type="time" value={pre.from} onChange={(e) => setPre({ ...pre, from: e.target.value })} />
              <Input className="w-28" type="time" value={pre.to} onChange={(e) => setPre({ ...pre, to: e.target.value })} />
              <Button type="button" variant="ghost" onClick={() => setF({ ...f, times: presetTimes(pre.mode, Number(pre.n), pre.from, pre.to).join(', ') })}>Fill times</Button>
            </div>
            <Field label="Times (HH:MM, comma separated, edit freely)"><Input value={f.times} onChange={(e) => setF({ ...f, times: e.target.value })} placeholder="08:00, 12:00, 16:00" /></Field>
          </div>
          <Button disabled={save.isPending || (f.minValue === '' && f.maxValue === '') || !validTimes(f.times)}>Add</Button>
          <p className="text-xs text-slate-500">Set a minimum, a maximum or both. Staff at the branch record readings in My space, Safety, where scheduled times that are due show up. Times are Jordan local time.</p>
        </form>
      </Card>
    </div>
  );
}
