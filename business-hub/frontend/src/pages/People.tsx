import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useList } from '../lib/lookups';
import EmployeeProfile, { Allowances, fromRows, GENDERS, MARITAL, Permit, PermitBadge, PermitFields, Row, Work, WorkFields } from './EmployeeProfile';

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
  const back = () => { setSel(null); setAdding(false); };
  if (adding || sel) {
    return (
      <div className="space-y-4">
        <button type="button" className="text-sm font-medium text-brand-600 hover:underline" onClick={back}>← Back to employees</button>
        {adding ? <AddEmployee onDone={(id) => { setAdding(false); setSel(id); }} onCancel={back} /> : <EmployeeProfile key={sel} id={sel!} />}
      </div>
    );
  }
  return (
      <Card>
        <Button className="mb-3" onClick={() => setAdding(true)}>Add employee</Button>
        <div className="mb-3 grid grid-cols-3 gap-2">
          <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <Input placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </div>
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No employees.</Empty> : (
          <Table head={['No.', 'Name', 'Status', 'Login']}>
            {list.data?.map((e) => (
              <tr key={e.id} onClick={() => setSel(e.id)} className="cursor-pointer hover:bg-slate-50">
                <td className="px-3 py-2 text-xs">{e.number}</td>
                <td className="px-3 py-2 font-medium"><button type="button" className="text-start hover:underline">{e.name}</button><PermitBadge permit={e.permit} /></td>
                <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                <td className="px-3 py-2 text-xs">{e.userId ? '✓' : <span className="font-semibold text-amber-700">none</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
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
  const [more, setMore] = useState({ gender: '', maritalStatus: '' });
  const [work, setWork] = useState<Work>({ workType: '', department: '', section: '', workLocation: '', probationMonths: '3' });
  const [permit, setPermit] = useState<Permit>({ needsWorkPermit: false, workPermitNumber: '', workPermitExpiry: '' });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => api<any>('/employees', { body: { gender: more.gender || undefined, maritalStatus: more.maritalStatus || undefined, ...work, workType: work.workType || undefined, probationMonths: Number(work.probationMonths), name: f.name, nationality: f.nationality, needsWorkPermit: permit.needsWorkPermit, workPermitNumber: permit.workPermitNumber || undefined, workPermitExpiry: permit.workPermitExpiry || undefined, allowances: fromRows(allow), nameAr: f.nameAr || undefined, phone: f.phone, email: f.email || undefined, legalEntityId: f.legalEntityId, branchId: f.branchId, positionId: f.positionId, hireDate: f.hireDate, salaryBasic: Number(f.salaryBasic), managerId: f.managerId || undefined, login: f.login ? { email: f.email, password: f.password, roleKey: f.roleKey } : undefined } }),
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
        <Field label="Gender"><Select value={more.gender} onChange={(e) => setMore({ ...more, gender: e.target.value })}><option value="">Not set</option>{GENDERS.map((g) => <option key={g} value={g}>{g.charAt(0) + g.slice(1).toLowerCase()}</option>)}</Select></Field>
        <Field label="Marital status"><Select value={more.maritalStatus} onChange={(e) => setMore({ ...more, maritalStatus: e.target.value })}><option value="">Not set</option>{MARITAL.map((g) => <option key={g} value={g}>{g.charAt(0) + g.slice(1).toLowerCase()}</option>)}</Select></Field>
        <Field label="Hire date"><Input type="date" required value={f.hireDate} onChange={set('hireDate')} /></Field>
        <Field label="Legal entity"><Select required value={f.legalEntityId} onChange={set('legalEntityId')}><option value="">Select...</option>{entities.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Branch"><Select required value={f.branchId} onChange={set('branchId')}><option value="">Select...</option>{branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Position"><Select required value={f.positionId} onChange={set('positionId')}><option value="">Select...</option>{positions.data?.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select></Field>
        <Field label="Basic salary (JOD)"><Input type="number" step="0.001" min="0" required value={f.salaryBasic} onChange={set('salaryBasic')} /></Field>
        <Allowances rows={allow} onChange={setAllow} />
        <WorkFields value={work} onChange={setWork} />
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
