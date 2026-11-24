import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { nameOf, useList } from '../lib/lookups';

const CRITERIA = ['MIN_EXPERIENCE_YEARS', 'REQUIRED_SKILL', 'ANY_SKILL', 'LANGUAGE', 'WEEKEND_AVAILABILITY', 'NIGHT_AVAILABILITY', 'CERTIFICATION', 'LEGAL_WORK_ELIGIBILITY'];
const NO_VALUE = ['WEEKEND_AVAILABILITY', 'NIGHT_AVAILABILITY', 'LEGAL_WORK_ELIGIBILITY'];
const REASONS = ['NOT_MEETING_REQUIREMENTS', 'INTERVIEW_ASSESSMENT', 'NO_SHOW', 'POSITION_FILLED', 'OTHER_JOB_RELATED'];
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function Recruitment() {
  const [tab, setTab] = useState('Setup');
  return (
    <div>
      <PageHeader title="Recruitment" subtitle="Vacancies, screening on objective criteria, AI-assisted interviews with human review, and appeals." />
      <Tabs tabs={['Setup', 'Vacancies', 'Applicants', 'Appeals']} value={tab} onChange={setTab} />
      {tab === 'Setup' && <Setup />}
      {tab === 'Vacancies' && <Vacancies />}
      {tab === 'Applicants' && <Pipeline />}
      {tab === 'Appeals' && <Appeals />}
    </div>
  );
}

// ---------------------------------------------------------------- setup

function Setup() {
  const qc = useQueryClient();
  const positions = useList('/recruitment/positions');
  const templates = useList('/recruitment/interview-templates');
  const branches = useList('/org/branches');
  const budgets = useList('/recruitment/budgets');
  const refresh = () => qc.invalidateQueries({ queryKey: ['list'] });

  const [p, setP] = useState({ title: '', titleAr: '', payBandMin: '', payBandMax: '', skills: '', docs: 'NATIONAL_ID, BANK_DETAILS', training: '', template: '' });
  const [criteria, setCriteria] = useState<{ type: string; value: string }[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api('/recruitment/positions', {
        body: {
          title: p.title, titleAr: p.titleAr || undefined, payBandMin: Number(p.payBandMin), payBandMax: Number(p.payBandMax),
          requiredSkills: csv(p.skills), requiredDocuments: csv(p.docs), interviewTemplateId: p.template || undefined,
          trainingModules: csv(p.training).map((title) => ({ title, mandatory: true, dueDays: 14 })),
          eligibilityCriteria: criteria.map((c) => ({ type: c.type, value: NO_VALUE.includes(c.type) ? true : c.type === 'MIN_EXPERIENCE_YEARS' ? Number(c.value) : c.type === 'ANY_SKILL' ? csv(c.value) : c.value })),
        },
      }),
    onSuccess: () => { refresh(); setCriteria([]); },
  });
  const defTpl = useMutation({ mutationFn: (language: string) => api('/recruitment/interview-templates/default', { body: { language } }), onSuccess: refresh });
  const setTpl = useMutation({ mutationFn: (x: { id: string; interviewTemplateId: string }) => api(`/recruitment/positions/${x.id}`, { method: 'PATCH', body: { interviewTemplateId: x.interviewTemplateId } }), onSuccess: refresh });
  const [b, setB] = useState({ branchId: '', positionId: '', approved: '' });
  const setBudget = useMutation({ mutationFn: () => api('/recruitment/budgets', { method: 'PUT', body: { branchId: b.branchId, positionId: b.positionId, approved: Number(b.approved) } }), onSuccess: refresh });

  return (
    <div className="space-y-6">
      <ErrorBox error={create.error ?? defTpl.error ?? setBudget.error ?? setTpl.error} />
      <Card title="Positions">
        <Table head={['Title', 'Pay band (JOD)', 'Skills', 'Criteria', 'Template']}>
          {positions.data?.map((x) => (
            <tr key={x.id}>
              <td className="px-3 py-2 font-medium">{x.title}</td>
              <td className="px-3 py-2">{Number(x.payBandMin).toFixed(3)} - {Number(x.payBandMax).toFixed(3)}</td>
              <td className="px-3 py-2 text-xs">{(x.requiredSkills as string[]).join(', ')}</td>
              <td className="px-3 py-2 text-xs">{(x.eligibilityCriteria as any[]).map((c) => c.type).join(', ') || '-'}</td>
              <td className="px-3 py-2 text-xs">
                <Select value={x.interviewTemplateId ?? ''} onChange={(e) => setTpl.mutate({ id: x.id, interviewTemplateId: e.target.value })}>
                  <option value="" disabled>{templates.data?.length ? 'Newest template (default)' : 'No template yet'}</option>
                  {templates.data?.filter((t) => t.active !== false).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
                </Select>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="New position" className="lg:col-span-2">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Title"><Input value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} required /></Field>
            <Field label="Title (Arabic)"><Input value={p.titleAr} onChange={(e) => setP({ ...p, titleAr: e.target.value })} /></Field>
            <Field label="Pay band min (JOD)"><Input type="number" step="0.001" value={p.payBandMin} onChange={(e) => setP({ ...p, payBandMin: e.target.value })} required /></Field>
            <Field label="Pay band max (JOD)"><Input type="number" step="0.001" value={p.payBandMax} onChange={(e) => setP({ ...p, payBandMax: e.target.value })} required /></Field>
            <Field label="Required skills (comma separated)"><Input value={p.skills} onChange={(e) => setP({ ...p, skills: e.target.value })} /></Field>
            <Field label="Required documents"><Input value={p.docs} onChange={(e) => setP({ ...p, docs: e.target.value })} /></Field>
            <Field label="Training for new hires (names of Training & SOPs items, comma separated)"><Input value={p.training} onChange={(e) => setP({ ...p, training: e.target.value })} /></Field>
            <Field label="Interview template">
              <Select value={p.template} onChange={(e) => setP({ ...p, template: e.target.value })}>
                <option value="">None</option>
                {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
              </Select>
            </Field>
            <div className="md:col-span-2">
              <div className="mb-1 text-xs font-medium text-slate-600">Screening criteria</div>
              <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Only objective, job-related criteria are allowed. Age, gender, nationality, religion, marital status and similar characteristics cannot be used and are rejected by the server.</p>
              {criteria.map((c, i) => (
                <div key={i} className="mb-2 flex gap-2">
                  <Select value={c.type} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>{CRITERIA.map((t) => <option key={t}>{t}</option>)}</Select>
                  {!NO_VALUE.includes(c.type) && <Input placeholder={c.type === 'ANY_SKILL' ? 'skill1, skill2' : 'value'} value={c.value} onChange={(e) => setCriteria(criteria.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />}
                  <Button type="button" variant="ghost" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="ghost" onClick={() => setCriteria([...criteria, { type: CRITERIA[0], value: '' }])}>Add criterion</Button>
            </div>
            <Button type="submit" className="md:col-span-2">Create position</Button>
          </form>
        </Card>
        <div className="space-y-6">
          <Card title="Interview templates">
            <ul className="mb-3 space-y-1 text-sm">{templates.data?.map((t) => <li key={t.id}>{t.name} <Badge>{t.language}</Badge> v{t.version} <span className="text-xs text-slate-500">{(t.questions as any[]).length} questions</span></li>)}</ul>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => defTpl.mutate('en')}>Create default (en)</Button>
              <Button variant="ghost" onClick={() => defTpl.mutate('ar')}>Create default (ar)</Button>
            </div>
          </Card>
          <Card title="Headcount budgets">
            <ul className="mb-3 space-y-1 text-sm">{budgets.data?.map((x) => <li key={x.id}>{nameOf(branches.data, x.branchId)} / {nameOf(positions.data, x.positionId, 'title')}: <b>{x.approved}</b></li>)}</ul>
            <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setBudget.mutate(); }}>
              <Select value={b.branchId} onChange={(e) => setB({ ...b, branchId: e.target.value })} required><option value="">Branch</option>{branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
              <Select value={b.positionId} onChange={(e) => setB({ ...b, positionId: e.target.value })} required><option value="">Position</option>{positions.data?.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select>
              <Input type="number" min="0" placeholder="Approved headcount" value={b.approved} onChange={(e) => setB({ ...b, approved: e.target.value })} required />
              <Button type="submit">Set budget</Button>
            </form>
          </Card>
        </div>
      </div>
      <TemplateEditor templates={templates.data ?? []} onSaved={refresh} />
    </div>
  );
}

type TplForm = { name: string; language: string; scaleMax: string; advance: string; review: string; comps: { key: string; name: string; weight: string; keywords: string }[]; qs: { text: string; textAr: string; competency: string; minWords: string }[] };
const blankTpl = (): TplForm => ({ name: '', language: 'en', scaleMax: '5', advance: '3.5', review: '2.5', comps: [{ key: 'service', name: 'Customer service', weight: '1', keywords: '' }], qs: [{ text: '', textAr: '', competency: 'service', minWords: '15' }] });

function TemplateEditor({ templates, onSaved }: { templates: any[]; onSaved: () => void }) {
  const [f, setF] = useState<TplForm>(blankTpl());
  const fromTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return setF(blankTpl());
    setF({
      name: `${t.name} (copy)`, language: t.language, scaleMax: String(t.rubric.scale.max), advance: String(t.rubric.thresholds.advance), review: String(t.rubric.thresholds.review),
      comps: t.rubric.competencies.map((c: any) => ({ key: c.key, name: c.name, weight: String(c.weight), keywords: (c.keywords ?? []).join(', ') })),
      qs: (t.questions as any[]).map((q) => ({ text: q.text, textAr: q.textAr ?? '', competency: q.competency, minWords: String(q.minWords ?? '') })),
    });
  };
  const save = useMutation({
    mutationFn: () => api('/recruitment/interview-templates', { body: {
      name: f.name, language: f.language,
      questions: f.qs.map((q, i) => ({ id: `q${i + 1}`, text: q.text, ...(q.textAr && { textAr: q.textAr }), competency: q.competency, ...(q.minWords && { minWords: Number(q.minWords) }) })),
      rubric: { scale: { min: 0, max: Number(f.scaleMax) }, thresholds: { advance: Number(f.advance), review: Number(f.review) }, maxFollowUps: 2, competencies: f.comps.map((c) => ({ key: c.key.trim(), name: c.name || c.key, weight: Number(c.weight), keywords: csv(c.keywords) })) },
    } }),
    onSuccess: () => { setF(blankTpl()); onSaved(); },
  });
  const setComp = (i: number, k: string, v: string) => setF({ ...f, comps: f.comps.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  const setQ = (i: number, k: string, v: string) => setF({ ...f, qs: f.qs.map((q, j) => (j === i ? { ...q, [k]: v } : q)) });
  return (
    <Card title="Create an interview template">
      <ErrorBox error={save.error} />
      {save.isSuccess && <p className="mb-2 text-sm text-emerald-700">Template saved. Pick it for a position in the table above.</p>}
      <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Language"><Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">English</option><option value="ar">Arabic</option></Select></Field>
          <Field label="Start from"><Select value="" onChange={(e) => fromTemplate(e.target.value)}><option value="">Blank</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Scale (0 to)"><Input type="number" min="1" value={f.scaleMax} onChange={(e) => setF({ ...f, scaleMax: e.target.value })} required /></Field>
          <Field label="Advance at score"><Input type="number" step="0.1" value={f.advance} onChange={(e) => setF({ ...f, advance: e.target.value })} required /></Field>
          <Field label="Review at score"><Input type="number" step="0.1" value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })} required /></Field>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-600">Competencies (what the answers are scored on)</div>
          {f.comps.map((c, i) => (
            <div key={i} className="mb-2 grid gap-2 md:grid-cols-5">
              <Input placeholder="key, e.g. teamwork" value={c.key} onChange={(e) => setComp(i, 'key', e.target.value)} required />
              <Input placeholder="Name" value={c.name} onChange={(e) => setComp(i, 'name', e.target.value)} />
              <Input type="number" step="0.1" min="0.1" placeholder="Weight" value={c.weight} onChange={(e) => setComp(i, 'weight', e.target.value)} required />
              <Input className="md:col-span-1" placeholder="Keywords, comma separated" value={c.keywords} onChange={(e) => setComp(i, 'keywords', e.target.value)} />
              <Button type="button" variant="ghost" disabled={f.comps.length < 2} onClick={() => setF({ ...f, comps: f.comps.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setF({ ...f, comps: [...f.comps, { key: '', name: '', weight: '1', keywords: '' }] })}>Add competency</Button>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-600">Questions (every candidate gets the same ones)</div>
          {f.qs.map((q, i) => (
            <div key={i} className="mb-2 grid gap-2 md:grid-cols-6">
              <Input className="md:col-span-2" placeholder={`Question ${i + 1}`} value={q.text} onChange={(e) => setQ(i, 'text', e.target.value)} required />
              <Input className="md:col-span-2" placeholder="Arabic text (optional)" value={q.textAr} onChange={(e) => setQ(i, 'textAr', e.target.value)} />
              <Select value={q.competency} onChange={(e) => setQ(i, 'competency', e.target.value)}>{f.comps.filter((c) => c.key.trim()).map((c) => <option key={c.key} value={c.key.trim()}>{c.key}</option>)}</Select>
              <div className="flex gap-1"><Input type="number" min="0" placeholder="Min words" value={q.minWords} onChange={(e) => setQ(i, 'minWords', e.target.value)} /><Button type="button" variant="ghost" disabled={f.qs.length < 2} onClick={() => setF({ ...f, qs: f.qs.filter((_, j) => j !== i) })}>x</Button></div>
            </div>
          ))}
          <Button type="button" variant="ghost" onClick={() => setF({ ...f, qs: [...f.qs, { text: '', textAr: '', competency: f.comps[0]?.key.trim() ?? '', minWords: '15' }] })}>Add question</Button>
        </div>
        <Button type="submit" disabled={save.isPending}>Save template</Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- vacancies

function Vacancies() {
  const qc = useQueryClient();
  const vacancies = useList('/recruitment/vacancies');
  const positions = useList('/recruitment/positions');
  const branches = useList('/org/branches');
  const [v, setV] = useState({ branchId: '', positionId: '', headcount: '1', payMin: '', payMax: '', closesAt: '' });
  const [last, setLast] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const tenant = localStorage.getItem('bh_tenant') ?? '';
  const refresh = () => qc.invalidateQueries({ queryKey: ['list'] });
  const create = useMutation({
    mutationFn: () => api('/recruitment/vacancies', { body: { branchId: v.branchId, positionId: v.positionId, headcount: Number(v.headcount), payMin: v.payMin ? Number(v.payMin) : undefined, payMax: v.payMax ? Number(v.payMax) : undefined, closesAt: v.closesAt || undefined } }),
    onSuccess: (r) => { setLast(r); refresh(); },
  });
  const close = useMutation({ mutationFn: (x: { id: string; to: 'close' | 'cancel' }) => api(`/recruitment/vacancies/${x.id}/${x.to}`, { method: 'POST' }), onSuccess: refresh });
  const open = useMutation({ mutationFn: (id: string) => api(`/recruitment/vacancies/${id}`), onSuccess: setDetail });

  return (
    <div className="space-y-6">
      <ErrorBox error={create.error ?? close.error ?? open.error} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Request a vacancy">
          <form className="space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
            <Select value={v.branchId} onChange={(e) => setV({ ...v, branchId: e.target.value })} required><option value="">Branch</option>{branches.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <Select value={v.positionId} onChange={(e) => setV({ ...v, positionId: e.target.value })} required><option value="">Position</option>{positions.data?.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select>
            <Field label="Headcount"><Input type="number" min="1" value={v.headcount} onChange={(e) => setV({ ...v, headcount: e.target.value })} required /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Pay min (optional)"><Input type="number" step="0.001" value={v.payMin} onChange={(e) => setV({ ...v, payMin: e.target.value })} /></Field>
              <Field label="Pay max (optional)"><Input type="number" step="0.001" value={v.payMax} onChange={(e) => setV({ ...v, payMax: e.target.value })} /></Field>
            </div>
            <Field label="Closing date"><Input type="date" value={v.closesAt} onChange={(e) => setV({ ...v, closesAt: e.target.value })} /></Field>
            <Button type="submit">Request</Button>
          </form>
          {last && (
            <p className="mt-3 rounded bg-slate-50 p-2 text-sm">
              {last.number}: <StatusBadge status={last.status} />
              {last.status === 'PENDING_APPROVAL' && <> {last.overBudget ? 'Over budget: ' : 'Needs approval: '}<Link className="text-brand-600 underline" to="/approvals">open approvals</Link></>}
            </p>
          )}
        </Card>
        <Card title="Vacancies" className="lg:col-span-2">
          {vacancies.data?.length === 0 ? <Empty>No vacancies.</Empty> : (
            <Table head={['No.', 'Branch', 'Position', 'Filled', 'Status', 'Apply link', '']}>
              {vacancies.data?.map((x) => (
                <tr key={x.id}>
                  <td className="px-3 py-2 font-medium"><button className="underline" onClick={() => open.mutate(x.id)}>{x.number}</button></td>
                  <td className="px-3 py-2">{nameOf(branches.data, x.branchId)}</td>
                  <td className="px-3 py-2">{nameOf(positions.data, x.positionId, 'title')}</td>
                  <td className="px-3 py-2">{x.filled}/{x.headcount}</td>
                  <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
                  <td className="px-3 py-2 text-xs">{x.status === 'OPEN' && <code>/{tenant}/vacancies/{x.publicCode}</code>}</td>
                  <td className="px-3 py-2 text-end">
                    {['OPEN', 'PENDING_APPROVAL', 'DRAFT'].includes(x.status) && (
                      <>
                        <Button variant="ghost" onClick={() => close.mutate({ id: x.id, to: 'close' })}>Close</Button>{' '}
                        <Button variant="ghost" onClick={() => close.mutate({ id: x.id, to: 'cancel' })}>Cancel</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          {detail && <p className="mt-3 text-sm">Pipeline for {detail.number}: {Object.entries(detail.pipeline).map(([k, n]) => <Badge key={k}>{k.replace(/_/g, ' ')}: {String(n)}</Badge>)} {Object.keys(detail.pipeline).length === 0 && 'no applications yet'}</p>}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pipeline

function Pipeline() {
  const vacancies = useList('/recruitment/vacancies');
  const branches = useList('/org/branches');
  const [vacancyId, setVacancyId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const q = new URLSearchParams({ ...(vacancyId && { vacancyId }), ...(status && { status }) }).toString();
  const list = useQuery({ queryKey: ['apps', q], queryFn: () => api<any[]>(`/recruitment/applications?${q}`) });
  const needle = search.trim().toLowerCase();
  const rows = list.data?.filter((a) => !needle || [a.candidate, a.phone, a.email, a.position, a.vacancy].some((v) => String(v ?? '').toLowerCase().includes(needle)));
  return (
    <div className="space-y-6">
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <Input placeholder="Search name, phone, email, position" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={vacancyId} onChange={(e) => setVacancyId(e.target.value)}><option value="">All vacancies</option>{vacancies.data?.map((x) => <option key={x.id} value={x.id}>{x.number}</option>)}</Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['INCOMPLETE', 'SCREENED_OUT', 'SCREENED', 'INTERVIEW_INVITED', 'INTERVIEW_SCHEDULED', 'UNDER_REVIEW', 'ADVANCED', 'OFFER_PENDING', 'ONBOARDING', 'HIRED', 'REJECTED', 'WITHDRAWN'].map((s) => <option key={s}>{s}</option>)}
          </Select>
          <div className="self-center text-sm text-slate-500">{rows?.length ?? 0} applicants</div>
        </div>
        <ErrorBox error={list.error} />
        {rows?.length === 0 ? <Empty>No applicants.</Empty> : (
          <Table head={['Applicant', 'Phone', 'Email', 'Position', 'Branch', 'Vacancy', 'Applied', 'Screening', 'Interview', 'AI score', 'Status']}>
            {rows?.map((a) => (
              <tr key={a.id} onClick={() => setSel(a.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === a.id ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2 font-medium">{a.candidate}</td>
                <td className="px-3 py-2 text-xs">{a.phone}</td>
                <td className="px-3 py-2 text-xs">{a.email ?? '-'}</td>
                <td className="px-3 py-2 text-xs">{a.position}</td>
                <td className="px-3 py-2 text-xs">{nameOf(branches.data, a.branchId)}</td>
                <td className="px-3 py-2 text-xs">{a.vacancy}</td>
                <td className="px-3 py-2 text-xs">{formatDate(a.createdAt)}</td>
                <td className="px-3 py-2 text-xs">{a.screening ? `${a.screening} met` : '-'}</td>
                <td className="px-3 py-2">{a.interview ? <StatusBadge status={a.interview} /> : '-'}</td>
                <td className="px-3 py-2 text-xs">{a.score != null ? `${a.score} ${a.recommendation}` : '-'}</td>
                <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {sel ? <ApplicationDetail id={sel} /> : <Card><Empty>Select an applicant to see their file. Opening a candidate file is audited.</Empty></Card>}
    </div>
  );
}

function ApplicationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const app = useQuery({ queryKey: ['app', id], queryFn: () => api<any>(`/recruitment/applications/${id}`) });
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tx, setTx] = useState<any>(null);
  const [offer, setOffer] = useState({ startDate: '', salaryBasic: '', allowName: '', allowAmount: '', contractType: 'OPEN', probationMonths: '3', weeklyHours: '48' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['app', id] }); qc.invalidateQueries({ queryKey: ['apps'] }); };
  const decide = useMutation({ mutationFn: (action: string) => api(`/recruitment/applications/${id}/decision`, { body: { action, reason: reason || undefined, note: note || undefined } }), onSuccess: refresh });
  const transcript = useMutation({ mutationFn: (iid: string) => api(`/recruitment/interviews/${iid}/transcript`), onSuccess: setTx });
  const makeOffer = useMutation({
    mutationFn: () => api(`/applications/${id}/offer`, { body: { startDate: offer.startDate, salaryBasic: Number(offer.salaryBasic), contractType: offer.contractType, probationMonths: Number(offer.probationMonths), weeklyHours: Number(offer.weeklyHours), allowances: offer.allowName ? [{ name: offer.allowName, amount: Number(offer.allowAmount || 0) }] : [] } }),
    onSuccess: refresh,
  });
  const a = app.data;
  if (!a) return <Card><ErrorBox error={app.error} />{app.isLoading && <Empty>Loading...</Empty>}</Card>;
  const ev = a.evaluation;
  const actions: Record<string, string[]> = {
    SCREENED_OUT: ['confirm_screening_reject', 'override_screening'],
    SCREENED: ['invite', 'reject'],
    UNDER_REVIEW: ['advance', 'reject', 'reinvite'],
    ADVANCED: ['reject'],
  };
  const needsReason = (x: string) => ['reject'].includes(x);

  return (
    <div className="space-y-4">
      <ErrorBox error={decide.error ?? transcript.error ?? makeOffer.error} />
      <Card title={`${a.candidate.name}  ·  ${a.vacancy.number}`}>
        <div className="mb-2 flex items-center gap-2"><StatusBadge status={a.status} />{a.decidedBy && <span className="text-xs text-slate-500">decided by {a.decidedBy}</span>}{a.humanInterviewRequested && <Badge tone="MEDIUM">human interview requested</Badge>}</div>
        <p className="text-sm text-slate-600">{a.candidate.phone} {a.candidate.email}</p>
        <p className="text-xs text-slate-400">Data kept until {formatDate(a.candidate.retentionUntil)}</p>
        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded bg-slate-50 p-2 text-xs md:grid-cols-2">{Object.entries(a.intake ?? {}).map(([k, v]) => <div key={k}><dt className="inline font-medium text-slate-600">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}: </dt><dd className="inline">{Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v)}</dd></div>)}</dl>
      </Card>
      <Card title="Screening (objective criteria)">
        {(a.eligibility as any[]).length === 0 ? <Empty>No screening results.</Empty> : (
          <ul className="space-y-1 text-sm">{(a.eligibility as any[]).map((r, i) => <li key={i}><Badge tone={r.pass ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{r.pass ? 'pass' : 'fail'}</Badge> {r.label}: <span className="text-slate-500">{r.detail}</span></li>)}</ul>
        )}
        {(a.missing as string[]).length > 0 && <p className="mt-2 text-sm text-amber-700">Missing: {(a.missing as string[]).join(', ')}</p>}
      </Card>
      {a.interview && (
        <Card title="Interview">
          <p className="text-sm">Status <StatusBadge status={a.interview.status} /> {a.interview.completedAt && formatDate(a.interview.completedAt)}</p>
          {a.interview.status === 'COMPLETED' && (
            <>
              <Button variant="ghost" className="mt-2" onClick={() => transcript.mutate(a.interview.id)}>View transcript</Button>
              <span className="ms-2 text-xs text-slate-500">Viewing a transcript is recorded in the audit trail.</span>
            </>
          )}
          {tx && <div className="mt-2 max-h-60 space-y-1 overflow-auto rounded bg-slate-50 p-2 text-xs">{(tx.transcript as any[]).map((m, i) => <p key={i}><b>{m.role}:</b> {m.text}{m.flags?.length ? <Badge tone="HIGH">{m.flags.join(',')}</Badge> : null}</p>)}</div>}
        </Card>
      )}
      {ev && (
        <Card title="Evaluation">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="bg-indigo-100 text-indigo-800">AI advice, not a decision</Badge>
            <span>Overall <b>{ev.overall}</b></span>
            <Badge tone={ev.recommendation === 'ADVANCE' ? 'bg-emerald-100 text-emerald-800' : ev.recommendation === 'REVIEW' ? 'MEDIUM' : 'HIGH'}>{ev.recommendation}</Badge>
            <span>confidence {Number(ev.confidence).toFixed(2)}</span>
            <span className="text-xs text-slate-500">{ev.engine} @ {ev.engineVersion}, rubric v{ev.rubricVersion}</span>
          </div>
          {(ev.flags as any[]).map((f, i) => <p key={i} className="text-sm text-amber-700"><Badge tone="MEDIUM">{f.code}</Badge> {f.message}</p>)}
          <ul className="mt-2 space-y-2 text-sm">
            {(ev.scores as any[]).map((s) => (
              <li key={s.questionId} className="rounded border border-slate-100 p-2">
                <b>{s.questionId}</b> · {s.competency} · score {s.score}
                <p className="text-slate-600">{s.reasoning}</p>
                {(s.evidence as string[]).map((q, i) => <blockquote key={i} className="border-s-2 border-slate-300 ps-2 text-xs italic text-slate-500">{q}</blockquote>)}
              </li>
            ))}
          </ul>
          {ev.reviewedBy && <p className="mt-2 text-xs text-slate-500">Reviewed: {ev.reviewDecision} {ev.reviewNotes}</p>}
        </Card>
      )}
      {NEXT[a.status] && <p className="rounded border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900"><b>Next step:</b> {NEXT[a.status]}</p>}
      {(actions[a.status] ?? []).length > 0 && (
        <Card title="Decision">
          <div className="mb-2 grid gap-2 md:grid-cols-2">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Reason (required to reject)</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</Select>
            <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {actions[a.status].map((x) => (
              <Button key={x} variant={x === 'reject' || x === 'confirm_screening_reject' ? 'danger' : 'primary'} disabled={(needsReason(x) && !reason) || decide.isPending} onClick={() => decide.mutate(x)}>{x.replace(/_/g, ' ')}</Button>
            ))}
          </div>
        </Card>
      )}
      {a.status === 'ADVANCED' && (
        <Card title="Make an offer">
          <form className="grid gap-2 md:grid-cols-3" onSubmit={(e: FormEvent) => { e.preventDefault(); makeOffer.mutate(); }}>
            <Field label="Start date"><Input type="date" value={offer.startDate} onChange={(e) => setOffer({ ...offer, startDate: e.target.value })} required /></Field>
            <Field label="Basic salary (JOD / month)"><Input type="number" step="0.001" value={offer.salaryBasic} onChange={(e) => setOffer({ ...offer, salaryBasic: e.target.value })} required /></Field>
            <Field label="Contract"><Select value={offer.contractType} onChange={(e) => setOffer({ ...offer, contractType: e.target.value })}><option>OPEN</option><option>FIXED_TERM</option></Select></Field>
            <Field label="Allowance name"><Input value={offer.allowName} onChange={(e) => setOffer({ ...offer, allowName: e.target.value })} /></Field>
            <Field label="Allowance amount"><Input type="number" step="0.001" value={offer.allowAmount} onChange={(e) => setOffer({ ...offer, allowAmount: e.target.value })} /></Field>
            <Field label="Probation (months)"><Input type="number" value={offer.probationMonths} onChange={(e) => setOffer({ ...offer, probationMonths: e.target.value })} /></Field>
            <Field label="Weekly hours"><Input type="number" value={offer.weeklyHours} onChange={(e) => setOffer({ ...offer, weeklyHours: e.target.value })} /></Field>
            <div className="flex items-end"><Button type="submit">Create offer</Button></div>
          </form>
          <p className="mt-2 text-xs text-slate-500">Above the pay band or policy limits, the offer waits for approval (see Approvals).</p>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- appeals

const NEXT: Record<string, string> = {
  INTERVIEW_INVITED: 'Waiting for the candidate to open their interview link and consent. Nothing to do until they take the interview.',
  INTERVIEW_SCHEDULED: 'Waiting for the candidate to take the interview. When they finish, the application moves to review here.',
  INTERVIEWED: 'Assessment in progress; refresh in a moment.',
  OFFER_PENDING: 'An offer exists. Open Onboarding: approve it in Approvals if it needs approval, Send it, then countersign once the candidate accepts and verify their documents.',
  ONBOARDING: 'Open Onboarding, select the offer, verify the candidate documents and complete onboarding to create the employee.',
};

function Appeals() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['appeals'], queryFn: () => api<any[]>('/recruitment/appeals') });
  const [f, setF] = useState<Record<string, { outcome: string; resolution: string }>>({});
  const resolve = useMutation({ mutationFn: (id: string) => api(`/recruitment/appeals/${id}/resolve`, { body: f[id] ?? { outcome: 'UPHELD', resolution: '' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['appeals'] }) });
  return (
    <Card>
      <p className="mb-3 text-sm text-slate-500">A different person must review the appeal: the person who made the original decision cannot resolve it (the server refuses).</p>
      <ErrorBox error={list.error ?? resolve.error} />
      {list.data?.length === 0 ? <Empty>No appeals.</Empty> : (
        <Table head={['Opened', 'Reason', 'Original decider', 'Status', 'Resolve']}>
          {list.data?.map((x) => (
            <tr key={x.id}>
              <td className="px-3 py-2 text-xs">{formatDate(x.openedAt)}</td>
              <td className="max-w-xs px-3 py-2 text-sm">{x.reason}</td>
              <td className="px-3 py-2 text-xs">{x.originalDecidedBy ?? '-'}</td>
              <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
              <td className="px-3 py-2">
                {x.status === 'OPEN' && (
                  <div className="flex gap-2">
                    <Select className="w-32" value={f[x.id]?.outcome ?? 'UPHELD'} onChange={(e) => setF({ ...f, [x.id]: { ...(f[x.id] ?? { resolution: '' }), outcome: e.target.value } })}><option>UPHELD</option><option>OVERTURNED</option></Select>
                    <Input className="w-48" placeholder="Resolution (5+ chars)" value={f[x.id]?.resolution ?? ''} onChange={(e) => setF({ ...f, [x.id]: { ...(f[x.id] ?? { outcome: 'UPHELD' }), resolution: e.target.value } })} />
                    <Button onClick={() => resolve.mutate(x.id)}>Resolve</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
