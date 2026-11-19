import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Table, Tabs } from '../components/ui';
import { api, download } from '../lib/api';
import { addDays, formatDate, ymd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useList } from '../lib/lookups';

export default function OpsDashboard() {
  const { t } = useI18n();
  const [tab, setTab] = useState('Dashboard');
  return (
    <div>
      <PageHeader title={t('Operations')} subtitle="Branch compliance at a glance: checklists, training, audits, food safety and corrective actions." />
      <Tabs tabs={['Dashboard', 'Reports']} value={tab} onChange={setTab} />
      {tab === 'Dashboard' ? <Dashboard /> : <Reports />}
    </div>
  );
}

const Stat = ({ label, value, bad, to }: { label: string; value: string | number; bad?: boolean; to?: string }) => {
  const inner = <div className="rounded border border-slate-200 p-3"><div className={`text-2xl font-semibold ${bad ? 'text-red-700' : ''}`}>{value}</div><div className="text-xs text-slate-500">{label}</div></div>;
  return to ? <Link to={to}>{inner}</Link> : inner;
};

function Dashboard() {
  const q = useQuery({ queryKey: ['ops-dash'], queryFn: () => api<any>('/ops/dashboard'), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <div className="space-y-4">
      <ErrorBox error={q.error} />
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Stat label="Overdue checklists" value={d.totals.overdueChecklists} bad={d.totals.overdueChecklists > 0} to="/checklists" />
            <Stat label="Critical failures (7d)" value={d.totals.criticalFailures} bad={d.totals.criticalFailures > 0} to="/checklists" />
            <Stat label="Open actions" value={d.totals.openActions} to="/actions" />
            <Stat label="Overdue actions" value={d.totals.overdueActions} bad={d.totals.overdueActions > 0} to="/actions" />
            <Stat label="Awaiting verification" value={d.totals.pendingVerification} to="/actions" />
            <Stat label="Out-of-range readings (7d)" value={d.totals.breaches7d} bad={d.totals.breaches7d > 0} to="/food-safety" />
            <Stat label="Failed audits (30d)" value={d.totals.failedAudits30d} bad={d.totals.failedAudits30d > 0} to="/audits" />
            <Stat label="Overdue training" value={d.totals.overdueTraining} bad={d.totals.overdueTraining > 0} to="/training" />
          </div>
          <Card title="By branch">
            {d.branches.length === 0 ? <Empty>No branches in your scope.</Empty> : (
              <Table head={['Branch', 'Checklist compliance', 'Overdue', 'Open actions', 'Food safety (7d)', 'Last audit', 'Training overdue / failed']}>
                {d.branches.map((b: any) => (
                  <tr key={b.branchId}>
                    <td className="px-3 py-2 font-medium">{b.name}</td>
                    <td className="px-3 py-2">{b.checklists.compliancePct == null ? '-' : `${b.checklists.compliancePct}%`}<span className="ms-1 text-xs text-slate-500">of {b.checklists.total}</span></td>
                    <td className={`px-3 py-2 ${b.checklists.overdue ? 'font-semibold text-red-700' : ''}`}>{b.checklists.overdue}</td>
                    <td className="px-3 py-2">{b.actions.open}{b.actions.overdue > 0 && <span className="ms-1 text-xs font-semibold text-red-700">{b.actions.overdue} overdue</span>}{b.actions.pendingVerification > 0 && <span className="ms-1 text-xs text-slate-500">{b.actions.pendingVerification} to verify</span>}</td>
                    <td className={`px-3 py-2 ${b.foodSafety.breaches7d ? 'font-semibold text-red-700' : ''}`}>{b.foodSafety.breaches7d} breach(es)</td>
                    <td className="px-3 py-2">{b.audits.last ? <span className={b.audits.last.passed ? 'text-emerald-700' : 'text-red-700'}>{b.audits.last.scorePct}% <span className="text-xs text-slate-500">{formatDate(b.audits.last.at).split(',')[0]}</span></span> : <span className="text-xs text-slate-400">none in 30d</span>}</td>
                    <td className="px-3 py-2">{b.training.overdue} / {b.training.failed}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <p className="text-xs text-slate-500">Updated {formatDate(d.generatedAt)}. Checklist compliance counts runs done on time with no critical failure. Due dates for generated corrective actions are set in Policies (ops.settings).</p>
        </>
      )}
    </div>
  );
}

const KINDS: [string, string][] = [['checklists', 'Checklist compliance'], ['audits', 'Audits'], ['training', 'Training and exams'], ['food-safety', 'Food safety readings'], ['actions', 'Corrective actions']];

function Reports() {
  const branches = useList('/org/branches');
  const [f, setF] = useState({ kind: 'checklists', branchId: '', from: addDays(ymd(new Date()), -30), to: ymd(new Date()) });
  const qs = `from=${f.from}&to=${f.to}${f.branchId ? `&branchId=${f.branchId}` : ''}`;
  const q = useQuery({ queryKey: ['ops-report', f], queryFn: () => api<any[]>(`/ops/reports/${f.kind}?${qs}`) });
  const [err, setErr] = useState<unknown>(null);
  const cols = q.data?.[0] ? Object.keys(q.data[0]) : [];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All my branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Button variant="ghost" onClick={() => { setErr(null); download(`/ops/reports/${f.kind}?${qs}&format=csv`, `${f.kind}-report.csv`).catch(setErr); }}>Download CSV</Button>
        </div>
      </Card>
      <ErrorBox error={q.error ?? err} />
      <Card title={`${q.data?.length ?? 0} row(s)${(q.data?.length ?? 0) > 100 ? ', showing the first 100 (the CSV has all)' : ''}`}>
        {!q.data?.length ? <Empty>No data for this period.</Empty> : (
          <div className="overflow-x-auto"><Table head={cols}>{q.data.slice(0, 100).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="px-3 py-1.5 text-xs">{r[c] == null ? '' : String(r[c])}</td>)}</tr>)}</Table></div>
        )}
      </Card>
    </div>
  );
}
