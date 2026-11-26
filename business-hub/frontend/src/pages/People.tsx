import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function People() {
  const [tab, setTab] = useState('Employees');
  return (
    <div>
      <PageHeader title="Employees" subtitle="Employee files, assignments, contracts, training and social security (SSC) actions." />
      <Tabs tabs={['Employees', 'Letters', 'SSC']} value={tab} onChange={setTab} />
      {tab === 'Employees' ? <Directory /> : tab === 'Letters' ? <LetterRequests /> : <Ssc />}
    </div>
  );
}

function Directory() {
  const branches = useList('/org/branches');
  const [f, setF] = useState({ branchId: '', status: '', q: '' });
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['employees', qs], queryFn: () => api<any[]>(`/employees?${qs}`) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <Button className="mb-3" onClick={() => { setAdding(true); setSel(null); }}>Add employee</Button>
        <div className="mb-3 grid grid-cols-3 gap-2">
          <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <Input placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </div>
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No employees.</Empty> : (
          <Table head={['No.', 'Name', 'Status', 'Login']}>
            {list.data?.map((e) => (
              <tr key={e.id} onClick={() => setSel(e.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === e.id ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2 text-xs">{e.number}</td>
                <td className="px-3 py-2 font-medium">{e.name}<PermitBadge permit={e.permit} /></td>
                <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                <td className="px-3 py-2 text-xs">{e.userId ? '✓' : <span className="font-semibold text-amber-700">none</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="lg:col-span-3">{adding ? <AddEmployee onDone={(id) => { setAdding(false); setSel(id); }} onCancel={() => setAdding(false)} /> : sel ? <EmployeeDetail key={sel} id={sel} /> : <Card><Empty>Select an employee.</Empty></Card>}</div>
    </div>
  );
}

type Row = { name: string; amount: string };
const toRows = (a?: { name: string; amount: number }[]): Row[] => (a ?? []).map((x) => ({ name: x.name, amount: String(x.amount) }));
const fromRows = (rows: Row[]) => rows.map((r) => ({ name: r.name, amount: Number(r.amount) }));
function Allowances({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, k: keyof Row, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="text-xs font-medium text-slate-600">Allowances (JOD per month)</div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input required maxLength={60} placeholder="Housing, laundry..." aria-label="Allowance name" value={r.name} onChange={(ev) => set(i, 'name', ev.target.value)} />
          <Input required type="number" step="0.001" min="0" className="w-32" placeholder="Amount" aria-label="Allowance amount" value={r.amount} onChange={(ev) => set(i, 'amount', ev.target.value)} />
          <Button type="button" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <Button type="button" variant="ghost" onClick={() => onChange([...rows, { name: '', amount: '' }])}>Add allowance</Button>
    </div>
  );
}

type Permit = { needsWorkPermit: boolean; workPermitNumber: string; workPermitExpiry: string };
const fromEmployee = (e: any): Permit => ({ needsWorkPermit: e.needsWorkPermit, workPermitNumber: e.workPermitNumber ?? '', workPermitExpiry: e.workPermitExpiry?.slice(0, 10) ?? '' });
const toPermit = (p: Permit) => ({ needsWorkPermit: p.needsWorkPermit, workPermitNumber: p.workPermitNumber || null, workPermitExpiry: p.workPermitExpiry || null });
function PermitFields({ value, onChange }: { value: Permit; onChange: (p: Permit) => void }) {
  return (
    <>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={value.needsWorkPermit} onChange={(ev) => onChange({ ...value, needsWorkPermit: ev.target.checked })} /> Requires a work permit</label>
      {value.needsWorkPermit && <>
        <Field label="Work permit number (optional)"><Input maxLength={60} value={value.workPermitNumber} onChange={(ev) => onChange({ ...value, workPermitNumber: ev.target.value })} /></Field>
        <Field label="Work permit expiry date (optional)"><Input type="date" value={value.workPermitExpiry} onChange={(ev) => onChange({ ...value, workPermitExpiry: ev.target.value })} /></Field>
      </>}
    </>
  );
}

function PermitBadge({ permit }: { permit?: { state: 'INCOMPLETE' | 'EXPIRED' | 'EXPIRING'; daysLeft: number | null } | null }) {
  if (!permit) return null;
  const text = permit.state === 'INCOMPLETE' ? 'Work permit incomplete' : permit.state === 'EXPIRED' ? 'Permit expired' : permit.daysLeft === 0 ? 'Permit expires today' : `Permit expires in ${permit.daysLeft} day${permit.daysLeft === 1 ? '' : 's'}`;
  return <span className={`ms-2 inline-block rounded px-2 py-0.5 text-xs font-semibold ${permit.state === 'EXPIRING' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700'}`}>{text}</span>;
}

function PermitCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const [nationality, setNationality] = useState(e.nationality ?? '');
  const [p, setP] = useState<Permit>(fromEmployee(e));
  // Branch-scoped HR does not receive the number, so the permit is only editable when it was sent.
  const full = 'workPermitNumber' in e;
  const save = useMutation({ mutationFn: () => api<any>(`/employees/${e.id}`, { method: 'PATCH', body: { nationality: nationality || undefined, ...(full ? toPermit(p) : {}) } }), onSuccess: (r: any) => { setP(fromEmployee(r)); qc.invalidateQueries(); } });
  return (
    <Card title="Nationality and work permit">
      <ErrorBox error={save.error} />
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); save.mutate(); }}>
        <Field label="Nationality"><Input minLength={2} maxLength={60} value={nationality} onChange={(ev) => setNationality(ev.target.value)} /></Field>
        {full && <PermitFields value={p} onChange={setP} />}
        <div className="flex items-center gap-2 sm:col-span-2"><Button disabled={save.isPending}>Save</Button>{save.isSuccess && <span className="text-xs text-emerald-700">Saved.</span>}</div>
      </form>
    </Card>
  );
}

const SENSITIVE = [['nationalId', 'National id', 'text'], ['dateOfBirth', 'Date of birth', 'date'], ['address', 'Address', 'text'], ['iban', 'IBAN (salary account)', 'text']] as const;
function SensitiveCard({ id, canEdit }: { id: string; canEdit: boolean }) {
  const [f, setF] = useState<Record<string, string> | null>(null);
  const load = useMutation({ mutationFn: () => api<Record<string, string>>(`/employees/${id}/sensitive`), onSuccess: (r) => { save.reset(); setF(r); } });
  // All four are sent: an emptied box removes that value.
  const save = useMutation({ mutationFn: () => api<Record<string, string>>(`/employees/${id}/sensitive`, { method: 'PUT', body: Object.fromEntries(SENSITIVE.map(([k]) => [k, f?.[k] ?? ''])) }), onSuccess: setF });
  return (
    <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
      <ErrorBox error={load.error ?? save.error} />
      <p className="mb-2 text-amber-800">National id, date of birth, address and bank details are encrypted. Viewing and changing them is recorded in the audit trail with your name.</p>
      {!f ? <Button variant="ghost" onClick={() => load.mutate()}>View sensitive details</Button> : (
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); if (canEdit) save.mutate(); }}>
          {SENSITIVE.map(([k, label, type]) => <Field key={k} label={label}><Input type={type} readOnly={!canEdit} value={(type === 'date' ? f[k]?.slice(0, 10) : f[k]) ?? ''} onChange={(ev) => { save.reset(); setF({ ...f, [k]: ev.target.value }); }} /></Field>)}
          <div className="flex items-center gap-2 sm:col-span-2">{canEdit && <Button disabled={save.isPending}>Save changes</Button>}<Button type="button" variant="ghost" onClick={() => setF(null)}>Hide</Button>{save.isSuccess && <span className="text-xs text-emerald-700">Saved.</span>}</div>
        </form>
      )}
    </div>
  );
}

// Every employee should end up with a login. This creates the employee, contract, branch assignment and login in one go.
function AddEmployee({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const entities = useList('/org/legal-entities');
  const branches = useList('/org/branches');
  const positions = useList('/recruitment/positions');
  const roles = useList('/roles');
  const emps = useQuery({ queryKey: ['employees', ''], queryFn: () => api<any[]>('/employees') });
  const [f, setF] = useState({ name: '', nameAr: '', phone: '', legalEntityId: '', branchId: '', positionId: '', hireDate: ymdNow(), salaryBasic: '', managerId: '', email: '', password: '', roleKey: 'EMPLOYEE', login: true, nationality: '' });
  const [allow, setAllow] = useState<Row[]>([]);
  const [permit, setPermit] = useState<Permit>({ needsWorkPermit: false, workPermitNumber: '', workPermitExpiry: '' });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => api<any>('/employees', { body: { name: f.name, nationality: f.nationality, needsWorkPermit: permit.needsWorkPermit, workPermitNumber: permit.workPermitNumber || undefined, workPermitExpiry: permit.workPermitExpiry || undefined, allowances: fromRows(allow), nameAr: f.nameAr || undefined, phone: f.phone, email: f.email || undefined, legalEntityId: f.legalEntityId, branchId: f.branchId, positionId: f.positionId, hireDate: f.hireDate, salaryBasic: Number(f.salaryBasic), managerId: f.managerId || undefined, login: f.login ? { email: f.email, password: f.password, roleKey: f.roleKey } : undefined } }),
    onSuccess: (r) => { qc.invalidateQueries(); onDone(r.id); },
  });
  return (
    <Card title="Add an employee">
      <ErrorBox error={save.error} />
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name"><Input required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Name (Arabic)"><Input dir="rtl" value={f.nameAr} onChange={set('nameAr')} /></Field>
        <Field label="Phone"><Input required minLength={5} value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Nationality"><Input required minLength={2} maxLength={60} value={f.nationality} onChange={set('nationality')} /></Field>
        <Field label="Hire date"><Input type="date" required value={f.hireDate} onChange={set('hireDate')} /></Field>
        <Field label="Legal entity"><Select required value={f.legalEntityId} onChange={set('legalEntityId')}><option value="">Select...</option>{entities.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Branch"><Select required value={f.branchId} onChange={set('branchId')}><option value="">Select...</option>{branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Position"><Select required value={f.positionId} onChange={set('positionId')}><option value="">Select...</option>{positions.data?.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select></Field>
        <Field label="Basic salary (JOD)"><Input type="number" step="0.001" min="0" required value={f.salaryBasic} onChange={set('salaryBasic')} /></Field>
        <Allowances rows={allow} onChange={setAllow} />
        <PermitFields value={permit} onChange={setPermit} />
        <Field label="Reports to (approves leave)"><Select value={f.managerId} onChange={set('managerId')}><option value="">Nobody</option>{emps.data?.filter((x) => x.status === 'ACTIVE' && x.userId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <label className="flex items-center gap-2 self-end text-sm sm:col-span-2"><input type="checkbox" checked={f.login} onChange={(e) => setF({ ...f, login: e.target.checked })} /> Create a login (username = email, used in the employee portal)</label>
        {f.login && <>
          <Field label="Email (username)"><Input type="email" required value={f.email} onChange={set('email')} /></Field>
          <Field label="Initial password (min 10)"><Input required minLength={10} value={f.password} onChange={set('password')} /></Field>
          <Field label="Role (permissions)"><Select value={f.roleKey} onChange={set('roleKey')}>{roles.data?.filter((r) => r.key !== 'SYSTEM').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
        </>}
        <div className="flex gap-2 sm:col-span-2"><Button disabled={save.isPending}>Create</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </form>
      <p className="mt-2 text-xs text-slate-500">Give the employee the email and password; they sign in at the employee portal. The branch scopes the role.</p>
    </Card>
  );
}
const ymdNow = () => new Date().toISOString().slice(0, 10);

// Login, role and password for one employee.
function AccessCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['access', e.id], queryFn: () => api<any>(`/employees/${e.id}/access`), retry: false });
  const roles = useList('/roles');
  const branches = useList('/org/branches');
  const refresh = () => qc.invalidateQueries({ queryKey: ['access', e.id] });
  const [f, setF] = useState({ email: e.email ?? '', password: '', roleKey: 'EMPLOYEE' });
  const [pw, setPw] = useState('');
  const [add, setAdd] = useState({ roleKey: 'BRANCH_MANAGER', branchId: '' });
  const create = useMutation({ mutationFn: () => api(`/employees/${e.id}/login`, { body: f }), onSuccess: () => { setF({ ...f, password: '' }); qc.invalidateQueries(); } });
  const reset = useMutation({ mutationFn: () => api(`/employees/${e.id}/password`, { body: { password: pw } }), onSuccess: () => setPw('') });
  const grant = useMutation({ mutationFn: () => api(`/users/${q.data.user.id}/roles`, { body: { roleKey: add.roleKey, branchId: add.branchId || undefined } }), onSuccess: refresh });
  const drop = useMutation({ mutationFn: (id: string) => api(`/users/${q.data.user.id}/roles/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const user = q.data?.user;
  return (
    <Card title="Login and role (permissions)">
      <ErrorBox error={q.error ?? create.error ?? reset.error ?? grant.error ?? drop.error} />
      {!user ? (
        <form className="grid gap-2 sm:grid-cols-3" onSubmit={(ev) => { ev.preventDefault(); create.mutate(); }}>
          <p className="text-sm font-medium text-amber-700 sm:col-span-3">No login yet: this employee cannot sign in.</p>
          <Field label="Email (username)"><Input type="email" required value={f.email} onChange={(ev) => setF({ ...f, email: ev.target.value })} /></Field>
          <Field label="Initial password (min 10)"><Input required minLength={10} value={f.password} onChange={(ev) => setF({ ...f, password: ev.target.value })} /></Field>
          <Field label="Role"><Select value={f.roleKey} onChange={(ev) => setF({ ...f, roleKey: ev.target.value })}>{roles.data?.filter((r) => r.key !== 'SYSTEM').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
          <Button disabled={create.isPending}>Create login</Button>
        </form>
      ) : (
        <div className="space-y-3 text-sm">
          <p>Username: <b>{user.email}</b> {!user.active && <span className="text-red-700">(disabled)</span>}</p>
          <div>
            <div className="mb-1 text-xs font-medium text-slate-600">Roles</div>
            {q.data.roles.map((r: any) => <span key={r.id} className="me-2 inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs">{r.name}{r.branchId ? ` · ${nameOf(branches.data, r.branchId)}` : ' · all branches'}<button className="text-red-600" title="Remove" onClick={() => drop.mutate(r.id)}>×</button></span>)}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Select className="w-44" value={add.roleKey} onChange={(ev) => setAdd({ ...add, roleKey: ev.target.value })}>{roles.data?.filter((r) => r.key !== 'SYSTEM').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select>
              <Select className="w-44" value={add.branchId} onChange={(ev) => setAdd({ ...add, branchId: ev.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
              <Button variant="ghost" disabled={grant.isPending} onClick={() => grant.mutate()}>Add role</Button>
            </div>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); reset.mutate(); }}>
            <Field label="Set a new password (min 10)"><Input required minLength={10} value={pw} onChange={(ev) => setPw(ev.target.value)} /></Field>
            <Button variant="ghost" disabled={reset.isPending}>Reset password</Button>
            {reset.isSuccess && <span className="text-xs text-emerald-700">Password changed.</span>}
          </form>
        </div>
      )}
    </Card>
  );
}

// Who approves this person's leave from the employee portal. Must be an employee with a login.
function ManagerCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const emps = useQuery({ queryKey: ['employees', ''], queryFn: () => api<any[]>('/employees') });
  const save = useMutation({ mutationFn: (managerId: string) => api(`/employees/${e.id}`, { method: 'PATCH', body: { managerId: managerId || null } }), onSuccess: () => qc.invalidateQueries() });
  return (
    <Card title="Reports to (approves leave in the employee portal)">
      <ErrorBox error={save.error} />
      <Select className="w-72" value={e.managerId ?? ''} onChange={(ev) => save.mutate(ev.target.value)}>
        <option value="">Nobody (approved by role in the back-office)</option>
        {emps.data?.filter((m) => m.id !== e.id && m.userId).map((m) => <option key={m.id} value={m.id}>{m.name} · {m.number}</option>)}
      </Select>
    </Card>
  );
}

// Salary and employment certificates employees ask for in the portal.
function LetterRequests() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const q = useQuery({ queryKey: ['letters', status], queryFn: () => api<any[]>(`/letters?status=${status}`) });
  const [note, setNote] = useState<Record<string, string>>({});
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/letters/${x.id}/decide`, { body: { approve: x.approve, note: note[x.id] || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['letters'] }) });
  return (
    <Card>
      <ErrorBox error={q.error ?? decide.error} />
      <Select className="mb-3 w-40" value={status} onChange={(ev) => setStatus(ev.target.value)}>{['PENDING', 'APPROVED', 'REJECTED'].map((x) => <option key={x}>{x}</option>)}</Select>
      {q.data?.length === 0 ? <Empty>No letters.</Empty> : (
        <Table head={['Employee', 'Type', 'Addressed to', 'Purpose', 'Requested', '']}>
          {q.data?.map((l) => (
            <tr key={l.id}><td className="px-3 py-2 font-medium">{l.employee?.name}</td><td className="px-3 py-2">{l.kind}</td><td className="px-3 py-2">{l.addressee}</td><td className="px-3 py-2 text-xs">{l.purpose}</td><td className="px-3 py-2 text-xs">{formatDate(l.createdAt)}</td>
              <td className="px-3 py-2 text-end">{l.status === 'PENDING' ? <span className="flex items-center justify-end gap-1"><Input className="w-40" placeholder="Reason (to reject)" value={note[l.id] ?? ''} onChange={(ev) => setNote({ ...note, [l.id]: ev.target.value })} /><Button disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, approve: true })}>Approve</Button><Button variant="danger" disabled={decide.isPending || !note[l.id]?.trim()} onClick={() => decide.mutate({ id: l.id, approve: false })}>Reject</Button></span> : <StatusBadge status={l.status} />}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// Fixed per-employee SSC and income tax ratios. Blank = follow the payroll rule set. Shown and typed as percentages.
const pct = (v: string | null | undefined) => (v == null ? '' : String(+(Number(v) * 100).toFixed(4)));
const frac = (v: string) => (v.trim() === '' ? null : Number(v) / 100);
function RatesCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ee: pct(e.sscEmployeeRate), er: pct(e.sscEmployerRate), sscNote: e.sscRateNote ?? '', tax: pct(e.incomeTaxRate), taxNote: e.incomeTaxRateNote ?? '' });
  const save = useMutation({
    mutationFn: () => api(`/employees/${e.id}/payroll-rates`, { method: 'PATCH', body: { sscEmployeeRate: frac(f.ee), sscEmployerRate: frac(f.er), sscRateNote: f.sscNote, incomeTaxRate: frac(f.tax), incomeTaxRateNote: f.taxNote } }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const sscSet = f.ee.trim() !== '' || f.er.trim() !== '';
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  return (
    <Card title="Payroll ratios (override the company rules for this employee)">
      <ErrorBox error={save.error} />
      <form className="space-y-3" onSubmit={(ev: FormEvent) => { ev.preventDefault(); save.mutate(); }}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="SSC employee %"><Input type="number" step="0.01" min="0" max="100" value={f.ee} onChange={set('ee')} placeholder="rule set" /></Field>
          <Field label="SSC employer %"><Input type="number" step="0.01" min="0" max="100" value={f.er} onChange={set('er')} placeholder="rule set" /></Field>
          <Field label="Why this SSC ratio"><Input className="w-80" value={f.sscNote} onChange={set('sscNote')} required={sscSet} /></Field>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Income tax % (of gross - SSC)"><Input type="number" step="0.01" min="0" max="100" value={f.tax} onChange={set('tax')} placeholder="rule set" /></Field>
          <Field label="Why this tax ratio"><Input className="w-80" value={f.taxNote} onChange={set('taxNote')} required={f.tax.trim() !== ''} /></Field>
        </div>
        <Button type="submit">Save ratios</Button>
      </form>
    </Card>
  );
}

function EmployeeDetail({ id }: { id: string }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => api<any>(`/employees/${id}`) });
  const contracts = useQuery({ queryKey: ['contracts', id], queryFn: () => api<any[]>(`/employees/${id}/contracts`), retry: false });
  const training = useQuery({ queryKey: ['training', id], queryFn: () => api<any[]>(`/employees/${id}/training`) });
  const ssc = useQuery({ queryKey: ['ssc', 'all'], queryFn: () => api<any[]>('/ssc/actions'), retry: false });
  const [asg, setAsg] = useState({ branchId: '', validFrom: '', isPrimary: false });
  const [con, setCon] = useState({ effectiveDate: '', salaryBasic: '', weeklyHours: '' });
  // null = untouched, so the form shows (and saves) the current contract's allowances.
  const [conAllow, setConAllow] = useState<Row[] | null>(null);
  const [trainItem, setTrainItem] = useState('');
  const library = useQuery({ queryKey: ['lib'], queryFn: () => api<any[]>('/ops/library'), retry: false });
  const refresh = () => qc.invalidateQueries();
  const addAsg = useMutation({ mutationFn: () => api(`/employees/${id}/assignments`, { body: { branchId: asg.branchId, validFrom: asg.validFrom, isPrimary: asg.isPrimary } }), onSuccess: refresh });
  const endAsg = useMutation({ mutationFn: (aid: string) => api(`/employees/${id}/assignments/${aid}/end`, { body: {} }), onSuccess: refresh });
  const newCon = useMutation({ mutationFn: () => api(`/employees/${id}/contracts`, { body: { effectiveDate: con.effectiveDate, salaryBasic: Number(con.salaryBasic), allowances: conAllow ? fromRows(conAllow) : undefined, weeklyHours: con.weeklyHours ? Number(con.weeklyHours) : undefined } }), onSuccess: () => { setConAllow(null); refresh(); } });
  const currentAllow = conAllow ?? toRows(contracts.data?.find((c) => c.status === 'ACTIVE')?.allowances);
  const doneTr = useMutation({ mutationFn: (tid: string) => api(`/training/${tid}/complete`, { method: 'POST' }), onSuccess: refresh });
  const addTr = useMutation({ mutationFn: () => api(`/employees/${id}/training`, { body: { itemId: trainItem } }), onSuccess: () => { setTrainItem(''); refresh(); } });
  const e = emp.data;
  if (!e) return <Card><ErrorBox error={emp.error} />{emp.isLoading && <Empty>Loading...</Empty>}</Card>;
  const mine = ssc.data?.filter((a) => a.employeeId === id) ?? [];
  return (
    <div className="space-y-4">
      <ErrorBox error={addAsg.error ?? endAsg.error ?? newCon.error ?? doneTr.error ?? addTr.error} />
      <Card title={<>{e.name} · {e.number}<PermitBadge permit={e.permit} /></>}>
        <p className="text-sm"><StatusBadge status={e.status} /> hired {formatDate(e.hireDate)} · {e.phone} {e.email}</p>
        {e.isHr && "sscRateNote" in e && <SensitiveCard id={id} canEdit={e.canEditSensitive} />}
      </Card>
      <Card title="Assignments (branches)">
        <Table head={['Branch', 'Primary', 'From', 'To', '']}>
          {e.assignments?.map((a: any) => (
            <tr key={a.id}>
              <td className="px-3 py-2">{nameOf(branches.data, a.branchId)}</td>
              <td className="px-3 py-2">{a.isPrimary ? 'yes' : ''}</td>
              <td className="px-3 py-2 text-xs">{formatDate(a.validFrom)}</td>
              <td className="px-3 py-2 text-xs">{a.validTo ? formatDate(a.validTo) : 'open'}</td>
              <td className="px-3 py-2 text-end">{!a.validTo && <Button variant="ghost" onClick={() => endAsg.mutate(a.id)}>End</Button>}</td>
            </tr>
          ))}
        </Table>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); addAsg.mutate(); }}>
          <Select className="w-44" value={asg.branchId} onChange={(ev) => setAsg({ ...asg, branchId: ev.target.value })} required><option value="">Branch</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Input type="date" className="w-40" value={asg.validFrom} onChange={(ev) => setAsg({ ...asg, validFrom: ev.target.value })} required />
          <label className="text-sm"><input type="checkbox" checked={asg.isPrimary} onChange={(ev) => setAsg({ ...asg, isPrimary: ev.target.checked })} /> primary</label>
          <Button type="submit">Add</Button>
        </form>
      </Card>
      {e.isHr && "sscRateNote" in e && <PermitCard e={e} />}
      <ManagerCard e={e} />
      {"sscRateNote" in e && <AccessCard e={e} />}
      {"sscRateNote" in e && <RatesCard e={e} />}
      <Card title="Contracts">
        <ErrorBox error={contracts.error} />
        <Table head={['Version', 'Type', 'Basic salary', 'Allowances', 'From', 'Status']}>
          {contracts.data?.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-2">v{c.version}</td><td className="px-3 py-2">{c.type}</td>
              <td className="px-3 py-2">{formatJOD(c.salaryBasic, lang)}</td><td className="px-3 py-2 text-xs">{c.allowances?.map((a: any) => `${a.name} ${formatJOD(a.amount, lang)}`).join(', ') || '—'}</td><td className="px-3 py-2 text-xs">{formatDate(c.startDate)}</td>
              <td className="px-3 py-2"><Badge>{c.status}</Badge></td>
            </tr>
          ))}
        </Table>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); newCon.mutate(); }}>
          <Field label="Effective date"><Input type="date" value={con.effectiveDate} onChange={(ev) => setCon({ ...con, effectiveDate: ev.target.value })} required /></Field>
          <Field label="Basic salary (JOD)"><Input type="number" step="0.001" value={con.salaryBasic} onChange={(ev) => setCon({ ...con, salaryBasic: ev.target.value })} required /></Field>
          <Field label="Weekly hours"><Input type="number" value={con.weeklyHours} onChange={(ev) => setCon({ ...con, weeklyHours: ev.target.value })} /></Field>
          <div className="w-full"><Allowances rows={currentAllow} onChange={setConAllow} /></div>
          <Button type="submit">New version</Button>
        </form>
      </Card>
      <Card title="Training">
        {training.data?.length === 0 ? <Empty>No training assigned.</Empty> : (
          <ul className="space-y-1 text-sm">
            {training.data?.map((t) => (
              <li key={t.id} className="flex items-center justify-between">
                <span>{t.title} {t.mandatory && <Badge>mandatory</Badge>} {t.dueDate && <span className="text-xs text-slate-500">due {formatDate(t.dueDate)}</span>}</span>
                {t.itemCode || t.status === 'DONE' ? <StatusBadge status={t.status} /> : <Button variant="ghost" onClick={() => doneTr.mutate(t.id)}>Mark done (old item, no exam)</Button>}
              </li>
            ))}
          </ul>
        )}
        <form className="mt-3 flex gap-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); addTr.mutate(); }}>
          <Select required value={trainItem} onChange={(ev) => setTrainItem(ev.target.value)}><option value="">Assign training (has an exam)...</option>{library.data?.map((i) => <option key={i.id} value={i.id}>{i.title} v{i.version}</option>)}</Select>
          <Button type="submit">Assign</Button>
        </form>
      </Card>
      <Card title="SSC actions">
        {mine.length === 0 ? <Empty>No SSC actions.</Empty> : <ul className="space-y-1 text-sm">{mine.map((a) => <li key={a.id}>{a.kind} <StatusBadge status={a.status} /> {a.reference}</li>)}</ul>}
      </Card>
    </div>
  );
}

function Ssc() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['ssc', status], queryFn: () => api<any[]>(`/ssc/actions${status ? `?status=${status}` : ''}`) });
  const [pkg, setPkg] = useState<any>(null);
  const [ref, setRef] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['ssc'] });
  const make = useMutation({ mutationFn: (id: string) => api(`/ssc/actions/${id}/package`, { method: 'POST' }), onSuccess: setPkg });
  const submit = useMutation({ mutationFn: (id: string) => api(`/ssc/actions/${id}/record-submission`, { body: { reference: ref[id] } }), onSuccess: refresh });
  const confirm = useMutation({ mutationFn: (id: string) => api(`/ssc/actions/${id}/confirm`, { body: { reference: ref[id] || undefined } }), onSuccess: refresh });
  const fail = useMutation({ mutationFn: (id: string) => api(`/ssc/actions/${id}/fail`, { body: { notes: ref[id] } }), onSuccess: refresh });
  return (
    <div className="space-y-4">
      <ErrorBox error={list.error ?? make.error ?? submit.error ?? confirm.error ?? fail.error} />
      <Card>
        <div className="mb-3 flex items-center gap-3">
          <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <p className="text-xs text-slate-500">Official submission is not automated: HR submits through the authority's portal and records the reference here. Opening the package shows sensitive data and is audited.</p>
        </div>
        {list.data?.length === 0 ? <Empty>No SSC actions.</Empty> : (
          <Table head={['Kind', 'Employee', 'Prepared', 'Status', 'Reference / notes', 'Actions']}>
            {list.data?.map((a) => (
              <tr key={a.id}>
                <td className="px-3 py-2 font-medium">{a.kind}</td>
                <td className="px-3 py-2 text-xs">{(a.payload as any)?.name ?? a.employeeId.slice(0, 8)} {(a.payload as any)?.employeeNumber}</td>
                <td className="px-3 py-2 text-xs">{formatDate(a.preparedAt)}</td>
                <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                <td className="px-3 py-2"><Input className="w-40" placeholder={a.reference ?? 'reference / notes'} value={ref[a.id] ?? ''} onChange={(e) => setRef({ ...ref, [a.id]: e.target.value })} /></td>
                <td className="space-x-1 px-3 py-2">
                  {a.status === 'PREPARED' && <><Button variant="ghost" onClick={() => make.mutate(a.id)}>Guided package</Button><Button disabled={!ref[a.id]} onClick={() => submit.mutate(a.id)}>Record submission</Button></>}
                  {a.status === 'SUBMITTED' && <Button onClick={() => confirm.mutate(a.id)}>Confirm</Button>}
                  {['PREPARED', 'SUBMITTED'].includes(a.status) && <Button variant="danger" disabled={!ref[a.id] || ref[a.id].length < 3} onClick={() => fail.mutate(a.id)}>Mark failed</Button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {pkg && (
        <Card title={`Guided package (${pkg.method})`}>
          <p className="mb-2 text-sm text-slate-600">{pkg.why}</p>
          <ol className="mb-2 list-decimal ps-5 text-sm">{(pkg.steps as string[]).map((s, i) => <li key={i}>{s}</li>)}</ol>
          <pre className="rounded bg-slate-50 p-2 text-xs">{JSON.stringify(pkg.data, null, 2)}</pre>
          <Button variant="ghost" className="mt-2" onClick={() => setPkg(null)}>Close</Button>
        </Card>
      )}
    </div>
  );
}
