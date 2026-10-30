import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Select, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Payables() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['payables'], queryFn: () => api<any[]>('/payables') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['payables'] }); qc.invalidateQueries({ queryKey: ['approvals'] }); };
  const request = useMutation({ mutationFn: (id: string) => api(`/payables/${id}/request-payment`, { method: 'POST' }), onSuccess: refresh });
  const [f, setF] = useState<Record<string, { reference: string; method: string }>>({});
  const confirm = useMutation({
    mutationFn: (id: string) => api(`/payables/${id}/confirm-payment`, { body: { reference: f[id].reference, method: f[id].method ?? 'BANK' } }),
    onSuccess: refresh,
  });
  const now = Date.now();
  const open = list.data?.filter((p) => p.status !== 'PAID').reduce((s, p) => s + Number(p.amountDue), 0) ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title={t('Payables')} subtitle="Payment release needs a second person's approval. Confirm once the transfer has actually been made." />
      <ErrorBox error={list.error ?? request.error ?? confirm.error} />
      <Card title="Outstanding"><div className="text-2xl font-semibold">{formatJOD(open, lang)}</div></Card>
      <Card>
        {list.data?.length === 0 ? <Empty>No payables yet. They appear when supplier invoices are posted.</Empty> : (
          <Table head={['Invoice', 'Amount', 'Due', 'Status', 'Action']}>
            {list.data?.map((p) => {
              const late = p.status !== 'PAID' && new Date(p.dueDate).getTime() < now;
              return (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-medium">{p.invoice?.invoiceNumber}</td>
                  <td className="px-3 py-2">{formatJOD(p.amountDue, lang)}</td>
                  <td className={`px-3 py-2 text-xs ${late ? 'font-medium text-red-600' : 'text-slate-500'}`}>{formatDate(p.dueDate)} {late && <Badge tone="bg-red-100 text-red-800">overdue</Badge>}</td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                  <td className="px-3 py-2">
                    {p.status === 'OPEN' && <div className="flex items-center gap-2"><Button variant="ghost" onClick={() => request.mutate(p.id)}>Request payment</Button><Link to="/approvals" className="text-xs text-brand-600 hover:underline">approvals</Link></div>}
                    {p.status === 'PAYMENT_APPROVED' && (
                      <div className="flex gap-1">
                        <Input className="w-36" placeholder="Reference" value={f[p.id]?.reference ?? ''} onChange={(e) => setF({ ...f, [p.id]: { reference: e.target.value, method: f[p.id]?.method ?? 'BANK' } })} />
                        <Select className="w-24" value={f[p.id]?.method ?? 'BANK'} onChange={(e) => setF({ ...f, [p.id]: { reference: f[p.id]?.reference ?? '', method: e.target.value } })}><option>BANK</option><option>CASH</option></Select>
                        <Button disabled={!f[p.id]?.reference} onClick={() => confirm.mutate(p.id)}>Confirm paid</Button>
                      </div>
                    )}
                    {p.status === 'PAID' && <span className="text-xs text-slate-500">{p.paymentMethod} {p.paymentReference}</span>}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
