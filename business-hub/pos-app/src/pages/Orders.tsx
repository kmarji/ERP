import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmt, time } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNet } from '../lib/offline';
import { useSession } from '../lib/session';

// Held (OPEN) and in-kitchen (SENT) orders of the branch, to recall and continue.
export default function OrdersPage() {
  const { t } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const res = useQueries({ queries: ['OPEN', 'SENT'].map((status) => ({ queryKey: ['orders', branch!.id, status], queryFn: () => api<any[]>(`/pos/orders?branchId=${branch!.id}&status=${status}`), enabled: net.online, refetchInterval: 10_000 })) });
  const orders = res.flatMap((r) => r.data ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!net.online) return <p className="p-8 text-xl">Open orders live on the server and are not available offline.</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-6">
      <h1 className="text-2xl font-semibold">{t('Open orders')}</h1>
      {orders.length === 0 && <p className="text-slate-500">No open orders.</p>}
      {orders.map((o) => (
        <Link key={o.id} to={`/order/${o.id}`} className="flex min-h-16 items-center justify-between rounded-2xl bg-white p-4 text-lg shadow active:bg-brand-50">
          <span><b>{o.number}</b> <span className="text-slate-500">{o.channel} - {time(o.createdAt)}</span></span>
          <span>{o.lines.filter((l: any) => !l.voided).length} items - {fmt(o.total)} <span className={`ml-2 rounded-full px-3 py-1 text-sm ${o.status === 'SENT' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{o.status}</span></span>
        </Link>
      ))}
    </div>
  );
}
