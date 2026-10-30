import { useQuery } from '@tanstack/react-query';
import { Btn } from '../components/ui';
import { outboxAll } from '../lib/db';
import { fmt } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { syncNow, useNet } from '../lib/offline';

// Everything sold offline that the server has not accepted yet. Rejected sales are never dropped: they stay here
// with the server's reason until a manager fixes the cause and retries them in the back office.
export default function OfflineSales() {
  const { t } = useI18n();
  const net = useNet();
  const ops = useQuery({ queryKey: ['outbox', net.pending, net.rejected, net.syncing], queryFn: outboxAll });
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('Offline sales')}</h1>
        <Btn disabled={!net.online || net.syncing || net.pending === 0} onClick={() => void syncNow()}>{t('Sync now')}</Btn>
      </div>
      {ops.data?.length === 0 && <p className="text-slate-500">Nothing waiting. Every offline sale has been accepted by the server.</p>}
      {ops.data?.map((o) => (
        <div key={o.opId} className={`rounded-2xl p-4 text-lg shadow ${o.status === 'REJECTED' ? 'border-2 border-red-400 bg-red-50' : 'bg-white'}`}>
          <div className="flex justify-between"><b>{o.localNumber}</b><span>{fmt(o.total)} JOD - {new Date(o.capturedAt).toLocaleString('en-GB')}</span></div>
          <div className={o.status === 'REJECTED' ? 'text-red-700' : 'text-amber-700'}>
            {o.status === 'REJECTED' ? `Rejected (${o.code ?? 'ERROR'}): ${o.reason ?? ''}` : 'Waiting to sync'}
          </div>
          {o.status === 'REJECTED' && <div className="text-sm text-slate-600">A manager can fix the cause and retry this sale in the back office (Sync operations). It is not lost.</div>}
        </div>
      ))}
    </div>
  );
}
