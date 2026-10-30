import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { nameOf, useList } from '../lib/lookups';

export default function PosDevices() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const devices = useQuery({ queryKey: ['pos-devices'], queryFn: () => api<any[]>('/pos/devices') });
  const [status, setStatus] = useState('REJECTED');
  const ops = useQuery({ queryKey: ['sync-ops', status], queryFn: () => api<any[]>(`/pos/sync/operations${status ? `?status=${status}` : ''}`) });
  const [f, setF] = useState({ branchId: '', name: '' });
  const [fresh, setFresh] = useState<{ id: string; key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['pos-devices'] });
  const enroll = useMutation({ mutationFn: () => api('/pos/devices', { body: f }), onSuccess: (r: any) => { setFresh(r); setCopied(false); setF({ ...f, name: '' }); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/pos/devices/${id}/revoke`, { method: 'POST' }), onSuccess: refresh });
  const [shiftId, setShiftId] = useState<Record<string, string>>({});
  const retry = useMutation({ mutationFn: (id: string) => api(`/pos/sync/operations/${id}/retry`, { body: { shiftId: shiftId[id] || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-ops'] }) });
  const openShifts = useList('/pos/shifts?status=OPEN');
  return (
    <div className="space-y-6">
      <PageHeader title="POS devices" subtitle="Enrolled tablets can sell cash orders offline and sync later. Revoking a device cuts it off immediately." />
      <ErrorBox error={devices.error ?? enroll.error ?? revoke.error ?? ops.error ?? retry.error} />
      {fresh && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
          <div className="font-semibold">Device key for {fresh.name}</div>
          <div className="mt-1 text-sm text-amber-800">Copy it now. It is shown only once and cannot be recovered; if lost, revoke the device and enroll a new one.</div>
          <div className="mt-2 flex items-center gap-2"><code className="break-all rounded bg-white px-2 py-1 text-sm">{fresh.key}</code>
            <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(fresh.key).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button variant="ghost" onClick={() => setFresh(null)}>Done</Button></div>
          <div className="mt-1 text-xs text-slate-500">Device id: {fresh.id}</div>
        </div>
      )}
      <Card title="Enroll a device">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); enroll.mutate(); }}>
          <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} required><option value="">Choose...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Device name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
          <Button type="submit">Enroll</Button>
        </form>
      </Card>
      <Card title="Devices">
        {devices.data?.length === 0 ? <Empty>No devices enrolled.</Empty> : (
          <Table head={['Name', 'Branch', 'Last seen', 'Status', '']}>
            {devices.data?.map((d) => (
              <tr key={d.id}>
                <td className="px-3 py-2 font-medium">{d.name}</td><td className="px-3 py-2">{nameOf(branches.data, d.branchId)}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{d.lastSeenAt ? formatDate(d.lastSeenAt) : 'never'}</td>
                <td className="px-3 py-2">{d.active ? <Badge tone="bg-emerald-100 text-emerald-800">active</Badge> : <Badge tone="bg-red-100 text-red-800">revoked</Badge>}</td>
                <td className="px-3 py-2">{d.active && <Button variant="danger" onClick={() => revoke.mutate(d.id)}>Revoke</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Offline operations">
        <div className="mb-3 max-w-xs"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="REJECTED">Rejected (needs attention)</option><option value="APPLIED">Applied</option><option value="">All</option></Select></div>
        {ops.data?.length === 0 ? <Empty>Nothing here.</Empty> : (
          <Table head={['When', 'Operation', 'Kind', 'Status', 'Detail', '']}>
            {ops.data?.map((o) => (
              <tr key={o.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(o.createdAt)}</td><td className="px-3 py-2 font-mono text-xs">{o.opId}</td><td className="px-3 py-2">{o.kind}</td>
                <td className="px-3 py-2"><StatusBadge status={o.status} /></td><td className="max-w-xs px-3 py-2 text-xs text-slate-600">{o.error ?? o.result?.orderNumber}</td>
                <td className="px-3 py-2">{o.status === 'REJECTED' && (
                  <div className="flex gap-1">
                    <Select className="w-40" value={shiftId[o.id] ?? ''} onChange={(e) => setShiftId({ ...shiftId, [o.id]: e.target.value })}><option value="">Attach to shift...</option>{openShifts.data?.map((s) => <option key={s.id} value={s.id}>{nameOf(branches.data, s.branchId)} {formatDate(s.openedAt)}</option>)}</Select>
                    <Button variant="ghost" onClick={() => retry.mutate(o.id)}>Retry</Button>
                  </div>
                )}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
