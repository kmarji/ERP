import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

type Lang = 'en' | 'ar';

// Strings used across screens. Unknown keys fall back to English, then to the key itself.
const dict: Record<Lang, Record<string, string>> = {
  en: {},
  ar: {
    'Owner home': 'الصفحة الرئيسية للمالك',
    'Exceptions': 'الاستثناءات',
    'Approvals': 'الموافقات',
    'Policies': 'السياسات',
    'Audit trail': 'سجل التدقيق',
    'Sign in': 'تسجيل الدخول',
    'Sign out': 'تسجيل الخروج',
    'Decisions needing you': 'قرارات تحتاج إلى موافقتك',
    'Completed automatically': 'أُنجز تلقائياً',
    'Business health': 'مؤشرات الأداء',
    'Nothing needs your attention': 'لا شيء يتطلب انتباهك',
  },
};

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string }>({
  lang: 'en',
  setLang: () => {},
  t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('bh_lang') as Lang) || 'en');
  useEffect(() => {
    localStorage.setItem('bh_lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const t = (k: string) => dict[lang][k] ?? k;
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
