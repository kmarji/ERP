import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Btn, Card, Err, Field, inputCls, Tags, useAsync, useLang } from '../lib';

interface Vacancy { code: string; title: string; titleAr?: string; branch: string; closesAt?: string; requiredSkills: string[]; screeningCriteria: { type: string; value?: unknown; label?: string }[] }

const DESC: Record<string, (v: unknown) => [string, string]> = {
  MIN_EXPERIENCE_YEARS: (v) => [`At least ${v} year(s) of experience`, `خبرة لا تقل عن ${v} سنة`],
  REQUIRED_SKILL: (v) => [`Skill: ${v}`, `المهارة: ${v}`],
  ANY_SKILL: (v) => [`At least one of: ${(v as string[]).join(', ')}`, `واحدة على الأقل من: ${(v as string[]).join('، ')}`],
  LANGUAGE: (v) => [`Language: ${v}`, `اللغة: ${v}`],
  WEEKEND_AVAILABILITY: () => ['Available on weekends', 'متاح في عطلة نهاية الأسبوع'],
  NIGHT_AVAILABILITY: () => ['Available for night shifts', 'متاح للمناوبات الليلية'],
  CERTIFICATION: (v) => [`Certification: ${v}`, `الشهادة: ${v}`],
  LEGAL_WORK_ELIGIBILITY: () => ['You confirm you may legally work (documents are checked before hiring)', 'تؤكد أنك مخوّل قانونياً بالعمل (يتم التحقق من الوثائق قبل التعيين)'],
};

export default function Jobs() {
  const { tenant = '', code } = useParams();
  const { t, lang } = useLang();
  const list = useAsync(() => api<Vacancy | Vacancy[]>(code ? `/careers/${tenant}/vacancies/${code}` : `/careers/${tenant}/vacancies`), [tenant, code]);

  if (list.error) return <Err msg={list.error} />;
  if (!list.data) return <p>…</p>;
  if (!code) {
    const rows = list.data as Vacancy[];
    return (
      <div>
        <h1 className="mb-3 text-xl font-semibold">{t('Open positions', 'الوظائف المتاحة')}</h1>
        {!rows.length && <p className="text-slate-500">{t('No open positions right now.', 'لا توجد وظائف متاحة حالياً.')}</p>}
        {rows.map((v) => (
          <Card key={v.code}>
            <Link className="text-lg font-medium text-brand-700 underline" to={`/${tenant}/${v.code}`}>{lang === 'ar' && v.titleAr ? v.titleAr : v.title}</Link>
            <p className="text-sm text-slate-600">{v.branch}</p>
          </Card>
        ))}
      </div>
    );
  }
  return <Detail tenant={tenant} v={list.data as Vacancy} />;
}

function Detail({ tenant, v }: { tenant: string; v: Vacancy }) {
  const { t, lang } = useLang();
  const [f, setF] = useState({ name: '', phone: '', email: '', consent: false, yearsExperience: '', workAuthorization: false, weekends: false, nights: false, expectedSalary: '', motivation: '' });
  const [skills, setSkills] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [certs, setCerts] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ trackingToken: string; stage: { en: string; ar: string } } | null>(null);
  const set = (k: string, val: unknown) => setF((p) => ({ ...p, [k]: val }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Only objective, job-related fields exist here; the server refuses anything else.
      const r = await api(`/careers/${tenant}/vacancies/${v.code}/apply`, {
        body: {
          name: f.name, phone: f.phone, ...(f.email ? { email: f.email } : {}), consent: f.consent,
          intake: {
            ...(f.yearsExperience !== '' ? { yearsExperience: Number(f.yearsExperience) } : {}),
            skills, languages, certifications: certs, availability: { weekends: f.weekends, nights: f.nights }, workAuthorization: f.workAuthorization,
            ...(f.expectedSalary ? { expectedSalary: Number(f.expectedSalary) } : {}), ...(f.motivation ? { motivation: f.motivation } : {}),
          },
        },
      });
      const saved = JSON.parse(localStorage.getItem('careers_tokens') ?? '[]');
      localStorage.setItem('careers_tokens', JSON.stringify([...saved, { token: r.trackingToken, title: v.title }]));
      setDone(r);
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const link = `/status/${done.trackingToken}`;
    return (
      <Card title={t('Application received', 'تم استلام الطلب')}>
        <p className="mb-2">{lang === 'ar' ? done.stage.ar : done.stage.en}</p>
        <p className="mb-3 text-sm text-slate-600">{t('Keep this link: it is how you follow your application. Do not share it.', 'احتفظ بهذا الرابط لمتابعة طلبك ولا تشاركه مع أحد.')}</p>
        <Link className="break-all text-brand-700 underline" to={link}>{window.location.origin}{link}</Link>
      </Card>
    );
  }
  return (
    <div>
      <h1 className="text-xl font-semibold">{lang === 'ar' && v.titleAr ? v.titleAr : v.title}</h1>
      <p className="mb-3 text-sm text-slate-600">{v.branch}</p>
      <Card title={t('What we check', 'ما الذي نتحقق منه')}>
        <p className="mb-2 text-sm text-slate-600">{t('Applications are screened only against these job-related points. A person reviews anyone who does not match.', 'يتم فرز الطلبات وفق هذه النقاط المتعلقة بالوظيفة فقط، ويراجع موظف كل طلب غير مطابق.')}</p>
        <ul className="list-disc ps-5 text-sm">
          {v.screeningCriteria.map((c, i) => <li key={i}>{c.label ?? (DESC[c.type]?.(c.value)[lang === 'ar' ? 1 : 0] ?? c.type)}</li>)}
          {!v.screeningCriteria.length && <li>{t('No minimum requirements', 'لا توجد متطلبات دنيا')}</li>}
        </ul>
      </Card>
      <form onSubmit={submit}>
        <Card title={t('Apply', 'قدّم الآن')}>
          <Err msg={err} />
          <Field label={t('Full name', 'الاسم الكامل')}><input required minLength={2} maxLength={100} className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('Phone', 'رقم الهاتف')}><input required type="tel" minLength={7} maxLength={20} className={inputCls} value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label={t('Email (optional)', 'البريد الإلكتروني (اختياري)')}><input type="email" className={inputCls} value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label={t('Years of experience', 'سنوات الخبرة')}><input required type="number" min={0} max={60} className={inputCls} value={f.yearsExperience} onChange={(e) => set('yearsExperience', e.target.value)} /></Field>
          <Field label={t('Skills (comma separated)', 'المهارات (مفصولة بفواصل)')} hint={v.requiredSkills.length ? `${t('Needed', 'مطلوب')}: ${v.requiredSkills.join(', ')}` : undefined}><Tags value={skills} onChange={setSkills} /></Field>
          <Field label={t('Languages', 'اللغات')}><Tags value={languages} onChange={setLanguages} /></Field>
          <Field label={t('Certifications (optional)', 'الشهادات (اختياري)')}><Tags value={certs} onChange={setCerts} /></Field>
          <fieldset className="mb-3 text-sm">
            <legend className="mb-1 font-medium text-slate-700">{t('Availability', 'التوفر')}</legend>
            <label className="me-4 inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={f.weekends} onChange={(e) => set('weekends', e.target.checked)} />{t('Weekends', 'عطلة نهاية الأسبوع')}</label>
            <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={f.nights} onChange={(e) => set('nights', e.target.checked)} />{t('Night shifts', 'مناوبات ليلية')}</label>
          </fieldset>
          <label className="mb-3 flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.workAuthorization} onChange={(e) => set('workAuthorization', e.target.checked)} />{t('I confirm that I may legally work in Jordan (documents are verified before hiring).', 'أؤكد أنني مخوّل قانونياً بالعمل في الأردن (يتم التحقق من الوثائق قبل التعيين).')}</label>
          <Field label={t('Expected salary, JOD (optional)', 'الراتب المتوقع بالدينار (اختياري)')}><input type="number" min={0} className={inputCls} value={f.expectedSalary} onChange={(e) => set('expectedSalary', e.target.value)} /></Field>
          <Field label={t('Why this role? (optional)', 'لماذا هذه الوظيفة؟ (اختياري)')}><textarea maxLength={1000} rows={3} className={inputCls} value={f.motivation} onChange={(e) => set('motivation', e.target.value)} /></Field>
          <label className="mb-3 flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-sm">
            <input type="checkbox" required className="mt-1" checked={f.consent} onChange={(e) => set('consent', e.target.checked)} />
            <span>{t('I agree that my details are processed to assess this application. They are kept for a limited time and I can withdraw, ask for a human interviewer, or erase my data at any time from my status page.', 'أوافق على معالجة بياناتي لتقييم هذا الطلب. تُحفظ لمدة محدودة ويمكنني السحب أو طلب مقابلة مع شخص أو حذف بياناتي في أي وقت من صفحة حالة الطلب.')}</span>
          </label>
          <Btn type="submit" disabled={busy} className="w-full">{t('Submit application', 'إرسال الطلب')}</Btn>
        </Card>
      </form>
    </div>
  );
}
