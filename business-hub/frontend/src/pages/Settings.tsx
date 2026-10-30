import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { nameOf, useList } from '../lib/lookups';

const TABS = ['Organization', 'Users', 'Delegations', 'Integrations'];

const Form = ({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) => (
  <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>{children}</form>
);

export default function Settings() {
  const qc = useQueryClient();
  const [tab, setTab] = useState(TABS[0]);
  const refresh = () => qc.invalidateQueries();
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body });
  const entities = useList('/org/legal-entities');
  const branches = useList('/org/branches');
  const locations = useList('/org/stock-locations');
  const centers = useList('/org/cost-centers');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<any[]>('/users'), enabled: tab === 'Users' || tab === 'Delegations' });
  const roles = useList('/roles');
  const [jobStatus, setJobStatus] = useState('');
  const jobs = useQuery({ queryKey: ['jobs', jobStatus], queryFn: () => api<any[]>(`/integrations/jobs${jobStatus ? `?status=${jobStatus}` : ''}`), enabled: tab === 'Integrations' });

  const [le, setLe] = useState({ name: '', taxNumber: '' });
  const [edit, setEdit] = useState<Record<string, { name: string; taxNumber: string }>>({});
  const [br, setBr] = useState({ legalEntityId: '', code: '', name: '' });
  const [loc, setLoc] = useState({ branchId: '', code: '', name: '', isSalesLocation: false });
  const [cc, setCc] = useState({ code: '', name: '', branchId: '' });
  const [nu, setNu] = useState({ email: '', name: '', password: '' });
  const [ar, setAr] = useState({ userId: '', roleKey: 'CASHIER', branchId: '' });
  const [dg, setDg] = useState({ toUserId: '', roleKey: 'BRANCH_MANAGER', branchId: '', startsAt: '', endsAt: '' });
  const [made, setMade] = useState<any[]>([]);

  const addLe = useMutation({ mutationFn: () => post('/org/legal-entities', { name: le.name, taxNumber: le.taxNumber || undefined }), onSuccess: refresh });
  const patchLe = useMutation({ mutationFn: (id: string) => api(`/org/legal-entities/${id}`, { method: 'PATCH', body: edit[id] }), onSuccess: refresh });
  const addBr = useMutation({ mutationFn: () => post('/org/branches', br), onSuccess: refresh });
  const addLoc = useMutation({ mutationFn: () => post('/org/stock-locations', loc), onSuccess: refresh });
  const addCc = useMutation({ mutationFn: () => post('/org/cost-centers', { ...cc, branchId: cc.branchId || undefined }), onSuccess: refresh });
  const addUser = useMutation({ mutationFn: () => post('/users', nu), onSuccess: refresh });
  const assign = useMutation({ mutationFn: () => post(`/users/${ar.userId}/roles`, { roleKey: ar.roleKey, branchId: ar.branchId || undefined }), onSuccess: refresh });
  const delegate = useMutation({
    mutationFn: () => api<any>('/delegations', { body: { ...dg, branchId: dg.branchId || undefined, startsAt: new Date(dg.startsAt).toISOString(), endsAt: new Date(dg.endsAt).toISOString() } }),
    onSuccess: (d) => { setMade((m) => [...m, d]); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => post(`/delegations/${id}/revoke`, {}), onSuccess: (_r, id) => setMade((m) => m.map((d) => (d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d))) });
  const retry = useMutation({ mutationFn: (id: string) => post(`/integrations/jobs/${id}/retry`, {}), onSuccess: refresh });

  const err = addLe.error ?? patchLe.error ?? addBr.error ?? addLoc.error ?? addCc.error ?? addUser.error ?? assign.error ?? delegate.error ?? revoke.error ?? retry.error ?? users.error ?? jobs.error;
  const roleSelect = (value: string, onChange: (v: string) => void) => <Select value={value} onChange={(e) => onChange(e.target.value)}>{roles.data?.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select>;
  const branchSelect = (value: string, onChange: (v: string) => void, none: string) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)}><option value="">{none}</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</Select>
  );
  const userSelect = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required><option value="">User...</option>{users.data?.filter((u) => !u.isSystem).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</Select>
  );

  return (
    <div>
      <PageHeader title="Settings" subtitle="Organization structure, people and their authority, and integration health." />
      <ErrorBox error={err} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'Organization' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Legal entities">
            <ul className="mb-3 space-y-2 text-sm">
              {entities.data?.map((l) => {
                const e = edit[l.id] ?? { name: l.name, taxNumber: l.taxNumber ?? '' };
                return (
                  <li key={l.id} className="flex items-end gap-2">
                    <Field label="Name"><Input value={e.name} onChange={(x) => setEdit({ ...edit, [l.id]: { ...e, name: x.target.value } })} /></Field>
                    <Field label="Tax number"><Input value={e.taxNumber} onChange={(x) => setEdit({ ...edit, [l.id]: { ...e, taxNumber: x.target.value } })} /></Field>
                    <Button variant="ghost" disabled={!edit[l.id]} onClick={() => patchLe.mutate(l.id)}>Save</Button>
                  </li>
                );
              })}
            </ul>
            <Form onSubmit={() => addLe.mutate()}>
              <Input placeholder="New legal entity name" value={le.name} onChange={(e) => setLe({ ...le, name: e.target.value })} required />
              <Input placeholder="Tax number (optional)" value={le.taxNumber} onChange={(e) => setLe({ ...le, taxNumber: e.target.value })} />
              <Button type="submit">Add legal entity</Button>
            </Form>
          </Card>

          <Card title="Branches">
            {branches.data?.length === 0 ? <Empty>No branches.</Empty> : <Table head={['Code', 'Name', 'Legal entity']}>{branches.data?.map((b) => <tr key={b.id}><td className="px-3 py-1 font-medium">{b.code}</td><td className="px-3 py-1">{b.name}</td><td className="px-3 py-1 text-slate-500">{nameOf(entities.data, b.legalEntityId)}</td></tr>)}</Table>}
            <Form onSubmit={() => addBr.mutate()}>
              <Select value={br.legalEntityId} onChange={(e) => setBr({ ...br, legalEntityId: e.target.value })} required><option value="">Legal entity...</option>{entities.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
              <Input placeholder="Code" value={br.code} onChange={(e) => setBr({ ...br, code: e.target.value })} required />
              <Input placeholder="Name" value={br.name} onChange={(e) => setBr({ ...br, name: e.target.value })} required />
              <Button type="submit">Add branch</Button>
            </Form>
          </Card>

          <Card title="Stock locations">
            {locations.data?.length === 0 ? <Empty>No stock locations.</Empty> : <Table head={['Code', 'Name', 'Branch', 'Sales']}>{locations.data?.map((l) => <tr key={l.id}><td className="px-3 py-1 font-medium">{l.code}</td><td className="px-3 py-1">{l.name}</td><td className="px-3 py-1 text-slate-500">{nameOf(branches.data, l.branchId, 'code')}</td><td className="px-3 py-1">{l.isSalesLocation ? <Badge tone="bg-emerald-100 text-emerald-800">sales</Badge> : ''}</td></tr>)}</Table>}
            <Form onSubmit={() => addLoc.mutate()}>
              {branchSelect(loc.branchId, (v) => setLoc({ ...loc, branchId: v }), 'Branch...')}
              <Input placeholder="Code" value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value })} required />
              <Input placeholder="Name" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} required />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={loc.isSalesLocation} onChange={(e) => setLoc({ ...loc, isSalesLocation: e.target.checked })} />Sales location (sold ingredients are consumed from here)</label>
              <Button type="submit">Add location</Button>
            </Form>
          </Card>

          <Card title="Cost centers">
            {centers.data?.length === 0 ? <Empty>No cost centers.</Empty> : <Table head={['Code', 'Name', 'Branch']}>{centers.data?.map((c) => <tr key={c.id}><td className="px-3 py-1 font-medium">{c.code}</td><td className="px-3 py-1">{c.name}</td><td className="px-3 py-1 text-slate-500">{c.branchId ? nameOf(branches.data, c.branchId, 'code') : 'HQ'}</td></tr>)}</Table>}
            <Form onSubmit={() => addCc.mutate()}>
              <Input placeholder="Code" value={cc.code} onChange={(e) => setCc({ ...cc, code: e.target.value })} required />
              <Input placeholder="Name" value={cc.name} onChange={(e) => setCc({ ...cc, name: e.target.value })} required />
              {branchSelect(cc.branchId, (v) => setCc({ ...cc, branchId: v }), 'HQ (no branch)')}
              <Button type="submit">Add cost center</Button>
            </Form>
          </Card>
        </div>
      )}

      {tab === 'Users' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2" title="Users">
            {users.data?.length === 0 ? <Empty>No users.</Empty> : (
              <Table head={['Name', 'Email', 'Roles']}>
                {users.data?.map((u) => (
                  <tr key={u.id}><td className="px-3 py-2 font-medium">{u.name}{u.isSystem && <Badge> machine</Badge>}</td><td className="px-3 py-2 text-slate-500">{u.email}</td>
                    <td className="px-3 py-2">{u.roles.map((r: any) => <Badge key={r.id}>{r.role.key}{r.branchId ? ` @ ${nameOf(branches.data, r.branchId, 'code')}` : ''}</Badge>)}</td></tr>
                ))}
              </Table>
            )}
          </Card>
          <div className="space-y-6">
            <Card title="New user">
              <Form onSubmit={() => addUser.mutate()}>
                <Input type="email" placeholder="Email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required />
                <Input placeholder="Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} required />
                <Input type="password" placeholder="Password (10+ characters)" minLength={10} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required />
                <Button type="submit">Create user</Button>
              </Form>
            </Card>
            <Card title="Assign role">
              <Form onSubmit={() => assign.mutate()}>
                {userSelect(ar.userId, (v) => setAr({ ...ar, userId: v }))}
                {roleSelect(ar.roleKey, (v) => setAr({ ...ar, roleKey: v }))}
                {branchSelect(ar.branchId, (v) => setAr({ ...ar, branchId: v }), 'All branches (HQ-wide)')}
                <Button type="submit">Assign</Button>
              </Form>
            </Card>
          </div>
        </div>
      )}

      {tab === 'Delegations' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2" title="Created this session">
            <p className="mb-3 text-xs text-slate-400">The API has no list endpoint for delegations, so only those created in this browser session are shown.</p>
            {made.length === 0 ? <Empty>None yet.</Empty> : (
              <Table head={['To', 'Role', 'From', 'Until', '']}>
                {made.map((d) => (
                  <tr key={d.id}><td className="px-3 py-2">{nameOf(users.data, d.toUserId)}</td><td className="px-3 py-2">{d.roleKey}</td><td className="px-3 py-2 text-xs">{formatDate(d.startsAt)}</td><td className="px-3 py-2 text-xs">{formatDate(d.endsAt)}</td>
                    <td className="px-3 py-2 text-end">{d.revokedAt ? <Badge>revoked</Badge> : <Button variant="ghost" onClick={() => revoke.mutate(d.id)}>Revoke</Button>}</td></tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Temporary delegation">
            <p className="mb-2 text-xs text-slate-400">You can only delegate authority at or below your own role.</p>
            <Form onSubmit={() => delegate.mutate()}>
              {userSelect(dg.toUserId, (v) => setDg({ ...dg, toUserId: v }))}
              {roleSelect(dg.roleKey, (v) => setDg({ ...dg, roleKey: v }))}
              {branchSelect(dg.branchId, (v) => setDg({ ...dg, branchId: v }), 'All branches')}
              <Field label="Starts"><Input type="datetime-local" value={dg.startsAt} onChange={(e) => setDg({ ...dg, startsAt: e.target.value })} required /></Field>
              <Field label="Ends"><Input type="datetime-local" value={dg.endsAt} onChange={(e) => setDg({ ...dg, endsAt: e.target.value })} required /></Field>
              <Button type="submit">Delegate</Button>
            </Form>
          </Card>
        </div>
      )}

      {tab === 'Integrations' && (
        <Card title="Integration jobs">
          <div className="mb-3 max-w-xs"><Select value={jobStatus} onChange={(e) => setJobStatus(e.target.value)}><option value="">All</option>{['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD'].map((s) => <option key={s}>{s}</option>)}</Select></div>
          {jobs.data?.length === 0 ? <Empty>No jobs.</Empty> : (
            <Table head={['Adapter', 'Operation', 'Status', 'Attempts', 'Last error', 'Created', '']}>
              {jobs.data?.map((j) => (
                <tr key={j.id}><td className="px-3 py-2 font-medium">{j.adapter}</td><td className="px-3 py-2">{j.operation}</td><td className="px-3 py-2"><StatusBadge status={j.status} /></td>
                  <td className="px-3 py-2">{j.attempts}/{j.maxAttempts}</td><td className="max-w-xs truncate px-3 py-2 text-xs text-red-600">{j.lastError ?? ''}</td><td className="px-3 py-2 text-xs text-slate-500">{formatDate(j.createdAt)}</td>
                  <td className="px-3 py-2 text-end">{j.status === 'DEAD' && <Button variant="ghost" onClick={() => retry.mutate(j.id)}>Retry</Button>}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
