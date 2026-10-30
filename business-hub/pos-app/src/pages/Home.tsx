import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNet } from '../lib/offline';
import { useSession } from '../lib/session';

export default function Home() {
  const { t } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const shift = useQuery({ queryKey: ['shift', branch?.id], queryFn: () => api<any>(`/pos/shifts/current?branchId=${branch!.id}`), enabled: !!branch && net.online });
  const open = shift.data && shift.data.id;
  const tile = 'flex min-h-32 flex-col items-center justify-center rounded-2xl bg-white p-4 text-xl font-semibold shadow active:bg-brand-50';
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 rounded-2xl bg-white p-4 text-lg">
        {!net.online ? 'Offline: cash sales are queued and synced later.' : open ? <>{t('Shift')} open since {new Date(shift.data.openedAt).toLocaleTimeString('en-GB')} - float {fmt(shift.data.openingFloat)}</> : <>No open shift. <Link className="text-brand-600 underline" to="/shift">{t('Open shift')}</Link></>}
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Link to="/order" className={`${tile} bg-brand-600 text-white`}>{t('New order')}</Link>
        <Link to="/orders" className={tile}>{t('Open orders')}</Link>
        <Link to="/shift" className={tile}>{t('Shift')}</Link>
        <Link to="/refund" className={tile}>{t('Refund')}</Link>
        <Link to="/kds" className={tile}>{t('Kitchen')}</Link>
        <Link to="/offline-sales" className={tile}>{t('Offline sales')}{net.pending + net.rejected > 0 && <span className="text-sm text-amber-600">{net.pending} waiting / {net.rejected} rejected</span>}</Link>
      </div>
    </div>
  );
}
