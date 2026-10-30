import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Line { productId: string; qty: string; unit: string; unitPrice: string }
const blank = (): Line => ({ productId: '', qty: '', unit: '', unitPrice: '' });

function LinesEditor({ lines, setLines, products, withPrice }: { lines: Line[]; setLines: (l: Line[]) => void; products: any[]; withPrice?: boolean }) {
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Select value={l.productId} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); set(i, { productId: e.target.value, unit: l.unit || p?.baseUnit || '' }); }} required>
            <option value="">Product...</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.sku} - {p.name}</option>)}
          </Select>
          <Input type="number" step="0.0001" placeholder="Qty" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} required />
          <Input placeholder="Unit" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} required />
          {withPrice ? <Input type="number" step="0.001" placeholder="Unit price (optional)" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} /> : <span />}
          <Button type="button" variant="ghost" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)}>Remove</Button>
        </div>
      ))}
      <Button type="button" variant="ghost" onClick={() => setLines([...lines, blank()])}>+ Line</Button>
    </div>
  );
}

const toLines = (lines: Line[], withPrice: boolean) =>
  lines.map((l) => ({ productId: l.productId, qty: Number(l.qty), unit: l.unit, ...(withPrice && l.unitPrice && { unitPrice: Number(l.unitPrice) }) }));

export default function Purchasing() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [tab, setTab] = useState('Purchase requests');
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<any[]>('/products') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<any[]>('/org/branches') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api<any[]>('/org/stock-locations') });
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<any[]>('/suppliers') });
  const prs = useQuery({ queryKey: ['prs'], queryFn: () => api<any[]>('/purchase-requests') });
  const pos = useQuery({ queryKey: ['pos'], queryFn: () => api<any[]>('/purchase-orders') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['prs'] }); qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['approvals'] }); };

  const [branchId, setBranchId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const locs = locations.data?.filter((l) => l.branchId === branchId) ?? [];
  const reset = () => setLines([blank()]);

  const createPr = useMutation({ mutationFn: () => api('/purchase-requests', { body: { branchId, stockLocationId: locationId, lines: toLines(lines, false) } }), onSuccess: () => { reset(); refresh(); } });
  const submitPr = useMutation({ mutationFn: (id: string) => api(`/purchase-requests/${id}/submit`, { method: 'POST' }), onSuccess: refresh });
  const createPo = useMutation({ mutationFn: () => api('/purchase-orders', { body: { supplierId, branchId, stockLocationId: locationId, lines: toLines(lines, true) } }), onSuccess: () => { reset(); refresh(); } });
  const cancelPo = useMutation({ mutationFn: (id: string) => api(`/purchase-orders/${id}/cancel`, { method: 'POST' }), onSuccess: refresh });
  const err = createPr.error ?? submitPr.error ?? createPo.error ?? cancelPo.error ?? prs.error ?? pos.error;

  const where = (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Branch"><Select value={branchId} onChange={(e) => { setBranchId(e.target.value); setLocationId(''); }} required><option value="">Select...</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.code} - {b.name}</option>)}</Select></Field>
      <Field label="Stock location"><Select value={locationId} onChange={(e) => setLocationId(e.target.value)} required><option value="">Select...</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
    </div>
  );
  const hint = (s: string) => s === 'PENDING_APPROVAL' && <Link to="/approvals" className="ms-2 text-xs text-brand-600 hover:underline">awaiting approval</Link>;

  return (
    <div>
      <PageHeader title={t('Purchasing')} subtitle="Small requests auto-approve and auto-issue within policy; larger ones go to the lowest authorized approver." />
      <ErrorBox error={err} />
      <Tabs tabs={['Purchase requests', 'Purchase orders']} value={tab} onChange={setTab} />
      {tab === 'Purchase requests' ? (
        <div className="space-y-6">
          <Card title="New purchase request">
            <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); createPr.mutate(); }}>
              {where}
              <LinesEditor lines={lines} setLines={setLines} products={products.data ?? []} />
              <Button type="submit">Save draft</Button>
            </form>
          </Card>
          <Card>
            {prs.data?.length === 0 ? <Empty>No purchase requests.</Empty> : (
              <Table head={['Number', 'Created', 'Lines', 'Status', '']}>
                {prs.data?.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-medium">{p.number}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatDate(p.createdAt)}</td>
                    <td className="px-3 py-2">{p.lines.length}</td>
                    <td className="px-3 py-2"><StatusBadge status={p.status} />{hint(p.status)}</td>
                    <td className="px-3 py-2 text-end">{p.status === 'DRAFT' && <Button onClick={() => submitPr.mutate(p.id)}>Submit</Button>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <Card title="New purchase order">
            <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); createPo.mutate(); }}>
              <Field label="Supplier"><Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required><option value="">Select...</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              {where}
              <LinesEditor lines={lines} setLines={setLines} products={products.data ?? []} withPrice />
              <Button type="submit">Create PO</Button>
            </form>
          </Card>
          <Card>
            {pos.data?.length === 0 ? <Empty>No purchase orders.</Empty> : (
              <Table head={['Number', 'Created', 'Total (incl. tax)', 'Status', '']}>
                {pos.data?.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-medium">{p.number}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatDate(p.createdAt)}</td>
                    <td className="px-3 py-2">{formatJOD(p.total, lang)}</td>
                    <td className="px-3 py-2"><StatusBadge status={p.status} />{hint(p.status)}</td>
                    <td className="px-3 py-2 text-end">{['ISSUED', 'PENDING_APPROVAL'].includes(p.status) && <Button variant="ghost" onClick={() => cancelPo.mutate(p.id)}>Cancel</Button>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
