import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Table, TierBadge } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

// Mirrors the server lifecycle map so the UI only offers legal next steps.
const NEXT_ACTIONS: Record<string, string[]> = {
  NOTIFIED: ['resolve'],
  RESOLVED: ['execute', 'verify'],
  APPROVED: ['execute'],
  REJECTED: ['archive'],
  EXECUTED: ['retry', 'verify'],
  RETRIED: ['execute', 'verify'],
  VERIFIED: ['archive'],
};

export default function Exceptions() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id');
  const [openOnly, setOpenOnly] = useState(true);
  const [comment, setComment] = useState('');

  const list = useQuery({ queryKey: ['exceptions', openOnly], queryFn: () => api<any[]>(`/exceptions?open=${openOnly}`) });
  const detail = useQuery({ queryKey: ['exception', selected], queryFn: () => api<any>(`/exceptions/${selected}`), enabled: !!selected });
  const act = useMutation({
    mutationFn: (action: string) => api(`/exceptions/${selected}/actions`, { body: { action, comment: comment || undefined } }),
    onSuccess: () => {
      setComment('');
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exception', selected] });
    },
  });
  const ex = detail.data;

  return (
    <div>
      <PageHeader
        title={t('Exceptions')}
        subtitle="Routed to the lowest authorized role. Each shows its evidence, impact, owner and deadline."
        actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />Open only</label>}
      />
      <ErrorBox error={list.error ?? act.error} />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          {list.data?.length === 0 ? <Empty>No exceptions.</Empty> : (
            <Table head={['Code', 'Reason', 'Owner', 'Risk', 'Status', 'Due']}>
              {list.data?.map((e) => (
                <tr key={e.id} onClick={() => setParams({ id: e.id })} className={`cursor-pointer hover:bg-slate-50 ${selected === e.id ? 'bg-brand-50' : ''}`}>
                  <td className="px-3 py-2 font-medium">{e.code}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-slate-600">{e.reason}</td>
                  <td className="px-3 py-2">{e.ownerRole}</td>
                  <td className="px-3 py-2"><TierBadge tier={e.riskTier} /></td>
                  <td className="px-3 py-2"><Badge>{e.status}</Badge></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{formatDate(e.deadline)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card className="lg:col-span-2" title="Detail">
          {!ex ? <Empty>Select an exception.</Empty> : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2"><TierBadge tier={ex.riskTier} /><Badge>{ex.status}</Badge></div>
              <p className="font-medium">{ex.code}</p>
              <p>{ex.reason}</p>
              {ex.amount && <p className="text-slate-500">Amount: {formatJOD(ex.amount, lang)}</p>}
              {ex.impact && <p className="text-slate-500">Impact: {ex.impact}</p>}
              <div><div className="text-xs font-medium text-slate-500">Escalation route</div>{(ex.escalationRoute as string[]).join(' > ')}</div>
              <div>
                <div className="text-xs font-medium text-slate-500">Evidence</div>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(ex.evidence, null, 2)}</pre>
              </div>
              <div>
                <div className="text-xs font-medium text-slate-500">History</div>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                  {(ex.history as any[]).map((h, i) => <li key={i}>{h.status} - {formatDate(h.at)}{h.comment ? ` - ${h.comment}` : ''}</li>)}
                </ul>
              </div>
              {(NEXT_ACTIONS[ex.status] ?? []).length > 0 && (
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <Input placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    {NEXT_ACTIONS[ex.status].map((a) => <Button key={a} variant="ghost" className="capitalize" onClick={() => act.mutate(a)}>{a}</Button>)}
                  </div>
                  {ex.status === 'NOTIFIED' && <p className="text-xs text-slate-400">Approve or reject from the Approvals screen when a decision is requested.</p>}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
