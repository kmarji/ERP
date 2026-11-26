import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Select, StatusBadge, Table } from '../components/ui';
import { api, blobUrl, upload } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export type Row = { name: string; amount: string };
export const toRows = (a?: { name: string; amount: number }[]): Row[] => (a ?? []).map((x) => ({ name: x.name, amount: String(x.amount) }));
export const fromRows = (rows: Row[]) => rows.map((r) => ({ name: r.name, amount: Number(r.amount) }));
export function Allowances({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
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

export type Permit = { needsWorkPermit: boolean; workPermitNumber: string; workPermitExpiry: string };
export const fromEmployee = (e: any): Permit => ({ needsWorkPermit: e.needsWorkPermit, workPermitNumber: e.workPermitNumber ?? '', workPermitExpiry: e.workPermitExpiry?.slice(0, 10) ?? '' });
export const toPermit = (p: Permit) => ({ needsWorkPermit: p.needsWorkPermit, workPermitNumber: p.workPermitNumber || null, workPermitExpiry: p.workPermitExpiry || null });
export function PermitFields({ value, onChange }: { value: Permit; onChange: (p: Permit) => void }) {
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

export function PermitBadge({ permit }: { permit?: { state: 'INCOMPLETE' | 'EXPIRED' | 'EXPIRING'; daysLeft: number | null } | null }) {
  if (!permit) return null;
  const text = permit.state === 'INCOMPLETE' ? 'Work permit incomplete' : permit.state === 'EXPIRED' ? 'Permit expired' : permit.daysLeft === 0 ? 'Permit expires today' : `Permit expires in ${permit.daysLeft} day${permit.daysLeft === 1 ? '' : 's'}`;
  return <span className={`ms-2 inline-block rounded px-2 py-0.5 text-xs font-semibold ${permit.state === 'EXPIRING' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700'}`}>{text}</span>;
}

export const GENDERS = ['MALE', 'FEMALE'];
export const MARITAL = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'];
export const WORK_TYPES = ['FULL_TIME', 'PART_TIME', 'TEMPORARY'];
const label = (v?: string | null) => (v ? v.charAt(0) + v.slice(1).toLowerCase().replace('_', ' ') : '');
// Calendar dates are stored at UTC midnight, so they are shown in UTC.
const day = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const plural = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
const periodText = (p?: { years: number; months: number; days: number }) => (p ? [plural(p.years, 'year'), plural(p.months, 'month'), plural(p.days, 'day')].filter(Boolean).join(', ') || '0 days' : '');
const ageOf = (dob: string) => {
  const b = new Date(dob), now = new Date();
  const before = now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate());
  return now.getUTCFullYear() - b.getUTCFullYear() - (before ? 1 : 0);
};

function Choice({ label: text, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return <Field label={text}><Select value={value} onChange={(ev) => onChange(ev.target.value)}><option value="">Not set</option>{options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</Select></Field>;
}

export type Work = { workType: string; department: string; section: string; workLocation: string; probationMonths: string };
const SUGGESTED = [['department', 'Department'], ['workLocation', 'Work location'], ['section', 'Section']] as const;
// Work type, free-text placement (suggesting values already used) and probation. Shared by "Add employee" and Professional info.
export function WorkFields({ value, onChange }: { value: Work; onChange: (w: Work) => void }) {
  const emps = useQuery({ queryKey: ['employees', ''], queryFn: () => api<any[]>('/employees') });
  return (
    <>
      <Choice label="Work type" value={value.workType} options={WORK_TYPES} onChange={(workType) => onChange({ ...value, workType })} />
      {SUGGESTED.map(([k, text]) => (
        <Field key={k} label={text}>
          <Input maxLength={80} list={`used-${k}`} value={value[k]} onChange={(ev) => onChange({ ...value, [k]: ev.target.value })} />
          <datalist id={`used-${k}`}>{[...new Set((emps.data ?? []).map((x) => x[k]).filter(Boolean))].map((v) => <option key={v as string} value={v as string} />)}</datalist>
        </Field>
      ))}
      <Field label="Probation (months)"><Input type="number" min="0" max="24" required value={value.probationMonths} onChange={(ev) => onChange({ ...value, probationMonths: ev.target.value })} /></Field>
    </>
  );
}

// A card showing values read-only, with Edit opening a form. The form mounts fresh each time, so it never holds stale values.
function Section({ title, actions, form, children }: { title: string; actions?: ReactNode; form?: (close: () => void) => ReactNode; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="flex gap-3">{actions}{form && !editing && <button type="button" className="text-sm font-medium text-brand-600 hover:underline" onClick={() => setEditing(true)}>Edit</button>}</div>
      </div>
      {editing && form ? form(() => setEditing(false)) : children}
    </Card>
  );
}

function Facts({ items, cols = 'sm:grid-cols-2' }: { items: [string, ReactNode][]; cols?: string }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 ${cols}`}>
      {items.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="break-words text-sm font-medium text-slate-800">{v || '—'}</dd></div>)}
    </dl>
  );
}

function Actions({ pending, close }: { pending: boolean; close: () => void }) {
  return <div className="flex gap-2 sm:col-span-2"><Button disabled={pending}>Save</Button><Button type="button" variant="ghost" onClick={close}>Cancel</Button></div>;
}

function PatchForm({ id, body, close, children }: { id: string; body: () => object; close: () => void; children: ReactNode }) {
  const qc = useQueryClient();
  const save = useMutation({ mutationFn: () => api(`/employees/${id}`, { method: 'PATCH', body: body() }), onSuccess: () => { qc.invalidateQueries(); close(); } });
  return (
    <>
      <ErrorBox error={save.error} />
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); save.mutate(); }}>{children}<Actions pending={save.isPending} close={close} /></form>
    </>
  );
}

function Photo({ e }: { e: any }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!e.hasPhoto) { setUrl(null); return; }
    let made: string | null = null, gone = false;
    blobUrl(`/employees/${e.id}/photo`).then((u) => { made = u; if (gone) URL.revokeObjectURL(u); else setUrl(u); }).catch(() => setUrl(null));
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [e.id, e.hasPhoto, version]);
  const done = () => { setVersion((v) => v + 1); qc.invalidateQueries(); };
  const put = useMutation({ mutationFn: (f: File) => upload(`/employees/${e.id}/photo`, f), onSuccess: done });
  const drop = useMutation({ mutationFn: () => api(`/employees/${e.id}/photo`, { method: 'DELETE' }), onSuccess: done });
  const initials = e.name.split(/\s+/).slice(0, 2).map((w: string) => w[0]).join('').toUpperCase();
  return (
    <div className="flex flex-col items-center gap-1">
      {url ? <img src={url} alt={`Photo of ${e.name}`} className="h-32 w-28 rounded-lg object-cover" /> : <div className="flex h-32 w-28 items-center justify-center rounded-lg bg-slate-100 text-3xl font-semibold text-slate-400">{initials}</div>}
      <ErrorBox error={put.error ?? drop.error} />
      {e.canEditSensitive && (
        <div className="flex gap-2 text-xs">
          <label className="cursor-pointer text-brand-600 hover:underline focus-within:underline">{e.hasPhoto ? 'Change photo' : 'Add photo'}<input type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) put.mutate(f); ev.target.value = ''; }} /></label>
          {e.hasPhoto && <button type="button" className="text-red-600 hover:underline" onClick={() => drop.mutate()}>Remove</button>}
        </div>
      )}
    </div>
  );
}

function ResetPassword({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const reset = useMutation({ mutationFn: () => api(`/employees/${id}/password`, { body: { password: pw } }), onSuccess: () => { setPw(''); setOpen(false); } });
  if (!open) return <div className="mt-3 flex items-center gap-2"><Button variant="ghost" onClick={() => { reset.reset(); setOpen(true); }}>Reset password</Button>{reset.isSuccess && <span className="text-xs text-emerald-700">Password changed.</span>}</div>;
  return (
    <form className="mt-3 space-y-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); reset.mutate(); }}>
      <ErrorBox error={reset.error} />
      <Field label="New password (min 10)"><Input required minLength={10} value={pw} onChange={(ev) => setPw(ev.target.value)} /></Field>
      <div className="flex gap-2"><Button disabled={reset.isPending}>Set password</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}

function UserForm({ e, close }: { e: any; close: () => void }) {
  const [f, setF] = useState({ name: e.name, nameAr: e.nameAr ?? '', phone: e.phone, email: e.email ?? '' });
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  return (
    <PatchForm id={e.id} close={close} body={() => ({ name: f.name, nameAr: f.nameAr || null, phone: f.phone, email: f.email || null })}>
      <Field label="Name"><Input required minLength={2} value={f.name} onChange={set('name')} /></Field>
      <Field label="Name (Arabic)"><Input dir="rtl" value={f.nameAr} onChange={set('nameAr')} /></Field>
      <Field label="Phone"><Input required minLength={5} value={f.phone} onChange={set('phone')} /></Field>
      <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
    </PatchForm>
  );
}

function UserInfo({ e }: { e: any }) {
  const access = useQuery({ queryKey: ['access', e.id], queryFn: () => api<any>(`/employees/${e.id}/access`), retry: false });
  return (
    <Section title="User info" form={e.isHr ? (close) => <UserForm e={e} close={close} /> : undefined}>
      <Photo e={e} />
      <div className="mt-3"><Facts items={[['Name', <>{e.name}{e.nameAr && <span className="block" dir="rtl">{e.nameAr}</span>}</>], ['Employment number', e.number], ['Status', <StatusBadge status={e.status} />], ['Phone', e.phone], ['Email', e.email]]} /></div>
      {e.permit && <div className="mt-3 -ms-2"><PermitBadge permit={e.permit} /></div>}
      {access.data?.user && <ResetPassword id={e.id} />}
    </Section>
  );
}

const SENSITIVE = [['nationalId', 'National ID', 'text'], ['dateOfBirth', 'Birth date', 'date'], ['address', 'Address', 'text'], ['iban', 'IBAN (salary account)', 'text']] as const;
// Encrypted items stay hidden until asked for; every view and change is audited.
function PrivateDetails({ id, canEdit }: { id: string; canEdit: boolean }) {
  const [shown, setShown] = useState<Record<string, string> | null>(null);
  const [f, setF] = useState<Record<string, string> | null>(null);
  const load = useMutation({ mutationFn: () => api<Record<string, string>>(`/employees/${id}/sensitive`), onSuccess: setShown });
  // All four are sent: an emptied box removes that value.
  const save = useMutation({ mutationFn: () => api<Record<string, string>>(`/employees/${id}/sensitive`, { method: 'PUT', body: Object.fromEntries(SENSITIVE.map(([k]) => [k, f?.[k] ?? ''])) }), onSuccess: (r) => { setShown(r); setF(null); } });
  return (
    <div className="mt-4 border-t border-slate-200 pt-3 text-sm">
      <ErrorBox error={load.error ?? save.error} />
      {!shown ? (
        <>
          <p className="mb-2 text-xs text-slate-500">National ID, birth date, age, address and IBAN are encrypted. Viewing them is recorded with your name.</p>
          <Button variant="ghost" onClick={() => load.mutate()}>Show</Button>
        </>
      ) : f ? (
        <form className="space-y-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); save.mutate(); }}>
          {SENSITIVE.map(([k, text, type]) => <Field key={k} label={text}><Input type={type} value={(type === 'date' ? f[k]?.slice(0, 10) : f[k]) ?? ''} onChange={(ev) => setF({ ...f, [k]: ev.target.value })} /></Field>)}
          <Actions pending={save.isPending} close={() => { save.reset(); setF(null); }} />
        </form>
      ) : (
        <>
          <Facts items={[['National ID', shown.nationalId], ['Birth date', day(shown.dateOfBirth)], ['Age', shown.dateOfBirth ? `${ageOf(shown.dateOfBirth)} years old` : ''], ['Address', shown.address], ['IBAN', shown.iban]]} />
          <div className="mt-3 flex gap-2">{canEdit && <Button variant="ghost" onClick={() => setF(shown)}>Edit private details</Button>}<Button variant="ghost" onClick={() => setShown(null)}>Hide</Button></div>
        </>
      )}
    </div>
  );
}

function PersonalForm({ e, close }: { e: any; close: () => void }) {
  const [f, setF] = useState({ nationality: e.nationality ?? '', gender: e.gender ?? '', maritalStatus: e.maritalStatus ?? '' });
  return (
    <PatchForm id={e.id} close={close} body={() => ({ nationality: f.nationality || undefined, ...(e.canEditSensitive ? { gender: f.gender || null, maritalStatus: f.maritalStatus || null } : {}) })}>
      <Field label="Nationality"><Input minLength={2} maxLength={60} value={f.nationality} onChange={(ev) => setF({ ...f, nationality: ev.target.value })} /></Field>
      {e.canEditSensitive && <>
        <Choice label="Gender" value={f.gender} options={GENDERS} onChange={(gender) => setF({ ...f, gender })} />
        <Choice label="Marital status" value={f.maritalStatus} options={MARITAL} onChange={(maritalStatus) => setF({ ...f, maritalStatus })} />
      </>}
    </PatchForm>
  );
}

function ProfessionalForm({ e, hq, close }: { e: any; hq: boolean; close: () => void }) {
  const positions = useList('/recruitment/positions');
  const emps = useQuery({ queryKey: ['employees', ''], queryFn: () => api<any[]>('/employees') });
  const [positionId, setPosition] = useState<string>(e.positionId);
  const [managerId, setManager] = useState<string>(e.managerId ?? '');
  const [w, setW] = useState<Work>({ workType: e.workType ?? '', department: e.department ?? '', section: e.section ?? '', workLocation: e.workLocation ?? '', probationMonths: String(e.probationMonths) });
  const body = () => ({
    ...w, workType: w.workType || null, probationMonths: Number(w.probationMonths),
    ...(hq && managerId !== (e.managerId ?? '') ? { managerId: managerId || null } : {}),
    ...(e.canEditSensitive && positionId !== e.positionId ? { positionId } : {}),
  });
  return (
    <PatchForm id={e.id} close={close} body={body}>
      {e.canEditSensitive && <Field label="Job role"><Select value={positionId} onChange={(ev) => setPosition(ev.target.value)}>{positions.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field>}
      {hq && <Field label="Direct manager (approves leave)"><Select value={managerId} onChange={(ev) => setManager(ev.target.value)}><option value="">Nobody (approved by role in the back-office)</option>{emps.data?.filter((m) => m.id !== e.id && m.userId).map((m) => <option key={m.id} value={m.id}>{m.name} · {m.number}</option>)}</Select></Field>}
      <WorkFields value={w} onChange={setW} />
    </PatchForm>
  );
}

function SalaryPackage({ e }: { e: any }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const contracts = useQuery({ queryKey: ['contracts', e.id], queryFn: () => api<any[]>(`/employees/${e.id}/contracts`), retry: false });
  const [panel, setPanel] = useState<'new' | 'history' | null>(null);
  const current = e.activeContract;
  const allowances: { name: string; amount: number }[] = current?.allowances ?? [];
  const total = allowances.reduce((s, a) => s + Number(a.amount), Number(current?.salaryBasic ?? 0));
  const [f, setF] = useState({ effectiveDate: '', salaryBasic: '', weeklyHours: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const open = () => { setRows(toRows(allowances)); setPanel('new'); };
  const add = useMutation({ mutationFn: () => api(`/employees/${e.id}/contracts`, { body: { effectiveDate: f.effectiveDate, salaryBasic: Number(f.salaryBasic), allowances: fromRows(rows), weeklyHours: f.weeklyHours ? Number(f.weeklyHours) : undefined } }), onSuccess: () => { setPanel(null); setF({ effectiveDate: '', salaryBasic: '', weeklyHours: '' }); qc.invalidateQueries(); } });
  const link = (text: string, on: () => void) => <button type="button" className="text-sm font-medium text-brand-600 hover:underline" onClick={on}>{text}</button>;
  return (
    <Section title="Salary package" actions={<>{e.isHr && link('New package', open)}{link(panel === 'history' ? 'Hide history' : 'History', () => setPanel(panel === 'history' ? null : 'history'))}</>}>
      <ErrorBox error={contracts.error ?? add.error} />
      {!current ? <Empty>No salary package.</Empty> : (
        <>
          <Facts cols="sm:grid-cols-3" items={[['Basic salary', formatJOD(current.salaryBasic, lang)], ['Social security salary (before any ceiling)', formatJOD(total, lang)], ['Total salary', formatJOD(total, lang)]]} />
          <div className="mt-3 border-t border-slate-200 pt-3">
            <h3 className="mb-2 text-sm font-semibold text-brand-700">Allowances</h3>
            {allowances.length ? <Facts cols="sm:grid-cols-3" items={allowances.map((a, i): [string, ReactNode] => [allowances.findIndex((x) => x.name === a.name) === i ? a.name : `${a.name} (${i + 1})`, formatJOD(a.amount, lang)])} /> : <p className="text-sm text-slate-500">None.</p>}
          </div>
        </>
      )}
      {panel === 'new' && (
        <form className="mt-4 grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-3" onSubmit={(ev: FormEvent) => { ev.preventDefault(); add.mutate(); }}>
          <Field label="Effective date"><Input type="date" required value={f.effectiveDate} onChange={(ev) => setF({ ...f, effectiveDate: ev.target.value })} /></Field>
          <Field label="Basic salary (JOD)"><Input type="number" step="0.001" min="0" required value={f.salaryBasic} onChange={(ev) => setF({ ...f, salaryBasic: ev.target.value })} /></Field>
          <Field label="Weekly hours"><Input type="number" value={f.weeklyHours} onChange={(ev) => setF({ ...f, weeklyHours: ev.target.value })} /></Field>
          <div className="sm:col-span-3"><Allowances rows={rows} onChange={setRows} /></div>
          <Actions pending={add.isPending} close={() => setPanel(null)} />
        </form>
      )}
      {panel === 'history' && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <Table head={['Version', 'Type', 'Basic salary', 'Allowances', 'From', 'Status']}>
            {contracts.data?.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">v{c.version}</td><td className="px-3 py-2">{c.type}</td>
                <td className="px-3 py-2">{formatJOD(c.salaryBasic, lang)}</td><td className="px-3 py-2 text-xs">{c.allowances?.map((a: any) => `${a.name} ${formatJOD(a.amount, lang)}`).join(', ') || '—'}</td><td className="px-3 py-2 text-xs">{day(c.startDate)}</td>
                <td className="px-3 py-2"><Badge>{c.status}</Badge></td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Section>
  );
}

function PermitForm({ e, close }: { e: any; close: () => void }) {
  const [p, setP] = useState<Permit>(fromEmployee(e));
  return <PatchForm id={e.id} close={close} body={() => toPermit(p)}><PermitFields value={p} onChange={setP} /></PatchForm>;
}

// Login, role and password for one employee.
function AccessCard({ e }: { e: any }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['access', e.id], queryFn: () => api<any>(`/employees/${e.id}/access`), retry: false });
  const roles = useList('/roles');
  const branches = useList('/org/branches');
  const refresh = () => qc.invalidateQueries({ queryKey: ['access', e.id] });
  const [f, setF] = useState({ email: e.email ?? '', password: '', roleKey: 'EMPLOYEE' });
  const [add, setAdd] = useState({ roleKey: 'BRANCH_MANAGER', branchId: '' });
  const create = useMutation({ mutationFn: () => api(`/employees/${e.id}/login`, { body: f }), onSuccess: () => { setF({ ...f, password: '' }); qc.invalidateQueries(); } });
  const grant = useMutation({ mutationFn: () => api(`/users/${q.data.user.id}/roles`, { body: { roleKey: add.roleKey, branchId: add.branchId || undefined } }), onSuccess: refresh });
  const drop = useMutation({ mutationFn: (id: string) => api(`/users/${q.data.user.id}/roles/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const user = q.data?.user;
  return (
    <Card title="Login and role (permissions)">
      <ErrorBox error={q.error ?? create.error ?? grant.error ?? drop.error} />
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
        </div>
      )}
    </Card>
  );
}

// Fixed per-employee SSC and income tax ratios. Blank = follow the payroll rule set. Shown and typed as percentages.
const pct = (v: string | null | undefined) => (v == null ? '' : String(+(Number(v) * 100).toFixed(4)));
const frac = (v: string) => (v.trim() === '' ? null : Number(v) / 100);
function RatesForm({ e, close }: { e: any; close: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ee: pct(e.sscEmployeeRate), er: pct(e.sscEmployerRate), sscNote: e.sscRateNote ?? '', tax: pct(e.incomeTaxRate), taxNote: e.incomeTaxRateNote ?? '' });
  const save = useMutation({
    mutationFn: () => api(`/employees/${e.id}/payroll-rates`, { method: 'PATCH', body: { sscEmployeeRate: frac(f.ee), sscEmployerRate: frac(f.er), sscRateNote: f.sscNote, incomeTaxRate: frac(f.tax), incomeTaxRateNote: f.taxNote } }),
    onSuccess: () => { qc.invalidateQueries(); close(); },
  });
  const sscSet = f.ee.trim() !== '' || f.er.trim() !== '';
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  return (
    <>
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
        <Actions pending={save.isPending} close={close} />
      </form>
    </>
  );
}

export default function EmployeeProfile({ id }: { id: string }) {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => api<any>(`/employees/${id}`) });
  const training = useQuery({ queryKey: ['training', id], queryFn: () => api<any[]>(`/employees/${id}/training`) });
  const ssc = useQuery({ queryKey: ['ssc', 'all'], queryFn: () => api<any[]>('/ssc/actions'), retry: false });
  const [asg, setAsg] = useState({ branchId: '', validFrom: '', isPrimary: false });
  const [trainItem, setTrainItem] = useState('');
  const library = useQuery({ queryKey: ['lib'], queryFn: () => api<any[]>('/ops/library'), retry: false });
  const refresh = () => qc.invalidateQueries();
  const addAsg = useMutation({ mutationFn: () => api(`/employees/${id}/assignments`, { body: { branchId: asg.branchId, validFrom: asg.validFrom, isPrimary: asg.isPrimary } }), onSuccess: refresh });
  const endAsg = useMutation({ mutationFn: (aid: string) => api(`/employees/${id}/assignments/${aid}/end`, { body: {} }), onSuccess: refresh });
  const doneTr = useMutation({ mutationFn: (tid: string) => api(`/training/${tid}/complete`, { method: 'POST' }), onSuccess: refresh });
  const addTr = useMutation({ mutationFn: () => api(`/employees/${id}/training`, { body: { itemId: trainItem } }), onSuccess: () => { setTrainItem(''); refresh(); } });
  const e = emp.data;
  if (!e) return <Card><ErrorBox error={emp.error} />{emp.isLoading && <Empty>Loading...</Empty>}</Card>;
  const mine = ssc.data?.filter((a) => a.employeeId === id) ?? [];
  // Company-wide roles are the only ones sent the pay ratios, salary and permit number.
  const hq = 'sscRateNote' in e;
  const main = e.assignments?.find((a: any) => a.isPrimary && !a.validTo) ?? e.assignments?.find((a: any) => !a.validTo);
  const percent = (v: string | null) => (v == null ? 'Company rule' : `${pct(v)}%`);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="space-y-4">
        <UserInfo e={e} />
        <Section title="Personal info" form={e.isHr ? (close) => <PersonalForm e={e} close={close} /> : undefined}>
          <Facts items={[['Nationality', e.nationality], ...(hq ? [['Gender', label(e.gender)], ['Marital status', label(e.maritalStatus)]] as [string, ReactNode][] : [])]} />
          {e.isHr && hq && <PrivateDetails id={id} canEdit={e.canEditSensitive} />}
        </Section>
      </div>
      <div className="space-y-4">
        <ErrorBox error={addAsg.error ?? endAsg.error ?? doneTr.error ?? addTr.error} />
        <Section title="Professional info" form={e.isHr ? (close) => <ProfessionalForm e={e} hq={hq} close={close} /> : undefined}>
          <Facts cols="sm:grid-cols-3" items={[
            ['Job role', e.positionTitle], ['Branch', main && nameOf(branches.data, main.branchId)], ['Hiring date', day(e.hireDate)],
            ['Work type', label(e.workType)], ['Work location', e.workLocation], ['End of probation', e.probationMonths ? day(e.probationEnd) : 'No probation'],
            ['Direct manager', e.managerName], ['Department', e.department], ['Period of employment', periodText(e.employmentPeriod)],
            ['Section', e.section],
          ]} />
        </Section>
        {hq && <SalaryPackage e={e} />}
        <Section title="Work permit" form={e.isHr && hq ? (close) => <PermitForm e={e} close={close} /> : undefined}>
          {!e.needsWorkPermit ? <p className="text-sm text-slate-500">Not required.</p> : <Facts cols="sm:grid-cols-3" items={[['Required', 'Yes'], ...(hq ? [['Permit number', e.workPermitNumber]] as [string, ReactNode][] : []), ['Expiry date', day(e.workPermitExpiry)]]} />}
        </Section>
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
      {hq && <AccessCard e={e} />}
        {hq && (
          <Section title="Payroll ratios" form={(close) => <RatesForm e={e} close={close} />}>
            <Facts cols="sm:grid-cols-3" items={[['SSC employee', percent(e.sscEmployeeRate)], ['SSC employer', percent(e.sscEmployerRate)], ['Income tax', percent(e.incomeTaxRate)], ...(e.sscRateNote ? [['Why this SSC ratio', e.sscRateNote]] as [string, ReactNode][] : []), ...(e.incomeTaxRateNote ? [['Why this tax ratio', e.incomeTaxRateNote]] as [string, ReactNode][] : [])]} />
          </Section>
        )}
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
    </div>
  );
}
