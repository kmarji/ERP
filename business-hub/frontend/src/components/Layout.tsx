import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { NAV } from '../nav';

export function Layout() {
  const { lang, setLang, t } = useI18n();
  const nav = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me') });
  const items = NAV.filter((n) => !n.roles || me.data?.isSystem || me.data?.roles?.some((r: { key: string }) => n.roles!.includes(r.key)));
  const groups = [...new Set(items.map((n) => n.group))];

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-brand-900 text-white">
        <div className="px-5 py-5 text-lg font-semibold tracking-tight">Business Hub</div>
        <nav className="space-y-5 px-3 pb-6">
          {groups.map((g) => (
            <div key={g}>
              <div className="px-2 pb-1 text-xs uppercase tracking-wider text-brand-100/60">{g}</div>
              {items.filter((n) => n.group === g).map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/'}
                  className={({ isActive }) => `block rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-brand-700 font-medium' : 'text-brand-100 hover:bg-brand-700/60'}`}
                >
                  {t(n.label)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-3 text-sm">
          <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>
            {lang === 'en' ? 'العربية' : 'English'}
          </button>
          <span className="text-slate-500">{me.data?.email}</span>
          <button
            className="text-brand-600 hover:underline"
            onClick={() => {
              auth.clear();
              nav('/login');
            }}
          >
            {t('Sign out')}
          </button>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
