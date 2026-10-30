import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { syncNow, useNet } from '../lib/offline';

// Always visible: whether the tablet can reach the server, what is waiting, and what went wrong.
export function Banner() {
  const n = useNet();
  const { t } = useI18n();
  let tone = 'bg-emerald-600';
  let text = t('Online');
  if (!n.online) {
    tone = 'bg-amber-600';
    text = `${t('Offline')}: ${n.pending} sale(s) waiting to sync`;
  } else if (n.rejected) {
    tone = 'bg-red-600';
    text = `Sync problems: ${n.rejected} sale(s) rejected`;
  } else if (n.syncing || n.pending) {
    tone = 'bg-sky-600';
    text = `Syncing ${n.pending} sale(s)...`;
  }
  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-1.5 text-sm text-white ${tone}`}>
      <span>{text}{n.problem ? ` - ${n.problem}` : ''}</span>
      <span className="flex gap-4">
        {(n.rejected > 0 || n.pending > 0) && <Link to="/offline-sales" className="underline">{t('Offline sales')}</Link>}
        {n.online && n.pending > 0 && <button className="underline" onClick={() => void syncNow()}>{t('Sync now')}</button>}
      </span>
    </div>
  );
}
