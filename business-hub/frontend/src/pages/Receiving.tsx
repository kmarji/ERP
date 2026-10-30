import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, TierBadge } from '../components/ui';
import { api, newKey, upload } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

const HEADER = ['invoiceNumber', 'invoiceDate', 'supplierTaxNumber', 'qrUuid', 'subtotal', 'taxTotal', 'total'] as const;
type Header = Record<(typeof HEADER)[number], string>;
interface InvLine { supplierSku: string; qty: string; unit: string; unitPrice: string; taxRate: string }

function Findings({ findings }: { findings: any[] }) {
  if (!findings?.length) return <p className="text-sm text-emerald-700">No findings: exact match.</p>;
  return (
    <ul className="space-y-2">
      {findings.map((f, i) => (
        <li key={i} className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="flex items-center gap-2"><Badge tone={f.severity === 'HARD' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}>{f.severity}</Badge><b>{f.code}</b><span className="text-xs text-slate-500">owner: {f.ownerRole}</span></div>
          <p className="mt-1 text-slate-700">{f.message}</p>
          {f.details && <pre className="mt-1 overflow-auto rounded bg-slate-50 p-1 text-xs">{JSON.stringify(f.details)}</pre>}
        </li>
      ))}
    </ul>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { lang } = useI18n();
  const trace = useQuery({ queryKey: ['trace', id], queryFn: () => api<any>(`/receiving/${id}/trace`) });
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (kind: 'reject' | 'override-post') => api(`/receiving/${id}/${kind}`, { body: { reason } }),
    onSuccess: () => { setReason(''); qc.invalidateQueries({ queryKey: ['trace', id] }); onChanged(); },
  });
  const t = trace.data;
  if (!t) return <ErrorBox error={trace.error} />;
  return (
    <div className="space-y-4 text-sm">
      <ErrorBox error={act.error} />
      <div className="flex flex-wrap items-center gap-2">
        <b>{t.receipt.number}</b><StatusBadge status={t.receipt.operationalStatus} /><Badge>posting: {t.receipt.postingStatus}</Badge>{t.workflowState && <Badge>WF-01: {t.workflowState}</Badge>}
      </div>
      {t.invoice && <p>Invoice <b>{t.invoice.invoiceNumber}</b> dated {formatDate(t.invoice.invoiceDate)}: total {formatJOD(t.invoice.total, lang)} (tax {formatJOD(t.invoice.taxTotal, lang)}){t.invoice.extractionConfidence && ` - confidence ${Number(t.invoice.extractionConfidence) * 100}%`}</p>}
      {t.purchaseOrder && <p>PO <b>{t.purchaseOrder.number}</b> <StatusBadge status={t.purchaseOrder.status} /></p>}
      {t.document && <p>Evidence: {t.document.filename} <a className="text-brand-600 hover:underline" href={`${import.meta.env.VITE_API_URL ?? 'http://localhost:3000'}/documents/${t.document.id}/download`} target="_blank" rel="noreferrer">(sha {t.document.sha256.slice(0, 10)})</a></p>}
      <div><div className="text-xs font-semibold uppercase text-slate-500">Findings</div><Findings findings={t.findings} /></div>
      {t.exceptions?.length > 0 && <div className="text-xs text-slate-500">Exceptions: {t.exceptions.map((e: any) => <span key={e.id} className="me-2"><TierBadge tier={e.riskTier} /> {e.code} ({e.ownerRole}, {e.status}) </span>)} <Link className="text-brand-600 hover:underline" to="/exceptions">open</Link></div>}
      {t.movements.length > 0 && <div><div className="text-xs font-semibold uppercase text-slate-500">Stock movements</div>{t.movements.map((m: any) => <div key={m.id}>{m.type} {Number(m.qtyBase)} @ {Number(m.unitCost)} = {formatJOD(m.valueDelta, lang)}</div>)}</div>}
      {t.journal && (
        <div><div className="text-xs font-semibold uppercase text-slate-500">Journal {t.journal.number}</div>
          <Table head={['Account', 'Debit', 'Credit']}>{t.journal.lines.map((l: any) => <tr key={l.id}><td className="px-3 py-1">{l.account.code} {l.account.name}</td><td className="px-3 py-1">{Number(l.debit) ? formatJOD(l.debit, lang) : ''}</td><td className="px-3 py-1">{Number(l.credit) ? formatJOD(l.credit, lang) : ''}</td></tr>)}</Table></div>
      )}
      {t.payable && <p>Payable {formatJOD(t.payable.amountDue, lang)} due {formatDate(t.payable.dueDate)} <StatusBadge status={t.payable.status} /></p>}
      {t.taxEntries.length > 0 && <div>Tax: {t.taxEntries.map((x: any) => <span key={x.id} className="me-3">{Number(x.taxRate) * 100}% on {formatJOD(x.base, lang)} = {formatJOD(x.taxAmount, lang)} ({x.eligible ? 'recoverable' : 'non-recoverable'})</span>)}</div>}
      {t.receipt.operationalStatus === 'PENDING_REVIEW' && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <Input placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="danger" disabled={reason.length < 3} onClick={() => act.mutate('reject')}>Reject</Button>
            <Button variant="ghost" disabled={reason.length < 3} onClick={() => act.mutate('override-post')}>Override-post (finance/owner)</Button>
          </div>
          <p className="text-xs text-slate-400">Override posts stock at the received quantity and books any difference to purchase price variance.</p>
        </div>
      )}
    </div>
  );
}

export default function Receiving() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const pos = useQuery({ queryKey: ['pos-open'], queryFn: async () => [...(await api<any[]>('/purchase-orders?status=ISSUED')), ...(await api<any[]>('/purchase-orders?status=PARTIALLY_RECEIVED'))] });
  const receipts = useQuery({ queryKey: ['receipts'], queryFn: () => api<any[]>('/receiving') });
  const [poId, setPoId] = useState('');
  const po = pos.data?.find((p) => p.id === poId);
  const [doc, setDoc] = useState<any>(null);
  const [head, setHead] = useState<Header>({ invoiceNumber: '', invoiceDate: '', supplierTaxNumber: '', qrUuid: '', subtotal: '', taxTotal: '', total: '' });
  const [lines, setLines] = useState<InvLine[]>([]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newKey());
  const [result, setResult] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const up = useMutation({
    mutationFn: (file: File) => upload<any>('/documents', file),
    onSuccess: (d) => {
      setDoc(d);
      const fv = (k: string) => String(d.extracted?.fields?.[k]?.value ?? '');
      setHead(Object.fromEntries(HEADER.map((k) => [k, fv(k)])) as Header);
      setLines((d.extracted?.lines ?? []).map((l: any) => ({ supplierSku: l.supplierSku ?? '', qty: String(l.qty ?? ''), unit: l.unit ?? '', unitPrice: String(l.unitPrice ?? ''), taxRate: String(l.taxRate ?? '') })));
    },
  });
  const submit = useMutation({
    mutationFn: () => {
      const n = (s: string) => Number(s);
      const invoice: any = {};
      for (const k of HEADER) if (head[k]) invoice[k] = ['subtotal', 'taxTotal', 'total'].includes(k) ? n(head[k]) : head[k];
      if (lines.length) invoice.lines = lines.map((l) => ({ ...(l.supplierSku && { supplierSku: l.supplierSku }), qty: n(l.qty), unit: l.unit, unitPrice: n(l.unitPrice), ...(l.taxRate && { taxRate: n(l.taxRate) }) }));
      return api<any>('/receiving', {
        body: {
          idempotencyKey: key, purchaseOrderId: po.id, branchId: po.branchId, stockLocationId: po.stockLocationId,
          ...(doc && { evidenceDocumentId: doc.id }), invoice,
          receivedLines: po.lines.filter((l: any) => qtys[l.id]).map((l: any) => ({ poLineId: l.id, qty: n(qtys[l.id]) })),
        },
      });
    },
    onSuccess: (r) => { setResult(r); setKey(newKey()); setSelected(r.receipt.id); qc.invalidateQueries({ queryKey: ['receipts'] }); qc.invalidateQueries({ queryKey: ['pos-open'] }); },
  });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => e.target.files?.[0] && up.mutate(e.target.files[0]);
  const field = (k: keyof Header) => (
    <Field label={`${k}${doc?.extracted?.fields?.[k] ? ` (${doc.extracted.fields[k].source}, ${Math.round(doc.extracted.fields[k].confidence * 100)}%)` : ''}`}>
      <Input value={head[k]} onChange={(e) => setHead({ ...head, [k]: e.target.value })} />
    </Field>
  );
  const setLine = (i: number, patch: Partial<InvLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div>
      <PageHeader title={t('Receiving')} subtitle="Scan once: stock, payable and tax are posted together when the invoice matches the PO and what was physically received." />
      <ErrorBox error={up.error ?? submit.error ?? receipts.error} />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card title="Capture delivery">
            <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); submit.mutate(); }}>
              <Field label="Purchase order">
                <Select value={poId} onChange={(e) => { setPoId(e.target.value); setQtys({}); setResult(null); }} required>
                  <option value="">Select an issued PO...</option>
                  {pos.data?.map((p) => <option key={p.id} value={p.id}>{p.number} ({formatJOD(p.total, lang)})</option>)}
                </Select>
              </Field>
              <Field label="Invoice file (QR / image / PDF / JSON fixture)"><input type="file" onChange={onFile} className="text-sm" /></Field>
              {doc && <p className="text-xs text-slate-500">Extraction confidence: <b>{Math.round(Number(doc.confidence ?? 0) * 100)}%</b>{doc.extracted?.qrPayload && ` - QR: ${doc.extracted.qrPayload}`}. Edit any field below to override.</p>}
              <div className="grid grid-cols-2 gap-3">{HEADER.map((k) => <div key={k}>{field(k)}</div>)}</div>
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase text-slate-500">Invoice lines</div>
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-5 gap-2">
                    <Input placeholder="Supplier SKU" value={l.supplierSku} onChange={(e) => setLine(i, { supplierSku: e.target.value })} />
                    <Input placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    <Input placeholder="Unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
                    <Input placeholder="Unit price" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                    <Input placeholder="Tax rate" value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })} />
                  </div>
                ))}
                <Button type="button" variant="ghost" onClick={() => setLines([...lines, { supplierSku: '', qty: '', unit: '', unitPrice: '', taxRate: '0.16' }])}>+ Line</Button>
              </div>
              {po && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase text-slate-500">Physically received (count it, do not copy the invoice)</div>
                  {po.lines.map((l: any) => (
                    <div key={l.id} className="grid grid-cols-3 items-center gap-2 text-sm">
                      <span>Ordered {Number(l.qty)} {l.unit} (received {Number(l.qtyReceived)})</span>
                      <Input type="number" step="0.0001" placeholder={`Received (${l.unit})`} value={qtys[l.id] ?? ''} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} />
                    </div>
                  ))}
                </div>
              )}
              <Button type="submit" disabled={!po || submit.isPending || !Object.values(qtys).some(Boolean)}>Confirm receipt</Button>
            </form>
          </Card>
          {result && (
            <Card title="Outcome">
              <div className="mb-3 flex items-center gap-2"><StatusBadge status={result.outcome} />{result.replay && <Badge>replay of an earlier submission</Badge>}</div>
              {result.outcome === 'POSTED' ? <p className="text-sm">Stock, payable and input tax posted. <button className="text-brand-600 hover:underline" onClick={() => setSelected(result.receipt.id)}>View journal and evidence</button></p> : <Findings findings={result.findings} />}
              {result.exceptions?.[0] && <p className="mt-3 text-xs text-slate-500">Assigned to <b>{result.exceptions[0].ownerRole}</b>, due {formatDate(result.exceptions[0].deadline)}.</p>}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Receipts">
            {receipts.data?.length === 0 ? <Empty>No receipts yet.</Empty> : (
              <Table head={['Number', 'Invoice', 'Total', 'Status']}>
                {receipts.data?.map((r) => (
                  <tr key={r.id} onClick={() => setSelected(r.id)} className={`cursor-pointer hover:bg-slate-50 ${selected === r.id ? 'bg-brand-50' : ''}`}>
                    <td className="px-3 py-2 font-medium">{r.number}</td>
                    <td className="px-3 py-2">{r.invoice?.invoiceNumber ?? '-'}</td>
                    <td className="px-3 py-2">{r.invoice ? formatJOD(r.invoice.total, lang) : '-'}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.operationalStatus} /></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          {selected && <Card title="Receipt detail"><Detail id={selected} onChanged={() => qc.invalidateQueries({ queryKey: ['receipts'] })} /></Card>}
        </div>
      </div>
    </div>
  );
}
