import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useList } from '../lib/lookups';

const STEPS = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'FINALIZED', 'PAID'];

export default function PayrollRun() {
  const { id = '' } = useParams();
  const { lang } = useI18n();
  const qc = useQueryClient();
  const emps = useList('/employees');
  const run = useQuery({ queryKey: ['payroll-run', id], queryFn: () => api<any>(`/payroll/runs/${id}`) });
  const [comment, setComment] = useState('');
  const [pay, setPay] = useState({ reference: '', method: 'BANK' });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['payroll-run', id] }); qc.invalidateQueries({ queryKey: ['payroll-runs'] }); };
  const post = (path: string, body?: unknown) => api(`/payroll/${path}`, { method: 'POST', body });
  const act = useMutation({ mutationFn: (x: { path: string; body?: unknown }) => post(x.path, x.body), onSuccess: refresh });
  const bank = useMutation({
    mutationFn: async () => {
      const r = await post(`runs/${id}/bank-file`) as { csv: string; skipped: string[] };
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `bank-file-${run.data?.number ?? id}.csv`; a.click();
      URL.revokeObjectURL(url);
      return r;
    },
  });
  const r = run.data;
  if (!r) return <div><ErrorBox error={run.error} />{run.isLoading && <Empty>Loading...</Empty>}</div>;
  const step = STEPS.indexOf(r.status === 'APPROVED' ? 'IN_REVIEW' : r.status);
  const openEx = r.exceptions.filter((e: any) => e.status === 'OPEN');
  const hardOpen = openEx.filter((e: any) => e.severity === 'HARD').length;
  const name = (eid: string) => emps.data?.find((e) => e.id === eid)?.name ?? eid.slice(0, 8);
  const money = (v: unknown) => formatJOD(v as string, lang);
  const totals = r.totals ?? {};
  const s = r.status;
  return (
    <div className="space-y-4">
      <PageHeader title={`Payroll ${r.number}`} subtitle={`${formatDate(r.periodStart).split(',')[0]} - ${formatDate(r.periodEnd).split(',')[0]} · rules v${r.ruleVersion}`} actions={<Link className="text-sm text-brand-600 underline" to="/payroll">All runs</Link>} />
      {!r.rulesVerified && (
        <div role="alert" className="rounded-lg border-2 border-red-300 bg-red-50 p-4 text-sm font-medium text-red-800">
          The payroll rules used by this run are unverified placeholders (statutory rates have not been confirmed). Finalization is blocked until a finance user verifies the rule set on the Rules tab.
        </div>
      )}
      <ErrorBox error={run.error ?? act.error ?? bank.error} />
      <Card>
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {STEPS.map((x, i) => (
            <li key={x} className={`rounded-full px-3 py-1 ${i < step ? 'bg-emerald-100 text-emerald-800' : i === step ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{i + 1}. {x.replace('_', ' ')}</li>
          ))}
          {['APPROVED', 'CANCELLED'].includes(s) && <StatusBadge status={s} />}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {['DRAFT', 'CALCULATED'].includes(s) && <Button disabled={act.isPending} onClick={() => act.mutate({ path: `runs/${id}/calculate` })}>{s === 'DRAFT' ? 'Calculate' : 'Recalculate'}</Button>}
          {s === 'CALCULATED' && <Button disabled={act.isPending || hardOpen > 0} title={hardOpen ? 'Resolve hard exceptions first' : ''} onClick={() => act.mutate({ path: `runs/${id}/submit-review` })}>Submit for review</Button>}
          {['DRAFT', 'CALCULATED'].includes(s) && <Button variant="danger" onClick={() => confirm('Cancel this run?') && act.mutate({ path: `runs/${id}/cancel` })}>Cancel run</Button>}
          {s === 'IN_REVIEW' && (
            <>
              <Input className="w-56" placeholder="Review comment" value={comment} onChange={(e) => setComment(e.target.value)} />
              <Button variant="danger" onClick={() => act.mutate({ path: `runs/${id}/review`, body: { approve: false, comment: comment || undefined } })}>Reject</Button>
              <Button onClick={() => act.mutate({ path: `runs/${id}/review`, body: { approve: true, comment: comment || undefined } })}>Approve</Button>
            </>
          )}
          {['FINALIZED', 'PAID'].includes(s) && <Button variant="ghost" disabled={bank.isPending} onClick={() => bank.mutate()}>Download bank file</Button>}
          {['FINALIZED', 'PAID'].includes(s) && <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ path: `runs/${id}/payslips` })}>Regenerate payslips</Button>}
          {s === 'FINALIZED' && <Button variant="ghost" onClick={() => act.mutate({ path: `runs/${id}/request-payment` })}>Request payment</Button>}
        </div>
        {bank.data && bank.data.skipped.length > 0 && <p className="mt-2 text-sm text-amber-700">Skipped (no IBAN or zero net): {bank.data.skipped.join(', ')}</p>}
        {act.isSuccess && (act.data as any)?.generated !== undefined && <p className="mt-2 text-sm text-emerald-700">{(act.data as any).generated} payslips generated.</p>}
        {s === 'FINALIZED' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <Input className="w-56" placeholder="Payment reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <Select className="w-28" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option>BANK</option><option>CASH</option></Select>
            <Button disabled={pay.reference.length < 2} onClick={() => act.mutate({ path: `runs/${id}/confirm-payment`, body: pay })}>Confirm payment</Button>
          </div>
        )}
        {r.paymentRef && <p className="mt-2 text-sm text-slate-600">Paid {formatDate(r.paidAt)} · ref {r.paymentRef}</p>}
        {r.workflowState && <p className="mt-1 text-xs text-slate-500">Workflow: {r.workflowState}</p>}
      </Card>
      <Card title="Totals">
        {Object.keys(totals).length === 0 ? <Empty>Not calculated yet.</Empty> : (
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            {Object.entries(totals).map(([k, v]) => (
              <div key={k}><dt className="text-xs uppercase text-slate-500">{k.replace(/([A-Z])/g, ' $1')}</dt><dd className="font-medium">{['employees', 'hardExceptions', 'softExceptions'].includes(k) ? String(v) : money(v)}</dd></div>
            ))}
          </dl>
        )}
      </Card>
      <Card title={`Exceptions (${openEx.length} open)`}>
        {r.exceptions.length === 0 ? <Empty>No exceptions.</Empty> : (
          <Table head={['Severity', 'Code', 'Employee', 'Message', 'Status', 'Note / action']}>
            {r.exceptions.map((e: any) => (
              <tr key={e.id}>
                <td className="px-3 py-2"><Badge tone={e.severity === 'HARD' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}>{e.severity}</Badge></td>
                <td className="px-3 py-2 text-xs">{e.code}</td>
                <td className="px-3 py-2">{e.employeeId ? name(e.employeeId) : '-'}</td>
                <td className="px-3 py-2">{e.message}</td>
                <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                <td className="px-3 py-2">
                  {e.status === 'OPEN' ? (
                    <div className="flex gap-1">
                      <Input className="w-40" placeholder="Note (required)" value={notes[e.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [e.id]: ev.target.value })} />
                      <Button variant="ghost" disabled={(notes[e.id] ?? '').length < 3} onClick={() => act.mutate({ path: `exceptions/${e.id}/resolve`, body: { action: 'ACKNOWLEDGE', note: notes[e.id] } })}>Acknowledge</Button>
                      <Button variant="ghost" disabled={(notes[e.id] ?? '').length < 3} onClick={() => act.mutate({ path: `exceptions/${e.id}/resolve`, body: { action: 'RESOLVE', note: notes[e.id] } })}>Resolve</Button>
                    </div>
                  ) : <span className="text-xs text-slate-500">{e.note}</span>}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-slate-500">Some hard exceptions cannot be acknowledged; fix them at the source and recalculate.</p>
      </Card>
      <Card title="Employee lines">
        {r.lines.length === 0 ? <Empty>No lines yet. Calculate the run.</Empty> : (
          <Table head={['Employee', 'Basic', 'Allow.', 'OT', 'Gross', 'SSC', 'Tax', 'Advances', 'Net', '']}>
            {r.lines.map((l: any) => (
              <Fragment key={l.id}>
                <tr>
                  <td className="px-3 py-2 font-medium">{name(l.employeeId)}</td>
                  <td className="px-3 py-2">{money(l.basic)}</td><td className="px-3 py-2">{money(l.allowances)}</td><td className="px-3 py-2">{money(l.overtimePay)}</td>
                  <td className="px-3 py-2">{money(l.gross)}</td><td className="px-3 py-2">{money(l.sscEmployee)}</td><td className="px-3 py-2">{money(l.incomeTax)}</td><td className="px-3 py-2">{money(l.advances)}</td>
                  <td className="px-3 py-2 font-medium">{money(l.net)}</td>
                  <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide' : 'Trace'}</Button></td>
                </tr>
                {open === l.id && <tr><td colSpan={10} className="bg-slate-50 px-3 py-2"><pre className="overflow-x-auto text-xs" dir="ltr">{JSON.stringify(l.trace, null, 2)}</pre></td></tr>}
              </Fragment>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
