import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, ErrorBox, PageHeader, TierBadge } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Dash {
  outcomes: { workflowsCompleted: { workflow: string; count: number }[]; automatedActions: { action: string; count: number }[] };
  health: { openExceptionsByTier: Record<string, number>; overdueExceptions: number; pendingApprovals: number; deadLetterJobs: number };
  decisions: { type: 'exception' | 'approval'; id: string; title: string; reason: string; impact: string | null; amount: number | null; riskTier: string; deadline: string | null }[];
}

const pretty = (s: string) => s.replace(/[._]/g, ' ');

export default function OwnerHome() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const dash = useQuery({ queryKey: ['owner-dashboard'], queryFn: () => api<Dash>('/dashboard/owner'), refetchInterval: 30_000 });
  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean }) => api(`/approvals/${v.id}/decide`, { body: { approve: v.approve } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['owner-dashboard'] }),
  });
  const d = dash.data;
  const automated = (d?.outcomes.workflowsCompleted ?? []).reduce((n, w) => n + w.count, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('Owner home')} subtitle="Routine work runs automatically. Only decisions beyond delegated authority appear below." />
      <ErrorBox error={dash.error ?? decide.error} />

      <Card title={t('Completed automatically')}>
        {!d ? null : automated === 0 && d.outcomes.automatedActions.length === 0 ? (
          <Empty>No automated outcomes in the last 7 days yet.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {d.outcomes.workflowsCompleted.map((w) => (
              <Stat key={w.workflow} label={`${w.workflow} completed`} value={w.count} />
            ))}
            {d.outcomes.automatedActions.slice(0, 8).map((a) => (
              <Stat key={a.action} label={pretty(a.action)} value={a.count} />
            ))}
          </div>
        )}
      </Card>

      <Card title={t('Business health')}>
        {d && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Open exceptions" value={Object.values(d.health.openExceptionsByTier).reduce((a, b) => a + b, 0)} />
            <Stat label="Overdue" value={d.health.overdueExceptions} warn={d.health.overdueExceptions > 0} />
            <Stat label="Pending approvals" value={d.health.pendingApprovals} />
            <Stat label="Failed integrations" value={d.health.deadLetterJobs} warn={d.health.deadLetterJobs > 0} />
          </div>
        )}
      </Card>

      <Card title={t('Decisions needing you')}>
        {d && d.decisions.length === 0 && <Empty>{t('Nothing needs your attention')}</Empty>}
        <ul className="divide-y divide-slate-100">
          {d?.decisions.map((x) => (
            <li key={`${x.type}-${x.id}`} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <TierBadge tier={x.riskTier} />
                  <span className="font-medium">{pretty(x.title)}</span>
                  {x.amount !== null && <span className="text-sm text-slate-500">{formatJOD(x.amount, lang)}</span>}
                </div>
                <p className="mt-1 text-sm text-slate-600">{x.reason}</p>
                {x.impact && <p className="text-xs text-slate-400">Impact: {x.impact}</p>}
                {x.deadline && <p className="text-xs text-slate-400">Due {formatDate(x.deadline)}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {x.type === 'approval' ? (
                  <>
                    <Button variant="ghost" onClick={() => decide.mutate({ id: x.id, approve: false })}>Reject</Button>
                    <Button onClick={() => decide.mutate({ id: x.id, approve: true })}>Approve</Button>
                  </>
                ) : (
                  <Link to={`/exceptions?id=${x.id}`}><Button variant="ghost">Review</Button></Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold ${warn ? 'text-red-600' : 'text-slate-900'}`}>{value}</div>
      <div className="text-xs capitalize text-slate-500">{label}</div>
    </div>
  );
}
