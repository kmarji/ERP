import { Link } from 'react-router-dom';
import { recentCodes, useFetch, useI18n, useTenant } from '../lib';

export interface BranchInfo {
  branchId: string;
  name: string;
  acceptingOrders: boolean;
  pickup: boolean;
  delivery: boolean;
  deliveryFee: string;
  minOrder: string;
  serviceAreas: string[];
  prepMinutes: number;
  scheduledOrdering: boolean;
}

export default function Branches() {
  const tenant = useTenant();
  const { t, money } = useI18n();
  const { data, error, loading } = useFetch<BranchInfo[]>(`/store/${tenant}/branches`);
  const recent = recentCodes.get().filter((r) => r.tenant === tenant);
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold">{t('Choose a branch')}</h1>
      {loading && <p role="status">…</p>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error.message}</p>}
      <ul className="space-y-3">
        {data?.map((b) => {
          const card = (
            <div className={`rounded-xl border bg-white p-4 shadow-sm ${b.acceptingOrders ? 'border-slate-200' : 'border-slate-200 opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-medium">{b.name}</h2>
                {!b.acceptingOrders && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{t('Not accepting orders right now')}</span>}
              </div>
              <p className="mt-1 text-sm text-slate-700">
                {[b.pickup && t('Pickup'), b.delivery && `${t('Delivery')} (${money(b.deliveryFee)})`].filter(Boolean).join(' · ')}
              </p>
              <p className="text-sm text-slate-600">
                {t('Minimum order')}: {money(b.minOrder)} · {t('Ready in about')} {b.prepMinutes} {t('min')}
              </p>
            </div>
          );
          return <li key={b.branchId}>{b.acceptingOrders ? <Link to={`/${tenant}/b/${b.branchId}`} className="block rounded-xl">{card}</Link> : card}</li>;
        })}
      </ul>
      {data?.length === 0 && <p className="text-slate-600">No branches are taking online orders yet.</p>}
      {recent.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 font-medium">{t('Recent orders')}</h2>
          <ul className="space-y-1">
            {recent.map((r) => (
              <li key={r.code}><Link className="text-brand-700 underline" to={`/${r.tenant}/track/${r.code}`}>{r.code}</Link></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
