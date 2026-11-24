import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { AttachPicker, Attachment } from '../components/Attachments';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Training() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Library');
  return (
    <div>
      <PageHeader title={t('Training & SOPs')} subtitle="Version-controlled procedures and training. Every assigned training ends in an exam made from manager-approved questions." />
      <Tabs tabs={['Library', 'Assignments', 'Auto rules', 'Evaluations']} value={tab} onChange={setTab} />
      {tab === 'Library' ? <Library /> : tab === 'Assignments' ? <Assignments /> : tab === 'Auto rules' ? <Rules /> : <Evaluations />}
    </div>
  );
}

function Library() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['lib'], queryFn: () => api<any[]>('/ops/library') });
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ code: '', kind: 'TRAINING', title: '', body: '', passScore: '80', maxAttempts: '3', questionsPerAttempt: '5' });
  const [files, setFiles] = useState<Attachment[]>([]);
  const save = useMutation({ mutationFn: () => api('/ops/library', { body: { code: f.code || undefined, kind: f.kind, title: f.title, body: f.body, attachmentIds: files.map((a) => a.id), passScore: Number(f.passScore), maxAttempts: Number(f.maxAttempts), questionsPerAttempt: Number(f.questionsPerAttempt) } }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['lib'] }); setSel(r.code); setF({ ...f, code: '', title: '', body: '' }); setFiles([]); } });
  const edit = (i: any) => { setFiles(i.attachments ?? []); setF({ code: i.code, kind: i.kind, title: i.title, body: i.body, passScore: String(i.passScore), maxAttempts: String(i.maxAttempts), questionsPerAttempt: String(i.questionsPerAttempt) }); };
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <ErrorBox error={list.error} />
          {list.data?.length === 0 ? <Empty>No items yet.</Empty> : (
            <Table head={['Title', 'Kind', 'Ver', '']}>
              {list.data?.map((i) => (
                <tr key={i.id} onClick={() => setSel(i.code)} className={`cursor-pointer hover:bg-slate-50 ${sel === i.code ? 'bg-brand-50' : ''}`}>
                  <td className="px-3 py-2 font-medium">{i.title}</td><td className="px-3 py-2 text-xs">{i.kind}</td><td className="px-3 py-2">v{i.version}</td>
                  <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={(e) => { e.stopPropagation(); edit(i); }}>Edit</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title={f.code ? 'New version' : 'New item'}>
          <ErrorBox error={save.error} />
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Title"><Input required minLength={2} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
              <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option>TRAINING</option><option>SOP</option></Select></Field>
            </div>
            <Field label="Text (optional when you upload files)"><textarea className="w-full rounded border border-slate-300 p-2 text-sm" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
            <Field label="Files for employees to study"><AttachPicker value={files} onChange={setFiles} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Pass %"><Input type="number" min="1" max="100" value={f.passScore} onChange={(e) => setF({ ...f, passScore: e.target.value })} /></Field>
              <Field label="Attempts"><Input type="number" min="1" max="10" value={f.maxAttempts} onChange={(e) => setF({ ...f, maxAttempts: e.target.value })} /></Field>
              <Field label="Questions / exam"><Input type="number" min="1" max="50" value={f.questionsPerAttempt} onChange={(e) => setF({ ...f, questionsPerAttempt: e.target.value })} /></Field>
            </div>
            <div className="flex gap-2"><Button disabled={save.isPending}>Save{f.code ? ' as next version' : ''}</Button>{f.code && <Button type="button" variant="ghost" onClick={() => { setF({ ...f, code: '', title: '', body: '' }); setFiles([]); }}>New instead</Button>}</div>
            <p className="text-xs text-slate-500">Library changes need a company-wide role. A new version keeps the question bank; people who passed an older version stay passed.</p>
          </form>
        </Card>
      </div>
      <div className="lg:col-span-3">{sel ? <Questions code={sel} need={list.data?.find((i) => i.code === sel)?.questionsPerAttempt} /> : <Card><Empty>Select an item to manage its exam questions.</Empty></Card>}</div>
    </div>
  );
}

function Questions({ code, need }: { code: string; need?: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['bank', code], queryFn: () => api<any[]>(`/ops/library/${code}/questions`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bank', code] });
  const gen = useMutation({ mutationFn: () => api(`/ops/library/${code}/generate-questions`, { body: { count: 5 } }), onSuccess: refresh });
  const decide = useMutation({ mutationFn: (x: { id: string; approve: boolean }) => api(`/ops/questions/${x.id}/decide`, { body: { approve: x.approve } }), onSuccess: refresh });
  const [m, setM] = useState({ text: '', options: ['', '', '', ''], correct: 0 });
  const add = useMutation({ mutationFn: () => api(`/ops/library/${code}/questions`, { body: { text: m.text, options: m.options.filter(Boolean), correctIndex: m.options.filter(Boolean).indexOf(m.options[m.correct]) } }), onSuccess: () => { refresh(); setM({ text: '', options: ['', '', '', ''], correct: 0 }); } });
  const approved = q.data?.filter((x) => x.status === 'APPROVED').length ?? 0;
  return (
    <div className="space-y-4">
      <Card title={`Exam questions · ${approved} approved${need ? ` (need ${need})` : ''}`}>
        <ErrorBox error={q.error ?? gen.error ?? decide.error} />
        <Button variant="ghost" disabled={gen.isPending} onClick={() => gen.mutate()}>Generate 5 draft questions</Button>
        <span className="ms-2 text-xs text-slate-500">Generated questions stay drafts until you approve each one.</span>
        {q.data?.length === 0 ? <Empty>No questions.</Empty> : q.data?.map((x) => (
          <div key={x.id} className="border-t border-slate-100 py-2 text-sm">
            <div className="flex items-center justify-between gap-2"><span dir="auto" className="font-medium">{x.text}</span><span className="flex items-center gap-1"><StatusBadge status={x.status} />
              {x.status !== 'APPROVED' && <Button variant="ghost" onClick={() => decide.mutate({ id: x.id, approve: true })}>Approve</Button>}
              {x.status === 'DRAFT' && <Button variant="ghost" onClick={() => decide.mutate({ id: x.id, approve: false })}>Reject</Button>}</span></div>
            <ul className="mt-1 text-xs text-slate-600">{(x.options as string[]).map((o, i) => <li dir="auto" key={i}>{i === x.correctIndex ? '✓' : '·'} {o}</li>)}</ul>
            <span className="text-xs text-slate-400">{x.source}</span>
          </div>
        ))}
      </Card>
      <Card title="Write a question">
        <ErrorBox error={add.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Question"><Input dir="auto" required minLength={5} value={m.text} onChange={(e) => setM({ ...m, text: e.target.value })} /></Field>
          {m.options.map((o, i) => <div key={i} className="flex items-center gap-2"><input type="radio" name="correct" checked={m.correct === i} onChange={() => setM({ ...m, correct: i })} title="correct answer" /><Input placeholder={`Option ${i + 1}`} value={o} onChange={(e) => setM({ ...m, options: m.options.map((x, j) => (j === i ? e.target.value : x)) })} /></div>)}
          <Button disabled={add.isPending || !m.options[m.correct]}>Add (approved)</Button>
        </form>
      </Card>
    </div>
  );
}

function Assignments() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const lib = useQuery({ queryKey: ['lib'], queryFn: () => api<any[]>('/ops/library') });
  const list = useQuery({ queryKey: ['tr-over'], queryFn: () => api<any[]>('/ops/training') });
  const [f, setF] = useState({ employeeId: '', itemId: '', dueDate: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tr-over'] });
  const add = useMutation({ mutationFn: () => api('/ops/training', { body: { ...f, dueDate: f.dueDate || undefined } }), onSuccess: refresh });
  const reset = useMutation({ mutationFn: (id: string) => api(`/ops/training/${id}/reset`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? reset.error} />
        {list.data?.length === 0 ? <Empty>No library assignments.</Empty> : (
          <Table head={['Employee', 'Training', 'Due', 'Status', 'Best', '']}>
            {list.data?.map((a) => (
              <tr key={a.id}><td className="px-3 py-2">{nameOf(emps.data, a.employeeId)}</td><td className="px-3 py-2 font-medium">{a.title}{a.source === 'AUTO' && <span className="ms-1 text-xs text-slate-400">auto</span>}</td><td className="px-3 py-2 text-xs">{a.dueDate?.slice(0, 10) ?? '-'}</td><td className="px-3 py-2"><StatusBadge status={a.status} /></td><td className="px-3 py-2">{a.bestScore != null ? `${a.bestScore}%` : '-'}</td>
                <td className="px-3 py-2 text-end">{a.status === 'FAILED' && <Button variant="ghost" onClick={() => reset.mutate(a.id)}>Give new attempts</Button>}</td></tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Assign training" className="lg:col-span-2">
        <ErrorBox error={add.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Employee"><Select required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Select...</option>{emps.data?.filter((e) => e.status === 'ACTIVE').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <Field label="Training"><Select required value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">Select...</option>{lib.data?.map((i) => <option key={i.id} value={i.id}>{i.title} v{i.version}</option>)}</Select></Field>
          <Field label="Due date"><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
          <Button disabled={add.isPending}>Assign</Button>
          <p className="text-xs text-slate-500">Refused until the item has enough approved exam questions.</p>
        </form>
      </Card>
    </div>
  );
}

function Rules() {
  const qc = useQueryClient();
  const positions = useList('/recruitment/positions');
  const lib = useQuery({ queryKey: ['lib'], queryFn: () => api<any[]>('/ops/library') });
  const list = useQuery({ queryKey: ['tr-rules'], queryFn: () => api<any[]>('/ops/training-rules') });
  const [f, setF] = useState({ positionId: '', itemCode: '', dueDays: '30' });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['tr-rules'] }); qc.invalidateQueries({ queryKey: ['tr-over'] }); };
  const save = useMutation({ mutationFn: () => api('/ops/training-rules', { body: { ...f, dueDays: Number(f.dueDays) } }), onSuccess: refresh });
  const stop = useMutation({ mutationFn: (id: string) => api(`/ops/training-rules/${id}/stop`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <ErrorBox error={list.error ?? stop.error} />
        {list.data?.length === 0 ? <Empty>No automatic rules.</Empty> : (
          <Table head={['Position', 'Training', 'Due in', '']}>
            {list.data?.map((r) => <tr key={r.id}><td className="px-3 py-2">{nameOf(positions.data, r.positionId, 'title')}</td><td className="px-3 py-2 font-medium">{lib.data?.find((i) => i.code === r.itemCode)?.title ?? r.itemCode}</td><td className="px-3 py-2">{r.dueDays} days</td><td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => stop.mutate(r.id)}>Stop</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Assign by position" className="lg:col-span-2">
        <ErrorBox error={save.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Position"><Select required value={f.positionId} onChange={(e) => setF({ ...f, positionId: e.target.value })}><option value="">Select...</option>{positions.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select></Field>
          <Field label="Training"><Select required value={f.itemCode} onChange={(e) => setF({ ...f, itemCode: e.target.value })}><option value="">Select...</option>{lib.data?.map((i) => <option key={i.id} value={i.code}>{i.title}</option>)}</Select></Field>
          <Field label="Due after (days)"><Input type="number" min="1" max="365" value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} /></Field>
          <Button disabled={save.isPending}>Add rule</Button>
          {save.data && <p className="text-xs text-emerald-700">{(save.data as any).assigned} assigned now{(save.data as any).skipped?.length ? `; skipped: ${(save.data as any).skipped.join('; ')}` : ''}. New hires are picked up within 30 minutes.</p>}
        </form>
      </Card>
    </div>
  );
}

function Evaluations() {
  const qc = useQueryClient();
  const emps = useList('/employees');
  const [employeeId, setEmployeeId] = useState('');
  const list = useQuery({ queryKey: ['evals', employeeId], queryFn: () => api<any[]>(`/ops/evaluations?employeeId=${employeeId}`), enabled: !!employeeId });
  const [f, setF] = useState({ topic: '', rating: '3', notes: '' });
  const add = useMutation({ mutationFn: () => api('/ops/evaluations', { body: { employeeId, topic: f.topic, rating: Number(f.rating), notes: f.notes || undefined } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['evals'] }); setF({ topic: '', rating: '3', notes: '' }); } });
  return (
    <div className="space-y-4">
      <Card>
        <Field label="Employee"><Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Select...</option>{emps.data?.filter((e) => e.status === 'ACTIVE').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
      </Card>
      {employeeId && (
        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <ErrorBox error={list.error} />
            {list.data?.length === 0 ? <Empty>No evaluations.</Empty> : (
              <Table head={['Date', 'Topic', 'Rating', 'Notes']}>{list.data?.map((v) => <tr key={v.id}><td className="px-3 py-2 text-xs">{formatDate(v.createdAt)}</td><td className="px-3 py-2 font-medium">{v.topic}</td><td className="px-3 py-2">{'★'.repeat(v.rating)}{'☆'.repeat(5 - v.rating)}</td><td className="px-3 py-2 text-slate-600">{v.notes ?? '-'}</td></tr>)}</Table>
            )}
          </Card>
          <Card title="Practical assessment" className="lg:col-span-2">
            <ErrorBox error={add.error} />
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <Field label="Skill / topic"><Input required minLength={2} value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /></Field>
              <Field label="Rating (1-5)"><Select value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</Select></Field>
              <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
              <Button disabled={add.isPending}>Record</Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
