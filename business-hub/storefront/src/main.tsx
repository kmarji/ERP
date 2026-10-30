import { ThemeButton } from './theme';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { DEFAULT_TENANT, I18nProvider, useI18n } from './lib';
import Branches from './pages/Branches';
import Checkout from './pages/Checkout';
import Menu from './pages/Menu';
import Track from './pages/Track';

function Shell({ children }: { children: React.ReactNode }) {
  const { lang, setLang, t } = useI18n();
  return (
    <>
      <header className="flex items-center justify-between bg-brand-900 px-4 py-3 text-white">
        <Link to="/" className="text-lg font-semibold">{t('Order online')}</Link>
        <span className="flex gap-2">
        <ThemeButton className="rounded border border-white/40 px-3 py-1 text-sm" />
        <button className="rounded border border-white/40 px-3 py-1 text-sm" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label="Switch language">
          {lang === 'en' ? 'العربية' : 'English'}
        </button>
        </span>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-4">{children}</main>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Navigate to={`/${DEFAULT_TENANT}`} replace />} />
            <Route path="/track/:code" element={<Track />} />
            <Route path="/:tenant" element={<Branches />} />
            <Route path="/:tenant/b/:branchId" element={<Menu />} />
            <Route path="/:tenant/b/:branchId/checkout" element={<Checkout />} />
            <Route path="/:tenant/track/:code" element={<Track />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
