import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api, upload } from '../lib/api';
import { formatDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { nameOf, useList } from '../lib/lookups';

export default function Audits() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Audits');
  return (
    <div>
      <PageHeader title={t('Audits')} subtitle="Scored inspections with evidence rules. Every failed item becomes a corrective action; a failed critical item fails the audit." />
      <Tabs tabs={['Audits', 'Templates']} value={tab} onChange={setTab} />
      {tab === 'Audits' ? <AuditList /> : <Templates />}
    </div>
  );
}

function AuditList() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const tpls = useQuery({ queryKey: ['atpl'], queryFn: () => api<any[]>('/ops/audit-templates') });
  const list = useQuery({ queryKey: ['audits'], queryFn: () => api<any[]>('/ops/audits') });
  const [f, setF] = useState({ templateId: '', branchId: '' });
  const [sel, setSel] = useState<string | null>(null);
  const start = useMutation({ mutationFn: () => api('/ops/audits', { body: f }), onSuccess: (a: any) => { qc.invalidateQueries({ queryKey: ['audits'] }); setSel(a.id); } });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <ErrorBox error={list.error} />
          {list.data?.length === 0 ? <Empty>No audits yet.</Empty> : (
            <Table head={['Audit', 'Branch', 'Result']}>
              {list.data?.map((a) => (
                <tr key={a.id} onClick={() => setSel(a.id)} className={`cursor-pointer hover:bg-slate-50 ${sel === a.id ? 'bg-brand-50' : ''}`}>
                  <td className="px-3 py-2 font-medium">{nameOf(tpls.data, a.templateId)}<div className="text-xs text-slate-500">{formatDate(a.startedAt)}</div></td>
                  <td className="px-3 py-2">{nameOf(branches.data, a.branchId)}</td>
                  <td className="px-3 py-2">{a.status === 'COMPLETED' ? <span className={a.passed ? 'text-emerald-700' : 'text-red-700'}>{a.scorePct}% {a.passed ? 'passed' : 'failed'}</span> : <StatusBadge status={a.status} />}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Start an audit">
          <ErrorBox error={start.error} />
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <Field label="Branch"><Select required value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Template"><Select required value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">Select...</option>{tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name} v{t.version}</option>)}</Select></Field>
            <Button disabled={start.isPending}>Start</Button>
          </form>
        </Card>
      </div>
      <div className="lg:col-span-3">{sel ? <Detail id={sel} /> : <Card><Empty>Select or start an audit.</Empty></Card>}</div>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audit', id], queryFn: () => api<any>(`/ops/audits/${id}`) });
  const [ans, setAns] = useState<Record<string, { result?: string; note?: string; docId?: string }>>({});
  const [err, setErr] = useState<unknown>(null);
  const set = (k: string, v: object) => setAns((a) => ({ ...a, [k]: { ...a[k], ...v } }));
  const done = useMutation({ mutationFn: () => api(`/ops/audits/${id}/complete`, { body: { answers: items.map((i) => ({ itemId: i.id, result: ans[i.id].result, note: ans[i.id].note || undefined, docId: ans[i.id].docId })) } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['audit', id] }); qc.invalidateQueries({ queryKey: ['audits'] }); qc.invalidateQueries({ queryKey: ['actions'] }); } });
  if (!q.data) return <Card><ErrorBox error={q.error} />{q.isLoading && <Empty>Loading...</Empty>}</Card>;
  const { audit, template, actions } = q.data;
  const items: any[] = template.items;
  const attach = async (itemId: string, file?: File) => { if (!file) return; setErr(null); try { set(itemId, { docId: (await upload('/documents', file)).id }); } catch (e) { setErr(e); } };
  if (audit.status === 'COMPLETED') {
    return (
      <Card title={`${template.name} v${template.version}`}>
        <p className={`text-lg font-semibold ${audit.passed ? 'text-emerald-700' : 'text-red-700'}`}>{audit.scorePct}% · {audit.passed ? 'Passed' : 'Failed'}{audit.criticalFails > 0 && ` · ${audit.criticalFails} critical`}</p>
        <ul className="mt-2 space-y-1 text-sm">
          {items.map((i) => { const r = (audit.results as any[]).find((x) => x.itemId === i.id); const a = actions.find((x: any) => x.id === r?.actionId); return <li key={i.id}>{r?.result === 'PASS' ? '✓' : r?.result === 'FAIL' ? '✗' : '–'} {i.label}{i.critical && <b className="ms-1 text-xs text-red-600">critical</b>}{r?.note && <span className="ms-2 text-slate-500">"{r.note}"</span>}{a && <span className="ms-2 text-xs">→ {a.number} <StatusBadge status={a.status} /></span>}</li>; })}
        </ul>
      </Card>
    );
  }
  // Tell the auditor exactly why Complete is disabled instead of leaving a dead button.
  const missing = items.flatMap((i) => { const a = ans[i.id]; return !a?.result ? [`answer "${i.label}"`] : [...(a.result === 'FAIL' && !a.note?.trim() ? [`say what was wrong on "${i.label}"`] : []), ...(a.result !== 'NA' && i.evidenceRequired && !a.docId ? [`attach evidence for "${i.label}"`] : [])]; });
  const ready = items.every((i) => ans[i.id]?.result && (ans[i.id].result !== 'FAIL' || ans[i.id].note?.trim()) && (ans[i.id].result === 'NA' || !i.evidenceRequired || ans[i.id].docId));
  return (
    <Card title={`${template.name} v${template.version} · pass at ${template.passPercent}%`}>
      <ErrorBox error={q.error ?? err ?? done.error} />
      <div className="space-y-3">
        {items.map((i) => (
          <div key={i.id} className="rounded border border-slate-200 p-2 text-sm">
            <p className="font-medium">{i.label} <span className="text-xs text-slate-500">weight {i.weight}</span>{i.critical && <b className="ms-2 text-xs text-red-600">critical</b>}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {['PASS', 'FAIL', 'NA'].map((r) => <Button key={r} type="button" variant={ans[i.id]?.result === r ? (r === 'FAIL' ? 'danger' : 'primary') : 'ghost'} onClick={() => set(i.id, { result: r })}>{r === 'NA' ? 'N/A' : r.charAt(0) + r.slice(1).toLowerCase()}</Button>)}
              <Input className="w-56" placeholder={ans[i.id]?.result === 'FAIL' ? 'What was wrong (required)' : 'Note (optional)'} value={ans[i.id]?.note ?? ''} onChange={(e) => set(i.id, { note: e.target.value })} />
              {i.evidenceRequired && ans[i.id]?.result !== 'NA' && <label className="text-xs">{ans[i.id]?.docId ? '✓ evidence attached' : 'Evidence required:'} <input type="file" accept="image/*" capture="environment" onChange={(e) => attach(i.id, e.target.files?.[0])} /></label>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3"><Button disabled={!ready || done.isPending} onClick={() => done.mutate()}>Complete audit</Button><span className="ms-2 text-xs text-slate-500">Only you, the auditor who started it, can complete it.</span>{missing.length > 0 && <p className="mt-2 text-xs text-amber-700">Still needed: {missing.slice(0, 4).join('; ')}{missing.length > 4 ? ` and ${missing.length - 4} more` : ''}</p>}</div>
    </Card>
  );
}

function Templates() {
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const list = useQuery({ queryKey: ['atpl'], queryFn: () => api<any[]>('/ops/audit-templates') });
  const [f, setF] = useState({ code: '', name: '', branchId: '', passPercent: '80' });
  const [items, setItems] = useState<{ label: string; weight: number; critical: boolean; evidenceRequired: boolean }[]>([]);
  const [d, setD] = useState({ label: '', weight: '1', critical: false, evidenceRequired: false });
  const save = useMutation({ mutationFn: () => api('/ops/audit-templates', { body: { code: f.code || undefined, name: f.name, branchId: f.branchId || undefined, passPercent: Number(f.passPercent), items } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['atpl'] }); setF({ code: '', name: '', branchId: '', passPercent: '80' }); setItems([]); } });
  const edit = (t: any) => { setF({ code: t.code, name: t.name, branchId: t.branchId ?? '', passPercent: String(t.passPercent) }); setItems((t.items as any[]).map((i) => ({ label: i.label, weight: i.weight, critical: !!i.critical, evidenceRequired: !!i.evidenceRequired }))); };
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <ErrorBox error={list.error} />
        {list.data?.length === 0 ? <Empty>No templates yet.</Empty> : (
          <Table head={['Name', 'Items', 'Pass', '']}>
            {list.data?.map((t) => <tr key={t.id}><td className="px-3 py-2 font-medium">{t.name} v{t.version}<div className="text-xs text-slate-500">{t.branchId ? nameOf(branches.data, t.branchId) : 'All branches'}</div></td><td className="px-3 py-2">{(t.items as any[]).length}</td><td className="px-3 py-2">{t.passPercent}%</td><td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => edit(t)}>Edit</Button></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title={f.code ? 'New version' : 'New audit template'} className="lg:col-span-3">
        <ErrorBox error={save.error} />
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Name"><Input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} disabled={!!f.code}><option value="">All (company-wide role)</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Pass %"><Input type="number" min="1" max="100" value={f.passPercent} onChange={(e) => setF({ ...f, passPercent: e.target.value })} /></Field>
          </div>
          {items.map((i, n) => <p key={n} className="text-sm">{n + 1}. {i.label} <span className="text-xs text-slate-500">w{i.weight}</span>{i.critical && <b className="ms-1 text-xs text-red-600">critical</b>}{i.evidenceRequired && <span className="ms-1 text-xs text-slate-500">evidence</span>} <button type="button" className="text-red-600" onClick={() => setItems(items.filter((_, j) => j !== n))}>remove</button></p>)}
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
            <Field label="Item"><Input value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></Field>
            <Field label="Weight"><Input className="w-20" type="number" min="0.1" step="0.1" value={d.weight} onChange={(e) => setD({ ...d, weight: e.target.value })} /></Field>
            <label className="text-sm"><input type="checkbox" checked={d.critical} onChange={(e) => setD({ ...d, critical: e.target.checked })} /> critical</label>
            <label className="text-sm"><input type="checkbox" checked={d.evidenceRequired} onChange={(e) => setD({ ...d, evidenceRequired: e.target.checked })} /> evidence</label>
            <Button type="button" variant="ghost" disabled={d.label.length < 2} onClick={() => { setItems([...items, { ...d, weight: Number(d.weight) }]); setD({ label: '', weight: '1', critical: false, evidenceRequired: false }); }}>Add item</Button>
          </div>
          <div className="flex gap-2"><Button disabled={save.isPending || !items.length}>Save{f.code ? ' as next version' : ''}</Button>{f.code && <Button type="button" variant="ghost" onClick={() => { setF({ code: '', name: '', branchId: '', passPercent: '80' }); setItems([]); }}>New instead</Button>}</div>
        </form>
      </Card>
    </div>
  );
}
