import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, Select, StatusBadge, Table, Tabs } from './ui';
import { ApiError, api, auth, download } from './api';
import { addDays, formatDate, formatJOD, formatTime, ymd } from './format';
import Letter from './Letter';

const TENANT_KEY = 'bh_tenant';

export default function App() {
  const [signedIn, setSignedIn] = useState(!!auth.get());
  return signedIn ? <Portal onLogout={() => { auth.clear(); setSignedIn(false); }} /> : <Login onDone={() => setSignedIn(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [tenant, setTenant] = useState(new URLSearchParams(window.location.search).get('tenant') ?? localStorage.getItem(TENANT_KEY) ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<{ accessToken: string }>('/auth/login', { body: { tenant, email, password } }),
    onSuccess: (r) => { auth.set(r.accessToken); localStorage.setItem(TENANT_KEY, tenant); onDone(); },
  });
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-brand-900">Employee portal · بوابة الموظف</h1>
        <p className="mb-5 text-sm text-slate-500">Sign in · تسجيل الدخول</p>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); login.mutate(); }} className="space-y-3">
          <ErrorBox error={login.error} />
          <Field label="Business · الشركة"><Input value={tenant} onChange={(e) => setTenant(e.target.value)} required /></Field>
          <Field label="Email · البريد"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password · كلمة المرور"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Button type="submit" className="w-full" disabled={login.isPending}>Sign in</Button>
        </form>
      </Card>
    </div>
  );
}

function Portal({ onLogout }: { onLogout: () => void }) {
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api<any>('/me/profile') });
  const [tab, setTab] = useState('Home');
  if (profile.error) {
    const none = (profile.error as ApiError).status === 404;
    return <Shell name="" onLogout={onLogout}><Card><Empty>{none ? 'Your login is not linked to an employee record. Ask HR to link your account.' : (profile.error as Error).message}</Empty></Card></Shell>;
  }
  const tabs = ['Home', 'Leave', 'Letters', 'Payslips', ...(profile.data?.isManager ? ['Team'] : [])];
  return (
    <Shell name={profile.data ? `${profile.data.name} · ${profile.data.number}` : ''} onLogout={onLogout}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'Home' ? <Home /> : tab === 'Leave' ? <Leave /> : tab === 'Letters' ? <Letters /> : tab === 'Payslips' ? <Payslips /> : <Team />}
    </Shell>
  );
}

function Shell({ name, onLogout, children }: { name: string; onLogout: () => void; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl p-4">
      <header className="no-print mb-4 flex items-center justify-between">
        <div><h1 className="text-lg font-semibold text-brand-900">Employee portal · بوابة الموظف</h1><p className="text-sm text-slate-500">{name}</p></div>
        <Button variant="ghost" onClick={onLogout}>Sign out</Button>
      </header>
      {children}
    </div>
  );
}

function Home() {
  const qc = useQueryClient();
  const entries = useQuery({ queryKey: ['time'], queryFn: () => api<any[]>('/me/time') });
  const from = ymd(new Date());
  const shifts = useQuery({ queryKey: ['schedule', from], queryFn: () => api<any[]>(`/me/schedule?from=${from}&to=${addDays(from, 14)}`) });
  const open = entries.data?.find((e) => e.status === 'OPEN');
  const [geoDenied, setGeoDenied] = useState(false);
  const where = () => new Promise<{ lat?: number; lng?: number }>((ok) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { setGeoDenied(false); ok({ lat: p.coords.latitude, lng: p.coords.longitude }); }, () => { setGeoDenied(true); ok({}); }, { enableHighAccuracy: true, timeout: 10_000 }) : ok({}));
  const go = useMutation({ mutationFn: async (p: string) => api(`/me/${p}`, { method: 'POST', body: p === 'clock-in' ? await where() : {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['time'] }) });
  return (
    <div className="space-y-4">
      <Card title="Clock in / out · تسجيل الحضور">
        <ErrorBox error={go.error} />
        {geoDenied && go.error && <p className="mb-2 text-sm text-amber-700">Your browser did not share your location. Allow location access for this site (needs https) and try again.</p>}
        <div className="flex items-center gap-3">
          {open
            ? <><span className="text-sm">Clocked in since {formatDate(open.clockIn)}</span><Button variant="danger" disabled={go.isPending} onClick={() => go.mutate('clock-out')}>Clock out · خروج</Button></>
            : <><span className="text-sm text-slate-600">Not clocked in</span><Button disabled={go.isPending} onClick={() => go.mutate('clock-in')}>Clock in · دخول</Button></>}
        </div>
      </Card>
      <Card title="Next 14 days · الجدول">
        <ErrorBox error={shifts.error} />
        {shifts.data?.length === 0 ? <Empty>No shifts scheduled.</Empty> : (
          <Table head={['Date', 'Time', 'Status']}>
            {shifts.data?.map((s) => <tr key={s.id}><td className="px-3 py-2">{s.date.slice(0, 10)}</td><td className="px-3 py-2">{formatTime(s.startAt)}-{formatTime(s.endAt)}</td><td className="px-3 py-2"><StatusBadge status={s.status} /></td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Leave() {
  const qc = useQueryClient();
  const bal = useQuery({ queryKey: ['balances'], queryFn: () => api<any[]>('/me/leave/balances') });
  const reqs = useQuery({ queryKey: ['leave'], queryFn: () => api<any[]>('/me/leave/requests') });
  const [f, setF] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['leave'] }); qc.invalidateQueries({ queryKey: ['balances'] }); };
  const create = useMutation({ mutationFn: () => api('/me/leave/requests', { body: { ...f, reason: f.reason || undefined } }), onSuccess: () => { refresh(); setF({ leaveTypeId: '', startDate: '', endDate: '', reason: '' }); } });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/me/leave/requests/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  const typeName = (id: string) => bal.data?.find((b) => b.leaveTypeId === id)?.name ?? '';
  return (
    <div className="space-y-4">
      <Card title="My balances · رصيد الإجازات">
        <Table head={['Type', 'Accrued', 'Used', 'Available']}>
          {bal.data?.map((b) => <tr key={b.leaveTypeId}><td className="px-3 py-2">{b.name}</td><td className="px-3 py-2">{b.accrued}</td><td className="px-3 py-2">{b.used}</td><td className="px-3 py-2 font-medium">{b.available}</td></tr>)}
        </Table>
      </Card>
      <Card title="Request leave · طلب إجازة">
        <ErrorBox error={create.error} />
        <p className="mb-2 text-xs text-slate-500">Your request goes to your manager.</p>
        <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Type"><Select required value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}><option value="">Select...</option>{bal.data?.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}</option>)}</Select></Field>
          <Field label="From"><Input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
          <Field label="To"><Input type="date" required value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
          <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button disabled={create.isPending}>Submit</Button>
        </form>
      </Card>
      <Card title="My requests">
        <ErrorBox error={reqs.error ?? cancel.error} />
        {reqs.data?.length === 0 ? <Empty>No leave requests.</Empty> : (
          <Table head={['Type', 'From', 'To', 'Days', 'Status', '']}>
            {reqs.data?.map((r) => (
              <tr key={r.id}><td className="px-3 py-2">{typeName(r.leaveTypeId)}</td><td className="px-3 py-2 text-xs">{r.startDate.slice(0, 10)}</td><td className="px-3 py-2 text-xs">{r.endDate.slice(0, 10)}</td><td className="px-3 py-2">{r.days}</td><td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2 text-end">{['PENDING', 'APPROVED'].includes(r.status) && <Button variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Letters() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['letters'], queryFn: () => api<any[]>('/me/letters') });
  const [f, setF] = useState({ kind: 'SALARY', addressee: '', purpose: '' });
  const [view, setView] = useState<any>(null);
  const create = useMutation({ mutationFn: () => api('/me/letters', { body: { ...f, purpose: f.purpose || undefined } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['letters'] }); setF({ ...f, addressee: '', purpose: '' }); } });
  const open = useMutation({ mutationFn: (id: string) => api<any>(`/me/letters/${id}`), onSuccess: setView });
  return (
    <div className="space-y-4">
      <div className="no-print space-y-4">
        <Card title="Request a certificate · طلب شهادة">
          <ErrorBox error={create.error} />
          <p className="mb-2 text-xs text-slate-500">HR reviews the request. When approved, you can open and print the letter here.</p>
          <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="SALARY">Salary certificate · شهادة راتب</option><option value="EMPLOYMENT">Employment certificate · شهادة عمل</option></Select></Field>
            <Field label="Addressed to"><Input required minLength={2} value={f.addressee} onChange={(e) => setF({ ...f, addressee: e.target.value })} placeholder="e.g. Arab Bank" /></Field>
            <Field label="Purpose"><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
            <Button disabled={create.isPending}>Request</Button>
          </form>
        </Card>
        <Card title="My letters">
          <ErrorBox error={list.error ?? open.error} />
          {list.data?.length === 0 ? <Empty>No letters yet.</Empty> : (
            <Table head={['Type', 'To', 'Requested', 'Status', '']}>
              {list.data?.map((l) => (
                <tr key={l.id}><td className="px-3 py-2">{l.kind === 'SALARY' ? 'Salary' : 'Employment'}</td><td className="px-3 py-2">{l.addressee}</td><td className="px-3 py-2 text-xs">{formatDate(l.createdAt)}</td>
                  <td className="px-3 py-2"><StatusBadge status={l.status} />{l.status === 'REJECTED' && l.decisionNote && <div className="text-xs text-slate-500">{l.decisionNote}</div>}</td>
                  <td className="px-3 py-2 text-end">{l.status === 'APPROVED' && <Button variant="ghost" onClick={() => open.mutate(l.id)}>Open</Button>}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {view && (
        <div>
          <div className="no-print mb-2 flex gap-2"><Button onClick={() => window.print()}>Print / Save as PDF</Button><Button variant="ghost" onClick={() => setView(null)}>Close</Button></div>
          <Letter l={view} />
        </div>
      )}
    </div>
  );
}

function Payslips() {
  const q = useQuery({ queryKey: ['payslips'], queryFn: () => api<any[]>('/me/payslips') });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Payslips · قسائم الراتب">
      <ErrorBox error={q.error ?? err} />
      {q.data?.length === 0 ? <Empty>No payslips yet.</Empty> : (
        <Table head={['Period', 'Gross', 'Net', '']}>
          {q.data?.map((p) => (
            <tr key={p.lineId}><td className="px-3 py-2 text-xs">{p.periodStart.slice(0, 10)} to {p.periodEnd.slice(0, 10)}</td><td className="px-3 py-2">{formatJOD(p.gross)}</td><td className="px-3 py-2 font-medium">{formatJOD(p.net)}</td>
              <td className="px-3 py-2 text-end">{p.hasPayslip && <Button variant="ghost" onClick={() => download(`/me/payslips/${p.lineId}/download`, `payslip-${p.periodStart.slice(0, 7)}.html`).catch(setErr)}>Download</Button>}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// Only for people who have direct reports: approve or reject their leave.
function Team() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['team-leave'], queryFn: () => api<any[]>('/me/team/leave') });
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/me/team/leave/${x.id}/decide`, { body: { approve: x.approve } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['team-leave'] }) });
  return (
    <Card title="Leave waiting for you · طلبات فريقي">
      <ErrorBox error={q.error ?? decide.error} />
      {q.data?.length === 0 ? <Empty>Nothing waiting.</Empty> : (
        <Table head={['Employee', 'From', 'To', 'Days', 'Reason', '']}>
          {q.data?.map((r) => (
            <tr key={r.id}><td className="px-3 py-2 font-medium">{r.employee?.name}</td><td className="px-3 py-2 text-xs">{r.startDate.slice(0, 10)}</td><td className="px-3 py-2 text-xs">{r.endDate.slice(0, 10)}</td><td className="px-3 py-2">{r.days}</td><td className="px-3 py-2 text-xs">{r.reason}</td>
              <td className="px-3 py-2 text-end"><Button disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true })}>Approve</Button> <Button variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>Reject</Button></td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
