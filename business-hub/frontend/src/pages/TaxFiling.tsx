import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api, download } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useList } from '../lib/lookups';
import { useI18n } from '../lib/i18n';

const TABS = ['Periods', 'Returns', 'E-invoicing'];
const STEPS = ['DRAFT', 'IN_REVIEW', 'AWAITING_AUTHORIZATION', 'APPROVED', 'FILED', 'PAID', 'ARCHIVED'];

export default function TaxFiling() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [tab, setTab] = useState(TABS[0]);
  const [periodId, setPeriodId] = useState('');
  const [returnId, setReturnId] = useState('');
  const money = (v: string | number) => formatJOD(v, lang);
  const refresh = () => qc.invalidateQueries();

  const entities = useList('/org/legal-entities');
  const periods = useQuery({ queryKey: ['tax-periods'], queryFn: () => api<any[]>('/tax/periods') });
  const returns = useQuery({ queryKey: ['tax-returns', periodId], queryFn: () => api<any[]>(`/tax/returns${periodId ? `?periodId=${periodId}` : ''}`), enabled: tab === 'Returns' });
  const detail = useQuery({ queryKey: ['tax-return', returnId], queryFn: () => api<any>(`/tax/returns/${returnId}`), enabled: !!returnId && tab === 'Returns' });
  const evidence = useQuery({ queryKey: ['tax-evidence', returnId], queryFn: () => api<any[]>(`/tax/returns/${returnId}/evidence`), enabled: !!returnId && tab === 'Returns' });
  const einv = useQuery({ queryKey: ['einvoice-settings'], queryFn: () => api<{ enabled: boolean }>('/tax/settings/einvoicing'), enabled: tab === 'E-invoicing' });
  const [invStatus, setInvStatus] = useState('');
  const invoices = useQuery({ queryKey: ['einvoices', invStatus], queryFn: () => api<any[]>(`/tax/einvoices${invStatus ? `?status=${invStatus}` : ''}`), enabled: tab === 'E-invoicing' });

  const [np, setNp] = useState({ legalEntityId: '', startDate: '', endDate: '', dueDate: '' });
  const createPeriod = useMutation({ mutationFn: () => api('/tax/periods', { body: { ...np, dueDate: np.dueDate || undefined } }), onSuccess: refresh });
  const generate = useMutation({ mutationFn: (id: string) => api<any>(`/tax/periods/${id}/generate`, { method: 'POST' }), onSuccess: (r) => { setPeriodId(r.periodId); setReturnId(r.id); setTab('Returns'); refresh(); } });
  const act = useMutation({ mutationFn: (v: { path: string; body?: unknown }) => api<any>(`/tax/returns/${returnId}/${v.path}`, { method: 'POST', body: v.body }), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api('/tax/settings/einvoicing', { method: 'PUT', body: { enabled } }), onSuccess: refresh });
  const resubmit = useMutation({ mutationFn: (id: string) => api(`/tax/einvoices/${id}/resubmit`, { method: 'POST' }), onSuccess: refresh });
  const saveCsv = useMutation({ mutationFn: () => download(`/tax/returns/${returnId}/working-papers.csv`, `working-papers-${returnId.slice(0, 8)}.csv`) });
  const saveDoc = useMutation({ mutationFn: (d: any) => download(`/documents/${d.id}/download`, d.filename) });

  const [ack, setAck] = useState({ code: '', reason: '' });
  const [comment, setComment] = useState('');
  const [filing, setFiling] = useState({ acknowledgmentRef: '', filedAt: '' });
  const [pay, setPay] = useState({ reference: '', method: 'BANK', paidAt: '' });
  const [pkg, setPkg] = useState<any>(null);

  const err = periods.error ?? returns.error ?? detail.error ?? createPeriod.error ?? generate.error ?? act.error ?? toggle.error ?? resubmit.error ?? saveCsv.error ?? saveDoc.error ?? einv.error ?? invoices.error;
  const r = detail.data;
  const credit = r && Number(r.netPayable) < 0;
  const submit = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };
  const status: string | undefined = r?.status;

  return (
    <div>
      <PageHeader title="Tax filing" subtitle="Drafts are built from source documents. Review, owner authorization, filing and payment are each explicit and evidenced." />
      <ErrorBox error={err} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'Periods' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2" title="Tax periods">
            {periods.data?.length === 0 ? <Empty>No tax periods yet.</Empty> : (
              <Table head={['Period', 'Due', 'Returns', '']}>
                {periods.data?.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-medium">{p.label}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatDate(p.dueDate)}</td>
                    <td className="px-3 py-2">{p.returns.map((x: any) => <span key={x.id} className="me-1"><StatusBadge status={x.status} /> v{x.version}</span>)}</td>
                    <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => generate.mutate(p.id)}>Generate draft</Button></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="New period">
            <form className="space-y-3" onSubmit={submit(() => createPeriod.mutate())}>
              <Field label="Legal entity">
                <Select value={np.legalEntityId} onChange={(e) => setNp({ ...np, legalEntityId: e.target.value })} required>
                  <option value="">Select...</option>
                  {entities.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
              <Field label="Start"><Input type="date" value={np.startDate} onChange={(e) => setNp({ ...np, startDate: e.target.value })} required /></Field>
              <Field label="End"><Input type="date" value={np.endDate} onChange={(e) => setNp({ ...np, endDate: e.target.value })} required /></Field>
              <Field label="Due (default: 30 days after end, unverified)"><Input type="date" value={np.dueDate} onChange={(e) => setNp({ ...np, dueDate: e.target.value })} /></Field>
              <Button type="submit">Create period</Button>
            </form>
          </Card>
        </div>
      )}

      {tab === 'Returns' && (
        <div className="space-y-6">
          <Card>
            <div className="mb-3 max-w-sm">
              <Field label="Period">
                <Select value={periodId} onChange={(e) => { setPeriodId(e.target.value); setReturnId(''); }}>
                  <option value="">All periods</option>
                  {periods.data?.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </Select>
              </Field>
            </div>
            {periodId && <Button className="mb-3" onClick={() => generate.mutate(periodId)}>Generate draft</Button>}
            {returns.data?.length === 0 ? <Empty>No returns.</Empty> : (
              <Table head={['Period', 'Version', 'Status', 'Net payable', 'Generated']}>
                {returns.data?.map((x) => (
                  <tr key={x.id} onClick={() => setReturnId(x.id)} className={`cursor-pointer hover:bg-slate-50 ${returnId === x.id ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2">{x.period.label}</td><td className="px-3 py-2">v{x.version}</td>
                    <td className="px-3 py-2"><StatusBadge status={x.status} /></td>
                    <td className="px-3 py-2">{money(x.netPayable)}</td><td className="px-3 py-2 text-xs text-slate-500">{formatDate(x.generatedAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {r && (
            <>
              <Card title="Workflow">
                <ol className="flex flex-wrap gap-2 text-xs">
                  {STEPS.map((s) => (
                    <li key={s} className={`rounded-full px-3 py-1 ${s === r.workflowState ? 'bg-brand-600 text-white' : STEPS.indexOf(s) < STEPS.indexOf(r.workflowState) ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>{s.replace(/_/g, ' ')}</li>
                  ))}
                  {r.status === 'CANCELLED' && <li className="rounded-full bg-red-100 px-3 py-1 text-red-800">CANCELLED (superseded)</li>}
                </ol>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title={`Totals (version ${r.version})`}>
                  <dl className="space-y-1 text-sm">
                    <Row k="Output tax" v={money(r.outputTax)} /><Row k="Recoverable input tax" v={money(r.inputTaxRecoverable)} />
                    <Row k="Non-recoverable input tax" v={money(r.inputTaxNonRecoverable)} />
                    <Row k={credit ? 'Credit position (carried forward)' : 'Net payable'} v={money(credit ? -Number(r.netPayable) : r.netPayable)} bold />
                  </dl>
                  <div className="mt-4"><Table head={['Direction', 'Rate', 'Eligible', 'Base', 'Tax', 'Docs']}>
                    {r.lines.map((l: any) => <tr key={l.id}><td className="px-3 py-1">{l.direction}</td><td className="px-3 py-1">{(Number(l.taxRate) * 100).toFixed(0)}%</td><td className="px-3 py-1">{l.eligible ? 'yes' : 'no'}</td><td className="px-3 py-1">{money(l.base)}</td><td className="px-3 py-1">{money(l.tax)}</td><td className="px-3 py-1">{l.documents}</td></tr>)}
                  </Table></div>
                </Card>

                <Card title="Findings">
                  {r.findings.length === 0 ? <Empty>No findings: the return ties to the ledger.</Empty> : (
                    <Table head={['Code', 'Severity', 'Message', 'Status']}>
                      {r.findings.map((f: any, i: number) => (
                        <tr key={i}><td className="px-3 py-1 font-medium">{f.code}</td><td className="px-3 py-1"><Badge tone={f.severity === 'HARD' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}>{f.severity}</Badge></td>
                          <td className="px-3 py-1 text-slate-600">{f.message}</td><td className="px-3 py-1 text-xs">{f.acknowledged ? `acknowledged: ${f.reason}` : 'open'}</td></tr>
                      ))}
                    </Table>
                  )}
                  {status === 'DRAFT' && r.findings.some((f: any) => !f.acknowledged) && (
                    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={submit(() => act.mutate({ path: 'acknowledge', body: ack }))}>
                      <Field label="Finding code"><Select value={ack.code} onChange={(e) => setAck({ ...ack, code: e.target.value })} required><option value="">Select...</option>{[...new Set(r.findings.filter((f: any) => !f.acknowledged).map((f: any) => f.code))].map((c: any) => <option key={c}>{c}</option>)}</Select></Field>
                      <Field label="Reason (5+ characters)"><Input value={ack.reason} minLength={5} onChange={(e) => setAck({ ...ack, reason: e.target.value })} required /></Field>
                      <Button type="submit" variant="ghost">Acknowledge</Button>
                    </form>
                  )}
                </Card>
              </div>

              <Card title="Next step">
                <div className="space-y-3 text-sm">
                  {status === 'DRAFT' && <><p className="text-slate-500">Resolve or acknowledge every HARD finding, then send to a finance reviewer. Regenerate the draft after fixing source data.</p><Button onClick={() => act.mutate({ path: 'submit-review' })}>Submit for review</Button></>}
                  {status === 'IN_REVIEW' && (
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label="Review comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                      <Button onClick={() => act.mutate({ path: 'review', body: { approve: true, comment: comment || undefined } })}>Approve review</Button>
                      <Button variant="danger" onClick={() => act.mutate({ path: 'review', body: { approve: false, comment: comment || undefined } })}>Send back</Button>
                      <p className="w-full text-xs text-slate-400">The reviewer must be a finance user other than the preparer.</p>
                    </div>
                  )}
                  {status === 'AWAITING_AUTHORIZATION' && <p className="text-slate-600">Waiting for the owner's filing decision. It appears on the Approvals screen and the Owner home; nothing proceeds without it.</p>}
                  {status === 'APPROVED' && (
                    <>
                      <Button onClick={async () => setPkg(await act.mutateAsync({ path: 'package' }))}>Prepare filing package</Button>
                      {pkg && (
                        <div className="rounded bg-slate-50 p-3">
                          <p className="mb-2 text-xs text-slate-500">{pkg.why}</p>
                          <ol className="list-decimal space-y-1 ps-5">{pkg.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                        </div>
                      )}
                      <form className="flex flex-wrap items-end gap-2" onSubmit={submit(() => act.mutate({ path: 'record-filing', body: { acknowledgmentRef: filing.acknowledgmentRef, filedAt: filing.filedAt || undefined } }))}>
                        <Field label="Official acknowledgment ref"><Input value={filing.acknowledgmentRef} minLength={3} onChange={(e) => setFiling({ ...filing, acknowledgmentRef: e.target.value })} required /></Field>
                        <Field label="Filed on"><Input type="date" value={filing.filedAt} onChange={(e) => setFiling({ ...filing, filedAt: e.target.value })} /></Field>
                        <Button type="submit" variant="ghost">Record filing</Button>
                      </form>
                      <p className="text-xs text-slate-400">Record filing needs the package to be prepared first. Official submission is manual: no verified integration exists.</p>
                    </>
                  )}
                  {status === 'FILED' && (
                    <form className="flex flex-wrap items-end gap-2" onSubmit={submit(() => act.mutate({ path: 'record-payment', body: { reference: pay.reference || undefined, method: pay.method, paidAt: pay.paidAt || undefined } }))}>
                      <Field label={credit ? 'Payment reference (not required)' : 'Payment reference'}><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} required={!credit && Number(r.netPayable) > 0} /></Field>
                      <Field label="Method"><Select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{['BANK', 'CASH', 'EFAWATEERCOM'].map((m) => <option key={m}>{m}</option>)}</Select></Field>
                      <Field label="Paid on (must be outside the locked period)"><Input type="date" value={pay.paidAt} onChange={(e) => setPay({ ...pay, paidAt: e.target.value })} /></Field>
                      <Button type="submit">{credit ? 'Close without payment' : 'Record payment'}</Button>
                    </form>
                  )}
                  {status === 'PAID' && <Button onClick={() => act.mutate({ path: 'archive' })}>Archive</Button>}
                  {(status === 'ARCHIVED' || status === 'CANCELLED') && <p className="text-slate-500">This return is final.</p>}
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="Working papers" className="overflow-x-auto">
                  <Button variant="ghost" className="mb-3" onClick={() => saveCsv.mutate()}>Download CSV</Button>
                  <h3 className="text-xs font-semibold text-slate-500">Sales by day</h3>
                  <Table head={['Date', 'Invoices', 'Base', 'Tax']}>{(r.workingPapers.sales ?? []).map((s: any) => <tr key={s.date}><td className="px-3 py-1">{s.date}</td><td className="px-3 py-1">{s.invoices}</td><td className="px-3 py-1">{money(s.base)}</td><td className="px-3 py-1">{money(s.tax)}</td></tr>)}</Table>
                  <h3 className="mt-3 text-xs font-semibold text-slate-500">Credit notes</h3>
                  {(r.workingPapers.creditNotes ?? []).length === 0 ? <Empty>None.</Empty> : <Table head={['Date', 'Credit note', 'Base', 'Tax']}>{r.workingPapers.creditNotes.map((c: any) => <tr key={c.refundId}><td className="px-3 py-1">{c.documentDate}</td><td className="px-3 py-1 text-xs">{c.refundId.slice(0, 8)}</td><td className="px-3 py-1">{money(c.base)}</td><td className="px-3 py-1">{money(c.tax)}</td></tr>)}</Table>}
                  <h3 className="mt-3 text-xs font-semibold text-slate-500">Purchases</h3>
                  {(r.workingPapers.purchases ?? []).length === 0 ? <Empty>None.</Empty> : <Table head={['Date', 'Invoice', 'Supplier tax no.', 'Base', 'Tax', 'Recoverable']}>{r.workingPapers.purchases.map((p: any, i: number) => <tr key={i}><td className="px-3 py-1">{p.documentDate}</td><td className="px-3 py-1">{p.invoiceNumber}</td><td className="px-3 py-1">{p.supplierTaxNumber ?? '-'}</td><td className="px-3 py-1">{money(p.base)}</td><td className="px-3 py-1">{money(p.tax)}</td><td className="px-3 py-1">{p.eligible ? 'yes' : 'no'}</td></tr>)}</Table>}
                </Card>
                <Card title="Evidence">
                  {evidence.data?.length === 0 ? <Empty>No evidence yet. The package and filing documents appear here.</Empty> : (
                    <ul className="space-y-2 text-sm">{evidence.data?.map((d) => <li key={d.id} className="flex items-center justify-between"><span>{d.filename} <span className="text-xs text-slate-400">{formatDate(d.createdAt)}</span></span><Button variant="ghost" onClick={() => saveDoc.mutate(d)}>Download</Button></li>)}</ul>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'E-invoicing' && (
        <div className="space-y-6">
          <Card title="E-invoicing (stub integration)">
            <p className="mb-3 text-sm text-slate-500">Submissions go through the job queue to a stub adapter. The official e-invoicing schema and access are unverified, so references start with STUB- and are not official.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!einv.data?.enabled} onChange={(e) => toggle.mutate(e.target.checked)} />Enabled (owner only)</label>
          </Card>
          <Card title="Invoices">
            <div className="mb-3 max-w-xs"><Select value={invStatus} onChange={(e) => setInvStatus(e.target.value)}><option value="">All tracked</option>{['PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}</Select></div>
            {invoices.data?.length === 0 ? <Empty>No e-invoices.</Empty> : (
              <Table head={['Invoice', 'Issued', 'Total', 'Status', 'Reference', '']}>
                {invoices.data?.map((i) => (
                  <tr key={i.id}><td className="px-3 py-2 font-medium">{i.number}</td><td className="px-3 py-2 text-xs text-slate-500">{formatDate(i.issuedAt)}</td><td className="px-3 py-2">{money(i.total)}</td>
                    <td className="px-3 py-2"><Badge tone={i.externalStatus === 'ACCEPTED' ? 'bg-emerald-100 text-emerald-800' : i.externalStatus === 'REJECTED' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}>{i.externalStatus}</Badge></td>
                    <td className="px-3 py-2 font-mono text-xs">{i.externalRef ?? '-'}</td>
                    <td className="px-3 py-2 text-end">{i.externalStatus === 'REJECTED' && <Button variant="ghost" onClick={() => resubmit.mutate(i.id)}>Resubmit</Button>}</td></tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? 'border-t border-slate-200 pt-1 font-semibold' : ''}`}><dt className="text-slate-500">{k}</dt><dd>{v}</dd></div>;
}
