import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { Banner } from './components/Banner';
import { auth } from './lib/api';
import { useI18n } from './lib/i18n';
import { useSession } from './lib/session';
import BranchPage from './pages/Branch';
import Home from './pages/Home';
import KdsPage from './pages/Kds';
import Login from './pages/Login';
import OfflineSales from './pages/OfflineSales';
import OrderPage from './pages/Order';
import OrdersPage from './pages/Orders';
import Pay from './pages/Pay';
import RefundPage from './pages/Refund';
import ShiftPage from './pages/Shift';

function Shell() {
  const { t, lang, setLang } = useI18n();
  const { branch } = useSession();
  const nav = useNavigate();
  if (!auth.token()) return <Navigate to="/login" replace />;
  const link = ({ isActive }: { isActive: boolean }) => `rounded-lg px-3 py-2 ${isActive ? 'bg-brand-600' : ''}`;
  return (
    <div className="flex h-full flex-col">
      <Banner />
      <header className="flex items-center justify-between gap-2 bg-brand-900 px-3 py-1 text-white">
        <nav className="flex flex-wrap items-center gap-1 text-lg">
          <Link to="/" className="mr-2 font-semibold">{branch?.name ?? 'POS'}</Link>
          <NavLink to="/order" className={link}>{t('Order')}</NavLink>
          <NavLink to="/orders" className={link}>{t('Open orders')}</NavLink>
          <NavLink to="/shift" className={link}>{t('Shift')}</NavLink>
          <NavLink to="/refund" className={link}>{t('Refund')}</NavLink>
          <NavLink to="/kds" className={link}>{t('Kitchen')}</NavLink>
          <NavLink to="/branch" className={link}>{t('Branch')}</NavLink>
        </nav>
        <div className="flex gap-2">
          <button className="min-h-12 rounded-lg border border-white/40 px-3" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>{lang === 'en' ? 'العربية' : 'English'}</button>
          <button className="min-h-12 rounded-lg px-3 underline" onClick={() => { auth.clear(); nav('/login'); }}>{t('Sign out')}</button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto"><Outlet /></main>
    </div>
  );
}

// A branch must be chosen before any trading screen.
function NeedsBranch() {
  const { branch } = useSession();
  return branch ? <Outlet /> : <Navigate to="/branch" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Shell />}>
        <Route path="/branch" element={<BranchPage />} />
        <Route path="/offline-sales" element={<OfflineSales />} />
        <Route element={<NeedsBranch />}>
          <Route path="/" element={<Home />} />
          <Route path="/order/:id?" element={<OrderPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/pay/:id" element={<Pay />} />
          <Route path="/shift" element={<ShiftPage />} />
          <Route path="/refund" element={<RefundPage />} />
          <Route path="/kds" element={<KdsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
