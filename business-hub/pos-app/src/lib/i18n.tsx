import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

type Lang = 'en' | 'ar';

const ar: Record<string, string> = {
  'Sign in': 'تسجيل الدخول',
  'Sign out': 'تسجيل الخروج',
  Home: 'الرئيسية',
  'New order': 'طلب جديد',
  'Open orders': 'الطلبات المفتوحة',
  Refund: 'استرجاع',
  Kitchen: 'المطبخ',
  'Offline sales': 'مبيعات دون اتصال',
  Shift: 'الوردية',
  Order: 'الطلب',
  Send: 'إرسال للمطبخ',
  Hold: 'تعليق',
  Pay: 'دفع',
  Total: 'المجموع',
  Subtotal: 'المجموع الفرعي',
  Discount: 'خصم',
  'Includes tax': 'شامل الضريبة',
  Tax: 'الضريبة',
  Cash: 'نقدي',
  Card: 'بطاقة',
  Digital: 'محفظة',
  'Gift card': 'بطاقة هدية',
  Due: 'المستحق',
  Change: 'الباقي',
  Complete: 'إتمام',
  Print: 'طباعة',
  Cancel: 'إلغاء',
  Add: 'إضافة',
  Save: 'حفظ',
  Void: 'إلغاء السطر',
  Table: 'الطاولة',
  Customer: 'الزبون',
  Voucher: 'قسيمة',
  Points: 'نقاط',
  Split: 'تقسيم الفاتورة',
  Notes: 'ملاحظات',
  Start: 'بدء',
  Ready: 'جاهز',
  Bump: 'تسليم',
  Recall: 'استدعاء',
  Online: 'متصل',
  Offline: 'دون اتصال',
  'Sync now': 'مزامنة الآن',
  Reason: 'السبب',
  'Open shift': 'فتح وردية',
  'Close shift': 'إغلاق الوردية',
  'Opening float': 'العهدة الافتتاحية',
  'Counted cash': 'النقد المعدود',
  'Cash drop': 'إيداع نقدي',
  Dine_in: 'داخل المطعم',
  Takeaway: 'سفري',
  Pickup: 'استلام',
  Delivery: 'توصيل',
  Receipt: 'إيصال',
  'Manager approval': 'موافقة المدير',
  Email: 'البريد الإلكتروني',
  Password: 'كلمة المرور',
  Business: 'النشاط',
  Branch: 'الفرع',
  Device: 'الجهاز',
};

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string; nameOf: (o: { name: string; nameAr?: string | null }) => string }>({
  lang: 'en',
  setLang: () => {},
  t: (k) => k,
  nameOf: (o) => o.name,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('pos.lang') as Lang) || 'en');
  useEffect(() => {
    localStorage.setItem('pos.lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const t = (k: string) => (lang === 'ar' ? ar[k] ?? k : k);
  const nameOf = (o: { name: string; nameAr?: string | null }) => (lang === 'ar' && o.nameAr ? o.nameAr : o.name);
  return <Ctx.Provider value={{ lang, setLang, t, nameOf }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
