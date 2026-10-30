import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Input, PageHeader, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Audit() {
  const { t } = useI18n();
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const q = new URLSearchParams({ ...(entityType && { entityType }), ...(action && { action }) }).toString();
  const list = useQuery({ queryKey: ['audit', q], queryFn: () => api<any[]>(`/audit?${q}`) });
  return (
    <div>
      <PageHeader title={t('Audit trail')} subtitle="Append-only record of who did what, under which policy version, and the outcome." />
      <ErrorBox error={list.error} />
      <div className="mb-4 flex gap-3">
        <Input className="max-w-xs" placeholder="Entity type (e.g. Policy)" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
        <Input className="max-w-xs" placeholder="Action contains" value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      <Card>
        {list.data?.length === 0 ? <Empty>No audit events.</Empty> : (
          <Table head={['When', 'Actor', 'Action', 'Entity', 'Policy', 'Outcome']}>
            {list.data?.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(e.createdAt)}</td>
                <td className="px-3 py-2"><Badge>{e.actorType}</Badge> <span className="text-xs text-slate-400">{e.actorId?.slice(0, 8)}</span></td>
                <td className="px-3 py-2 font-medium">{e.action}</td>
                <td className="px-3 py-2 text-slate-600">{e.entityType} <span className="text-xs text-slate-400">{e.entityId?.slice(0, 8)}</span></td>
                <td className="px-3 py-2">{e.policyVersion ? `v${e.policyVersion}` : '-'}</td>
                <td className="px-3 py-2"><Badge tone={e.outcome === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{e.outcome}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
