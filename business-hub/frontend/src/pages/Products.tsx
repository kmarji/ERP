import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Table } from '../components/ui';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

export default function Products() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['products'], queryFn: () => api<any[]>('/products') });
  const taxes = useQuery({ queryKey: ['tax-codes'], queryFn: () => api<any[]>('/tax-codes') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['products'] });
  const [f, setF] = useState({ sku: '', name: '', baseUnit: '', taxCodeId: '' });
  const create = useMutation({
    mutationFn: () => api('/products', { body: { sku: f.sku, name: f.name, baseUnit: f.baseUnit, ...(f.taxCodeId && { taxCodeId: f.taxCodeId }) } }),
    onSuccess: () => { setF({ sku: '', name: '', baseUnit: '', taxCodeId: '' }); refresh(); },
  });
  const [c, setC] = useState<Record<string, { unit: string; factor: string }>>({});
  const conv = useMutation({
    mutationFn: (id: string) => api(`/products/${id}/conversions`, { body: { unit: c[id].unit, factorToBase: Number(c[id].factor) } }),
    onSuccess: refresh,
  });
  return (
    <div className="space-y-6">
      <PageHeader title={t('Products')} subtitle="Stock is held in each product's base unit; conversions let you buy and receive in cartons, bags and so on." />
      <ErrorBox error={list.error ?? create.error ?? conv.error} />
      <Card title="New product">
        <form className="grid gap-3 md:grid-cols-5" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="SKU"><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} required /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Base unit"><Input placeholder="kg, l, pcs" value={f.baseUnit} onChange={(e) => setF({ ...f, baseUnit: e.target.value })} required /></Field>
          <Field label="Tax code">
            <Select value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}>
              <option value="">None</option>
              {taxes.data?.map((x) => <option key={x.id} value={x.id}>{x.code} ({Number(x.rate) * 100}%)</option>)}
            </Select>
          </Field>
          <div className="flex items-end"><Button type="submit">Add product</Button></div>
        </form>
      </Card>
      <Card>
        {list.data?.length === 0 ? <Empty>No products yet.</Empty> : (
          <Table head={['SKU', 'Name', 'Base unit', 'Tax', 'Conversions', 'Add conversion']}>
            {list.data?.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2 font-medium">{p.sku}</td>
                <td className="px-3 py-2">{p.name}</td>
                <td className="px-3 py-2">{p.baseUnit}</td>
                <td className="px-3 py-2">{p.taxCode?.code ?? '-'}</td>
                <td className="px-3 py-2 text-xs text-slate-600">{p.conversions.map((x: any) => `1 ${x.unit} = ${Number(x.factorToBase)} ${p.baseUnit}`).join(', ') || '-'}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Input className="w-24" placeholder="unit" value={c[p.id]?.unit ?? ''} onChange={(e) => setC({ ...c, [p.id]: { unit: e.target.value, factor: c[p.id]?.factor ?? '' } })} />
                    <Input className="w-24" type="number" step="0.000001" placeholder={`x ${p.baseUnit}`} value={c[p.id]?.factor ?? ''} onChange={(e) => setC({ ...c, [p.id]: { unit: c[p.id]?.unit ?? '', factor: e.target.value } })} />
                    <Button variant="ghost" disabled={!c[p.id]?.unit || !c[p.id]?.factor} onClick={() => conv.mutate(p.id)}>Add</Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
