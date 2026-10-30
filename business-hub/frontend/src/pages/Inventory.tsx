import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Inventory() {
  const { t, lang } = useI18n();
  const [productId, setProductId] = useState<string | null>(null);
  const stock = useQuery({ queryKey: ['stock'], queryFn: () => api<any[]>('/inventory/stock') });
  const val = useQuery({ queryKey: ['valuation'], queryFn: () => api<{ totalValue: string }>('/inventory/valuation') });
  const rec = useQuery({ queryKey: ['inv-reconcile'], queryFn: () => api<any>('/inventory/reconcile') });
  const gl = useQuery({ queryKey: ['gl-reconcile'], queryFn: () => api<any>('/finance/reconciliation/inventory') });
  const moves = useQuery({ queryKey: ['moves', productId], queryFn: () => api<any[]>(`/inventory/movements?productId=${productId}`), enabled: !!productId });
  return (
    <div className="space-y-6">
      <PageHeader title={t('Inventory')} subtitle="Quantities are in each product's base unit, valued at weighted-average cost." />
      <ErrorBox error={stock.error ?? val.error ?? rec.error ?? gl.error ?? moves.error} />
      <div className="grid gap-6 md:grid-cols-3">
        <Card title="Total valuation"><div className="text-2xl font-semibold">{val.data ? formatJOD(val.data.totalValue, lang) : '-'}</div></Card>
        <Card title="Stock vs ledger">
          {gl.data && (
            <div className="space-y-1 text-sm">
              <div>Stock: {formatJOD(gl.data.stockValue, lang)}</div><div>Ledger: {formatJOD(gl.data.ledgerBalance, lang)}</div>
              <div>Difference: {formatJOD(gl.data.difference, lang)} <Badge tone={gl.data.reconciled ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{gl.data.reconciled ? 'reconciled' : 'mismatch'}</Badge></div>
            </div>
          )}
        </Card>
        <Card title="Balances vs movements">
          {rec.data && <div className="text-sm">{rec.data.checked} balance(s) checked <Badge tone={rec.data.consistent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{rec.data.consistent ? 'consistent' : `${rec.data.mismatches.length} mismatch(es)`}</Badge></div>}
        </Card>
      </div>
      <Card title="Stock levels">
        {stock.data?.length === 0 ? <Empty>No stock yet. Confirm a receipt to bring stock in.</Empty> : (
          <Table head={['SKU', 'Product', 'Quantity', 'Avg cost', 'Value', '']}>
            {stock.data?.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 font-medium">{s.sku}</td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2">{Number(s.qtyBase)} {s.baseUnit}</td>
                <td className="px-3 py-2">{formatJOD(s.avgCost, lang)}</td>
                <td className="px-3 py-2">{formatJOD(s.value, lang)}</td>
                <td className="px-3 py-2 text-end"><Button variant="ghost" onClick={() => setProductId(s.productId)}>Movements</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {productId && (
        <Card title="Movements">
          {moves.data?.length === 0 ? <Empty>No movements.</Empty> : (
            <Table head={['When', 'Type', 'Quantity', 'Unit cost', 'Value', 'Source']}>
              {moves.data?.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2 text-xs text-slate-500">{formatDate(m.occurredAt)}</td><td className="px-3 py-2">{m.type}</td><td className="px-3 py-2">{Number(m.qtyBase)}</td>
                  <td className="px-3 py-2">{Number(m.unitCost)}</td><td className="px-3 py-2">{formatJOD(m.valueDelta, lang)}</td><td className="px-3 py-2 text-xs">{m.sourceType} {m.sourceId.slice(0, 8)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
