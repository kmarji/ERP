import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

function Items({ supplierId }: { supplierId: string }) {
  const qc = useQueryClient();
  const { lang } = useI18n();
  const items = useQuery({ queryKey: ['supplier-items', supplierId], queryFn: () => api<any[]>(`/suppliers/${supplierId}/items`) });
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<any[]>('/products') });
  const [f, setF] = useState({ productId: '', supplierSku: '', unit: '', agreedPrice: '', preferred: false });
  const add = useMutation({
    mutationFn: () => api(`/suppliers/${supplierId}/items`, { body: { productId: f.productId, supplierSku: f.supplierSku, unit: f.unit, preferred: f.preferred, ...(f.agreedPrice && { agreedPrice: Number(f.agreedPrice) }) } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supplier-items', supplierId] }),
  });
  return (
    <div className="space-y-3 bg-slate-50 p-4">
      <ErrorBox error={add.error} />
      {items.data?.length === 0 ? <Empty>No SKU mappings yet.</Empty> : (
        <Table head={['Supplier SKU', 'Product', 'Unit', 'Agreed price', '']}>
          {items.data?.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2 font-medium">{i.supplierSku}</td>
              <td className="px-3 py-2">{i.product?.sku} - {i.product?.name}</td>
              <td className="px-3 py-2">{i.unit}</td>
              <td className="px-3 py-2">{i.agreedPrice ? formatJOD(i.agreedPrice, lang) : '-'}</td>
              <td className="px-3 py-2">{i.preferred && <Badge tone="bg-emerald-100 text-emerald-800">preferred</Badge>}</td>
            </tr>
          ))}
        </Table>
      )}
      <form className="grid grid-cols-2 gap-2 md:grid-cols-6" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
        <Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} required>
          <option value="">Product...</option>
          {products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} - {p.name}</option>)}
        </Select>
        <Input placeholder="Supplier SKU" value={f.supplierSku} onChange={(e) => setF({ ...f, supplierSku: e.target.value })} required />
        <Input placeholder="Unit (e.g. carton)" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required />
        <Input type="number" step="0.001" placeholder="Agreed price" value={f.agreedPrice} onChange={(e) => setF({ ...f, agreedPrice: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.preferred} onChange={(e) => setF({ ...f, preferred: e.target.checked })} />Preferred</label>
        <Button type="submit">Map SKU</Button>
      </form>
    </div>
  );
}

export default function Suppliers() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['suppliers'], queryFn: () => api<any[]>('/suppliers') });
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', taxNumber: '', paymentTermsDays: '30' });
  const create = useMutation({
    mutationFn: () => api('/suppliers', { body: { name: f.name, paymentTermsDays: Number(f.paymentTermsDays), ...(f.taxNumber && { taxNumber: f.taxNumber }) } }),
    onSuccess: () => { setF({ name: '', taxNumber: '', paymentTermsDays: '30' }); qc.invalidateQueries({ queryKey: ['suppliers'] }); },
  });
  return (
    <div className="space-y-6">
      <PageHeader title={t('Suppliers')} subtitle="Supplier identity (tax number) is checked against every invoice. SKU mappings let scanned invoices resolve to products." />
      <ErrorBox error={list.error ?? create.error} />
      <Card title="New supplier">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Tax number"><Input value={f.taxNumber} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} /></Field>
          <Field label="Payment terms (days)"><Input type="number" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
          <div className="flex items-end"><Button type="submit">Add supplier</Button></div>
        </form>
      </Card>
      <Card>
        {list.data?.length === 0 ? <Empty>No suppliers yet.</Empty> : (
          <Table head={['Name', 'Tax number', 'Terms', '']}>
            {list.data?.flatMap((s) => [
              <tr key={s.id}>
                <td className="px-3 py-2 font-medium">{s.name}</td>
                <td className="px-3 py-2">{s.taxNumber ?? '-'}</td>
                <td className="px-3 py-2">{s.paymentTermsDays} days</td>
                <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide' : 'SKU mappings'}</Button></td>
              </tr>,
              open === s.id && <tr key={`${s.id}-i`}><td colSpan={4} className="p-0"><Items supplierId={s.id} /></td></tr>,
            ])}
          </Table>
        )}
      </Card>
    </div>
  );
}
