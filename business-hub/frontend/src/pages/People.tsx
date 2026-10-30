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
      <Tabs tabs={['Employees', 'SSC']} value={tab} onChange={setTab} />
      {tab === 'Employees' ? <Directory /> : <Ssc />}
    </div>
  );
}

function Directory() {
  const branches = useList('/org/branches');
  const [f, setF] = useState({ branchId: '', status: '', q: '' });
  const [sel, setSel] = useState<string | null>(null);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ['employees', qs], queryFn: () => api<any[]>(`/employees?${qs}`) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <div className="mb-3 grid grid-cols-3 gap-2">
          <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED'].map((s) => <option key={s}>{s}</option>)}</Select>
          <Input placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </div>
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No employees.</Empty> : (
          <Table head={['No.', 'Name', 'Status']}>
            {list.data?.map((e) => (
              <tr key={e.id} onClick={() => setSel(e.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === e.id ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2 text-xs">{e.number}</td>
                <td className="px-3 py-2 font-medium">{e.name}</td>
                <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="lg:col-span-3">{sel ? <EmployeeDetail id={sel} /> : <Card><Empty>Select an employee.</Empty></Card>}</div>
    </div>
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
  const [sens, setSens] = useState<any>(null);
  const [asg, setAsg] = useState({ branchId: '', validFrom: '', isPrimary: false });
  const [con, setCon] = useState({ effectiveDate: '', salaryBasic: '', weeklyHours: '' });
  const [trainTitle, setTrainTitle] = useState('');
  const refresh = () => qc.invalidateQueries();
  const sensitive = useMutation({ mutationFn: () => api(`/employees/${id}/sensitive`), onSuccess: setSens });
  const addAsg = useMutation({ mutationFn: () => api(`/employees/${id}/assignments`, { body: { branchId: asg.branchId, validFrom: asg.validFrom, isPrimary: asg.isPrimary } }), onSuccess: refresh });
  const endAsg = useMutation({ mutationFn: (aid: string) => api(`/employees/${id}/assignments/${aid}/end`, { body: {} }), onSuccess: refresh });
  const newCon = useMutation({ mutationFn: () => api(`/employees/${id}/contracts`, { body: { effectiveDate: con.effectiveDate, salaryBasic: Number(con.salaryBasic), weeklyHours: con.weeklyHours ? Number(con.weeklyHours) : undefined } }), onSuccess: refresh });
  const doneTr = useMutation({ mutationFn: (tid: string) => api(`/training/${tid}/complete`, { method: 'POST' }), onSuccess: refresh });
  const addTr = useMutation({ mutationFn: () => api(`/employees/${id}/training`, { body: { title: trainTitle, mandatory: true } }), onSuccess: () => { setTrainTitle(''); refresh(); } });
  const e = emp.data;
  if (!e) return <Card><ErrorBox error={emp.error} />{emp.isLoading && <Empty>Loading...</Empty>}</Card>;
  const mine = ssc.data?.filter((a) => a.employeeId === id) ?? [];
  return (
    <div className="space-y-4">
      <ErrorBox error={sensitive.error ?? addAsg.error ?? endAsg.error ?? newCon.error ?? doneTr.error ?? addTr.error} />
      <Card title={`${e.name} · ${e.number}`}>
        <p className="text-sm"><StatusBadge status={e.status} /> hired {formatDate(e.hireDate)} · {e.phone} {e.email}</p>
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="mb-2 text-amber-800">National id, date of birth, address and bank details are encrypted. Viewing them is recorded in the audit trail with your name.</p>
          {!sens ? <Button variant="ghost" onClick={() => sensitive.mutate()}>View sensitive details</Button> : (
            <>
              <pre className="rounded bg-white p-2 text-xs">{JSON.stringify(sens, null, 2)}</pre>
              <Button variant="ghost" className="mt-2" onClick={() => setSens(null)}>Hide</Button>
            </>
          )}
        </div>
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
      <Card title="Contracts">
        <ErrorBox error={contracts.error} />
        <Table head={['Version', 'Type', 'Salary', 'From', 'Status']}>
          {contracts.data?.map((c) => (
            <tr key={c.id}>
              <td className="px-3 py-2">v{c.version}</td><td className="px-3 py-2">{c.type}</td>
              <td className="px-3 py-2">{formatJOD(c.salaryBasic, lang)}</td><td className="px-3 py-2 text-xs">{formatDate(c.startDate)}</td>
              <td className="px-3 py-2"><Badge>{c.status}</Badge></td>
            </tr>
          ))}
        </Table>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); newCon.mutate(); }}>
          <Field label="Effective date"><Input type="date" value={con.effectiveDate} onChange={(ev) => setCon({ ...con, effectiveDate: ev.target.value })} required /></Field>
          <Field label="Basic salary (JOD)"><Input type="number" step="0.001" value={con.salaryBasic} onChange={(ev) => setCon({ ...con, salaryBasic: ev.target.value })} required /></Field>
          <Field label="Weekly hours"><Input type="number" value={con.weeklyHours} onChange={(ev) => setCon({ ...con, weeklyHours: ev.target.value })} /></Field>
          <Button type="submit">New version</Button>
        </form>
      </Card>
      <Card title="Training">
        {training.data?.length === 0 ? <Empty>No training assigned.</Empty> : (
          <ul className="space-y-1 text-sm">
            {training.data?.map((t) => (
              <li key={t.id} className="flex items-center justify-between">
                <span>{t.title} {t.mandatory && <Badge>mandatory</Badge>} {t.dueDate && <span className="text-xs text-slate-500">due {formatDate(t.dueDate)}</span>}</span>
                {t.status === 'DONE' ? <StatusBadge status="DONE" /> : <Button variant="ghost" onClick={() => doneTr.mutate(t.id)}>Mark done</Button>}
              </li>
            ))}
          </ul>
        )}
        <form className="mt-3 flex gap-2" onSubmit={(ev: FormEvent) => { ev.preventDefault(); addTr.mutate(); }}>
          <Input placeholder="Assign training" value={trainTitle} onChange={(ev) => setTrainTitle(ev.target.value)} required />
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
