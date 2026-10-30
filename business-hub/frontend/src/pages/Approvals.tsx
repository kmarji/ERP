import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Approvals() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [comments, setComments] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['approvals'], queryFn: () => api<any[]>('/approvals?status=PENDING') });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => api(`/approvals/${v.id}/decide`, { body: { approve: v.approve, comment: comments[v.id] || undefined } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
  return (
    <div>
      <PageHeader title={t('Approvals')} subtitle="Requests waiting for your role. You cannot decide a request you raised yourself." />
      <ErrorBox error={list.error ?? decide.error} />
      <Card>
        {list.data?.length === 0 ? <Empty>No pending approvals.</Empty> : (
          <Table head={['Action', 'Subject', 'Amount', 'Requested', 'Decision']}>
            {list.data?.map((a) => (
              <tr key={a.id}>
                <td className="px-3 py-2 font-medium">{a.action}</td>
                <td className="px-3 py-2 text-slate-600">{a.subjectType} {a.subjectId}</td>
                <td className="px-3 py-2">{a.amount ? formatJOD(a.amount, lang) : '-'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{formatDate(a.createdAt)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Input className="w-40" placeholder="Comment" value={comments[a.id] ?? ''} onChange={(e) => setComments({ ...comments, [a.id]: e.target.value })} />
                    <Button variant="ghost" onClick={() => decide.mutate({ id: a.id, approve: false })}>Reject</Button>
                    <Button onClick={() => decide.mutate({ id: a.id, approve: true })}>Approve</Button>
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
