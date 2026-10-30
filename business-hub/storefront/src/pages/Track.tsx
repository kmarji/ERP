import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_TENANT, useFetch, useI18n } from '../lib';

const STEPS = ['PLACED', 'ACCEPTED', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'];

interface Tracking {
  orderNumber: string;
  status: string;
  channel: string;
  promisedAt: string | null;
  total: string;
  items: { name: string; nameAr: string | null; qty: number }[];
}

export default function Track() {
  const { tenant = DEFAULT_TENANT, code = '' } = useParams();
  const [q] = useSearchParams();
  const { t, pick, money, lang } = useI18n();
  const { data, error } = useFetch<Tracking>(`/store/${tenant}/track/${code}`, 10_000);
  const failed = data && ['CANCELLED', 'REJECTED'].includes(data.status);
  // Pickup orders skip the delivery step.
  const steps = data?.channel === 'DELIVERY' ? STEPS : STEPS.filter((s) => s !== 'OUT_FOR_DELIVERY');
  const at = steps.indexOf(data?.status ?? '');

  return (
    <section>
      {q.get('placed') && (
        <div role="status" className="mb-4 rounded-xl bg-emerald-50 p-4 text-emerald-900">
          <h1 className="text-lg font-semibold">{t('Order received')}</h1>
          <p>{t('Tracking code')}: <strong className="select-all font-mono">{code}</strong></p>
        </div>
      )}
      {!q.get('placed') && <h1 className="mb-3 text-xl font-semibold">{t('Track an order')}</h1>}
      {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error.message}</p>}
      {data && (
        <>
          <p className="mb-3 text-sm text-slate-700">#{data.orderNumber} · {money(data.total)}</p>
          {failed ? (
            <p role="status" className="rounded bg-red-50 p-3 font-medium text-red-800">{t(data.status)}</p>
          ) : (
            <ol className="mb-4 space-y-2" aria-live="polite">
              {steps.map((s, i) => (
                <li key={s} aria-current={i === at ? 'step' : undefined} className={`flex items-center gap-3 rounded-lg border p-3 ${i < at ? 'border-emerald-300 bg-emerald-50' : i === at ? 'border-brand-700 bg-brand-50 font-semibold' : 'border-slate-200 text-slate-500'}`}>
                  <span aria-hidden className={`h-3 w-3 rounded-full ${i <= at ? 'bg-brand-700' : 'bg-slate-300'}`} />
                  {t(s)}
                </li>
              ))}
            </ol>
          )}
          {data.promisedAt && !failed && data.status !== 'DELIVERED' && <p className="mb-3 text-sm">{t('Promised for')}: {new Date(data.promisedAt).toLocaleString(lang === 'ar' ? 'ar-JO' : 'en-GB', { timeZone: 'Asia/Amman', dateStyle: 'medium', timeStyle: 'short' })}</p>}
          <h2 className="mb-1 font-medium">{t('Items')}</h2>
          <ul className="text-sm">{data.items.map((i, n) => <li key={n}>{i.qty}× {pick(i.name, i.nameAr)}</li>)}</ul>
        </>
      )}
      <Link to={`/${tenant}`} className="mt-6 inline-block text-brand-700 underline">← {t('Order online')}</Link>
    </section>
  );
}
