import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const DEFAULT_TENANT = import.meta.env.VITE_TENANT ?? 'demo';
export const useTenant = () => useParams().tenant ?? DEFAULT_TENANT;

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? res.statusText, data?.error);
  return data as T;
}

// Tiny fetch hook: no cache library needed for four public GETs.
export function useFetch<T>(path: string | null, pollMs?: number) {
  const [state, set] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: !!path });
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () =>
      api<T>(path).then(
        (data) => live && set({ data, loading: false }),
        (error) => live && set((s) => ({ ...s, error, loading: false })),
      );
    set({ loading: true });
    load();
    const t = pollMs ? setInterval(load, pollMs) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [path, pollMs]);
  return state;
}

// ---------------------------------------------------------------- i18n

type Lang = 'en' | 'ar';
const AR: Record<string, string> = {
  'Order online': 'اطلب أونلاين', 'Choose a branch': 'اختر الفرع', Pickup: 'استلام', Delivery: 'توصيل', 'Not accepting orders right now': 'لا يستقبل الطلبات حالياً',
  'Delivery fee': 'رسوم التوصيل', 'Minimum order': 'الحد الأدنى للطلب', 'Ready in about': 'جاهز خلال حوالي', min: 'دقيقة', All: 'الكل', Add: 'أضف', 'Add to cart': 'أضف إلى السلة',
  Required: 'مطلوب', 'View cart': 'عرض السلة', Cart: 'السلة', 'Your cart is empty': 'سلتك فارغة', Subtotal: 'المجموع', Checkout: 'إتمام الطلب', Close: 'إغلاق', Back: 'رجوع',
  Name: 'الاسم', Phone: 'الهاتف', Email: 'البريد الإلكتروني', Area: 'المنطقة', Address: 'العنوان', Notes: 'ملاحظات', 'Schedule for later': 'جدولة لوقت لاحق', Payment: 'الدفع',
  'Cash on delivery / at pickup': 'نقداً عند التسليم / الاستلام', 'Card online': 'بطاقة أونلاين', 'Place order': 'أرسل الطلب', Total: 'الإجمالي', Select: 'اختر',
  'Save my details for next time': 'احفظ بياناتي للمرة القادمة', 'Order received': 'تم استلام طلبك', 'Tracking code': 'رمز التتبع', Items: 'الأصناف', 'Promised for': 'الموعد المتوقع',
  PLACED: 'تم الاستلام', ACCEPTED: 'تم القبول', READY: 'جاهز', OUT_FOR_DELIVERY: 'في الطريق', DELIVERED: 'تم التسليم', CANCELLED: 'ملغي', REJECTED: 'مرفوض',
  'Recent orders': 'طلباتك الأخيرة', 'Track an order': 'تتبع طلب', Track: 'تتبع',
};
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string; pick: (en: string, ar?: string | null) => string; money: (v: number | string) => string }>(null as never);
export const useI18n = () => useContext(Ctx);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('sf_lang') as Lang) || 'en');
  useEffect(() => {
    localStorage.setItem('sf_lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const value = {
    lang,
    setLang,
    t: (k: string) => (lang === 'ar' ? AR[k] ?? k : k),
    pick: (en: string, ar?: string | null) => (lang === 'ar' && ar ? ar : en),
    money: (v: number | string) => new Intl.NumberFormat(lang === 'ar' ? 'ar-JO' : 'en-JO', { style: 'currency', currency: 'JOD', minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Number(v)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------- cart (per tenant and branch, in localStorage)

export interface CartLine {
  key: string;
  menuItemId: string;
  name: string;
  nameAr: string | null;
  variantId?: string;
  variantName?: string;
  modifierIds: string[];
  modifierNames: string[];
  unitPrice: number; // tax-inclusive, includes variant and modifiers
  qty: number;
}

export function useCart(tenant: string, branchId: string) {
  const k = `sf_cart_${tenant}_${branchId}`;
  const read = (): CartLine[] => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? '[]');
    } catch {
      return [];
    }
  };
  const [lines, setLines] = useState<CartLine[]>(read);
  useEffect(() => setLines(read()), [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useCallback((next: CartLine[]) => {
    setLines(next);
    localStorage.setItem(k, JSON.stringify(next));
  }, [k]);
  const add = (l: Omit<CartLine, 'key'>) => {
    const key = `${l.menuItemId}|${l.variantId ?? ''}|${[...l.modifierIds].sort().join(',')}`;
    const cur = read();
    const hit = cur.find((x) => x.key === key);
    save(hit ? cur.map((x) => (x.key === key ? { ...x, qty: Math.min(50, x.qty + l.qty) } : x)) : [...cur, { ...l, key }]);
  };
  const setQty = (key: string, qty: number) => save(qty < 1 ? read().filter((x) => x.key !== key) : read().map((x) => (x.key === key ? { ...x, qty: Math.min(50, qty) } : x)));
  const clear = () => save([]);
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return { lines, add, setQty, clear, subtotal, count: lines.reduce((s, l) => s + l.qty, 0) };
}

export const recentCodes = {
  get: (): { tenant: string; code: string }[] => {
    try {
      return JSON.parse(localStorage.getItem('sf_recent') ?? '[]');
    } catch {
      return [];
    }
  },
  add: (tenant: string, code: string) => localStorage.setItem('sf_recent', JSON.stringify([{ tenant, code }, ...recentCodes.get().filter((r) => r.code !== code)].slice(0, 5))),
};
