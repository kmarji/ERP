import { ThemeButton } from './theme';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    headers: init.form ? undefined : { 'Content-Type': 'application/json' },
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? res.statusText);
  return data as T;
}

type Lang = 'en' | 'ar';
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (en: string, ar: string) => string }>({ lang: 'en', setLang: () => {}, t: (en) => en });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('careers_lang') as Lang) || 'en');
  useEffect(() => {
    localStorage.setItem('careers_lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  return <Ctx.Provider value={{ lang, setLang, t: (en, ar) => (lang === 'ar' ? ar : en) }}>{children}</Ctx.Provider>;
}
export const useLang = () => useContext(Ctx);

// Small async-state helper so pages stay readable.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

export const Card = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    {title && <h2 className="mb-2 text-base font-semibold text-brand-900">{title}</h2>}
    {children}
  </section>
);

export const Err = ({ msg }: { msg: string | null }) => (msg ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</p> : null);

export function Btn({ variant = 'primary', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const v = { primary: 'bg-brand-600 text-white hover:bg-brand-700', ghost: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50', danger: 'bg-red-600 text-white hover:bg-red-700' }[variant];
  return <button {...p} className={`min-h-11 rounded-lg px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-50 ${v} ${className}`} />;
}

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="mb-3 block text-sm">
    <span className="mb-1 block font-medium text-slate-700">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
  </label>
);

export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

// Comma-separated tags, kept as a string while typing.
export function Tags({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return <input className={inputCls} value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)); }} placeholder="a, b, c" />;
}

export function Shell({ children }: { children: ReactNode }) {
  const { lang, setLang } = useLang();
  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 pb-16">
      <header className="flex items-center justify-between py-4">
        <span className="text-lg font-semibold text-brand-900">Careers</span>
        <span className="flex gap-2">
        <ThemeButton className="rounded border border-slate-300 px-3 py-1 text-sm" />
        <button className="rounded border border-slate-300 px-3 py-1 text-sm" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}>{lang === 'en' ? 'العربية' : 'English'}</button>
        </span>
      </header>
      <main>{children}</main>
    </div>
  );
}
