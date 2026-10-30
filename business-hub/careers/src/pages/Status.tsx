import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Btn, Card, Err, Field, inputCls, Tags, useAsync, useLang } from '../lib';

interface View {
  vacancy: { title: string; titleAr?: string; branch: string };
  status: string;
  stage: { en: string; ar: string };
  anonymized: boolean;
  missing: string[];
  interview: { status: string; path: string; expiresAt: string; scheduledFor?: string } | null;
  offer: { status: string; startDate: string } | null;
  documents: { type: string; status: string; note: string | null }[];
  rejection: { reason: string | null; reasonAr: string | null; appealOpen: boolean; appealableUntil: string | null } | null;
  rights: { withdraw: boolean; erase: boolean; humanInterview: boolean };
}

const STEPS: [string, string, string[]][] = [
  ['Received', 'استلام', ['RECEIVED', 'INCOMPLETE']],
  ['Interview', 'مقابلة', ['SCREENED_OUT', 'SCREENED', 'INTERVIEW_INVITED', 'INTERVIEW_SCHEDULED']],
  ['Review', 'مراجعة', ['INTERVIEWED', 'UNDER_REVIEW', 'ADVANCED']],
  ['Offer', 'عرض', ['OFFER_PENDING']],
  ['Onboarding', 'تعيين', ['ONBOARDING']],
  ['Hired', 'تم التعيين', ['HIRED']],
];

export default function Status() {
  const { token = '' } = useParams();
  const { t, lang } = useLang();
  const v = useAsync(() => api<View>(`/apply/status/${token}`), [token]);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      v.reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (v.error) return <Err msg={v.error} />;
  const d = v.data;
  if (!d) return <p>…</p>;
  const active = STEPS.findIndex((s) => s[2].includes(d.status));
  const closed = ['REJECTED', 'WITHDRAWN'].includes(d.status);

  return (
    <div>
      <h1 className="text-xl font-semibold">{lang === 'ar' && d.vacancy.titleAr ? d.vacancy.titleAr : d.vacancy.title}</h1>
      <p className="mb-3 text-sm text-slate-600">{d.vacancy.branch}</p>
      <Err msg={err} />
      <Card>
        <p className="mb-3 text-lg font-medium text-brand-700" aria-live="polite">{lang === 'ar' ? d.stage.ar : d.stage.en}</p>
        {!closed && (
          <ol className="flex gap-1 text-xs" aria-label={t('Progress', 'التقدم')}>
            {STEPS.map((s, i) => (
              <li key={s[0]} aria-current={i === active ? 'step' : undefined} className={`flex-1 rounded px-1 py-2 text-center ${i <= active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{lang === 'ar' ? s[1] : s[0]}</li>
            ))}
          </ol>
        )}
      </Card>

      {d.missing.length > 0 && <Missing token={token} missing={d.missing} run={run} />}

      {d.interview && (
        <Card title={t('Online interview', 'المقابلة عبر الإنترنت')}>
          <p className="mb-2 text-sm">{t('Open the link to read how your answers are used, then decide. You may ask for a human interviewer instead.', 'افتح الرابط لتعرف كيف تُستخدم إجاباتك ثم قرر. يمكنك طلب مقابلة مع شخص بدلاً من ذلك.')}</p>
          <p className="mb-2 text-xs text-slate-500">{t('Valid until', 'صالح حتى')} {new Date(d.interview.expiresAt).toLocaleString()}</p>
          <Link to={d.interview.path} className="inline-block min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-white">{t('Go to the interview', 'الانتقال إلى المقابلة')}</Link>
        </Card>
      )}

      {d.offer && <Offer token={token} offer={d.offer} run={run} />}
      {d.documents.length > 0 && <Documents token={token} docs={d.documents} run={run} />}
      {d.status === 'ONBOARDING' && <Personal token={token} run={run} />}

      {d.rejection && (
        <Card title={t('Decision', 'القرار')}>
          <p className="mb-2">{(lang === 'ar' ? d.rejection.reasonAr : d.rejection.reason) ?? ''}</p>
          {d.rejection.appealOpen ? <p className="text-sm text-slate-600">{t('Your appeal is being reviewed by a different person.', 'اعتراضك قيد المراجعة من موظف آخر.')}</p> : d.rejection.appealableUntil && new Date(d.rejection.appealableUntil) > new Date() ? <Appeal token={token} until={d.rejection.appealableUntil} run={run} /> : null}
        </Card>
      )}

      <Card title={t('Your rights', 'حقوقك')}>
        <p className="mb-3 text-sm text-slate-600">{t('You can withdraw, ask for a human interviewer, see or erase your data, and appeal a rejection at any time.', 'يمكنك السحب أو طلب مقابلة مع شخص أو الاطلاع على بياناتك أو حذفها أو الاعتراض على الرفض في أي وقت.')}</p>
        <div className="flex flex-wrap gap-2">
          {d.rights.withdraw && <Btn variant="ghost" onClick={() => window.confirm(t('Withdraw your application?', 'سحب الطلب؟')) && run(() => api(`/apply/status/${token}/withdraw`, { method: 'POST' }))}>{t('Withdraw application', 'سحب الطلب')}</Btn>}
          {d.rights.erase && !d.anonymized && <Btn variant="danger" onClick={() => window.confirm(t('Erase your personal data permanently? This cannot be undone.', 'حذف بياناتك الشخصية نهائياً؟ لا يمكن التراجع.')) && run(() => api(`/apply/status/${token}/erase`, { method: 'POST' }))}>{t('Erase my data', 'حذف بياناتي')}</Btn>}
        </div>
        {d.anonymized && <p className="mt-2 text-sm text-slate-600">{t('Your personal data has been erased.', 'تم حذف بياناتك الشخصية.')}</p>}
        {!d.rights.erase && <p className="mt-2 text-xs text-slate-500">{t('Erasure is unavailable while you are being hired; contact HR.', 'الحذف غير متاح أثناء إجراءات التعيين؛ تواصل مع الموارد البشرية.')}</p>}
      </Card>
    </div>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;

function Missing({ token, missing, run }: { token: string; missing: string[]; run: Run }) {
  const { t } = useLang();
  const [y, setY] = useState('');
  const [langs, setLangs] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [we, setWe] = useState(false);
  const [ni, setNi] = useState(false);
  const [wa, setWa] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (missing.includes('yearsExperience')) patch.yearsExperience = Number(y);
    if (missing.includes('languages')) patch.languages = langs;
    if (missing.includes('skills')) patch.skills = skills;
    if (missing.includes('availability')) patch.availability = { weekends: we, nights: ni };
    if (missing.includes('workAuthorization')) patch.workAuthorization = wa;
    run(() => api(`/apply/status/${token}/intake`, { method: 'PUT', body: patch }));
  };
  return (
    <Card title={t('We need a little more information', 'نحتاج إلى معلومات إضافية')}>
      <form onSubmit={submit}>
        {missing.includes('yearsExperience') && <Field label={t('Years of experience', 'سنوات الخبرة')}><input required type="number" min={0} max={60} className={inputCls} value={y} onChange={(e) => setY(e.target.value)} /></Field>}
        {missing.includes('languages') && <Field label={t('Languages', 'اللغات')}><Tags value={langs} onChange={setLangs} /></Field>}
        {missing.includes('skills') && <Field label={t('Skills', 'المهارات')}><Tags value={skills} onChange={setSkills} /></Field>}
        {missing.includes('availability') && (
          <fieldset className="mb-3 text-sm">
            <legend className="font-medium">{t('Availability', 'التوفر')}</legend>
            <label className="me-4 inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={we} onChange={(e) => setWe(e.target.checked)} />{t('Weekends', 'عطلة نهاية الأسبوع')}</label>
            <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={ni} onChange={(e) => setNi(e.target.checked)} />{t('Night shifts', 'مناوبات ليلية')}</label>
          </fieldset>
        )}
        {missing.includes('workAuthorization') && <label className="mb-3 flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={wa} onChange={(e) => setWa(e.target.checked)} />{t('I confirm that I may legally work in Jordan.', 'أؤكد أنني مخوّل قانونياً بالعمل في الأردن.')}</label>}
        <Btn type="submit">{t('Update application', 'تحديث الطلب')}</Btn>
      </form>
    </Card>
  );
}

function Offer({ token, offer, run }: { token: string; offer: { status: string; startDate: string }; run: Run }) {
  const { t, lang } = useLang();
  const contract = useAsync(() => api<{ contractText: { en: string; ar: string } | null; salaryBasic: string; number: string }>(`/apply/status/${token}/offer`), [token, offer.status]);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [reason, setReason] = useState('');
  const c = contract.data;
  return (
    <Card title={t('Job offer', 'العرض الوظيفي')}>
      <Err msg={contract.error} />
      <p className="mb-2 text-sm">{t('Status', 'الحالة')}: <b>{offer.status}</b> · {t('Start date', 'تاريخ البدء')}: {String(offer.startDate).slice(0, 10)}</p>
      {c?.contractText && (
        // Contract HTML is rendered in a fully sandboxed frame: no scripts, no navigation.
        <iframe title={t('Contract', 'العقد')} sandbox="" srcDoc={lang === 'ar' ? c.contractText.ar : c.contractText.en} className="mb-3 h-80 w-full rounded border border-slate-200 bg-white" />
      )}
      {offer.status === 'SENT' && (
        <>
          <Field label={t('Type your full name as your signature', 'اكتب اسمك الكامل كتوقيع')}><input className={inputCls} minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <label className="mb-3 flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />{t('I have read the contract and accept this offer.', 'قرأت العقد وأقبل هذا العرض.')}</label>
          <Btn disabled={!agree || name.trim().length < 2} onClick={() => run(() => api(`/apply/status/${token}/offer/accept`, { body: { signatureName: name.trim(), agree: true } }))}>{t('Accept and sign', 'قبول وتوقيع')}</Btn>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <Field label={t('Or decline (tell us why)', 'أو الرفض (اذكر السبب)')}><input className={inputCls} minLength={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Btn variant="ghost" disabled={reason.trim().length < 2} onClick={() => run(() => api(`/apply/status/${token}/offer/decline`, { body: { reason: reason.trim() } }))}>{t('Decline offer', 'رفض العرض')}</Btn>
          </div>
        </>
      )}
    </Card>
  );
}

function Documents({ token, docs, run }: { token: string; docs: { type: string; status: string; note: string | null }[]; run: Run }) {
  const { t } = useLang();
  const upload = (type: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return run(() => api(`/apply/status/${token}/documents/${type}`, { form }));
  };
  return (
    <Card title={t('Documents', 'الوثائق')}>
      <ul className="divide-y divide-slate-100">
        {docs.map((d) => (
          <li key={d.type} className="py-3">
            <div className="flex items-center justify-between gap-2"><span className="font-medium">{d.type.replace(/_/g, ' ')}</span><span className={`rounded-full px-2 py-0.5 text-xs ${d.status === 'VERIFIED' ? 'bg-emerald-100 text-emerald-800' : d.status === 'REJECTED' ? 'bg-red-100 text-red-800' : 'bg-slate-100'}`}>{d.status}</span></div>
            {d.note && <p className="text-sm text-red-700">{d.note}</p>}
            {['REQUIRED', 'REJECTED'].includes(d.status) && (
              <label className="mt-2 block text-sm">
                <span className="sr-only">{t('Upload', 'رفع')} {d.type}</span>
                <input type="file" accept="image/*,application/pdf" className="block w-full text-sm" onChange={(e) => e.target.files?.[0] && upload(d.type, e.target.files[0])} />
              </label>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">{t('PDF or image, up to 10 MB.', 'ملف PDF أو صورة حتى 10 ميغابايت.')}</p>
    </Card>
  );
}

function Personal({ token, run }: { token: string; run: Run }) {
  const { t } = useLang();
  const [f, setF] = useState({ nationalId: '', dateOfBirth: '', address: '', iban: '' });
  const [sent, setSent] = useState(false);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Card title={t('Personal details (once)', 'البيانات الشخصية (مرة واحدة)')}>
      <p className="mb-3 text-sm text-slate-600">{t('These are stored encrypted and entered only once; HR uses them to create your employee file, so you will not be asked again.', 'تُحفظ هذه البيانات مشفّرة وتُدخل مرة واحدة فقط، وتستخدمها الموارد البشرية لإنشاء ملفك الوظيفي فلن نطلبها منك مجدداً.')}</p>
      <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/apply/status/${token}/personal-details`, { body: { nationalId: f.nationalId, dateOfBirth: f.dateOfBirth, address: f.address, ...(f.iban ? { iban: f.iban } : {}) } }); setSent(true); }); }}>
        <Field label={t('National ID number', 'الرقم الوطني')}><input required minLength={5} maxLength={30} autoComplete="off" className={inputCls} value={f.nationalId} onChange={(e) => set('nationalId', e.target.value)} /></Field>
        <Field label={t('Date of birth', 'تاريخ الميلاد')}><input required type="date" className={inputCls} value={f.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} /></Field>
        <Field label={t('Home address', 'عنوان السكن')}><input required minLength={5} maxLength={300} className={inputCls} value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label={t('IBAN for salary (optional)', 'رقم الحساب IBAN للراتب (اختياري)')}><input pattern="[A-Za-z0-9 ]{10,40}" className={inputCls} value={f.iban} onChange={(e) => set('iban', e.target.value)} /></Field>
        <Btn type="submit">{sent ? t('Saved. Submit again to replace', 'تم الحفظ. أرسل مجدداً للاستبدال') : t('Save details', 'حفظ البيانات')}</Btn>
      </form>
    </Card>
  );
}

function Appeal({ token, until, run }: { token: string; until: string; run: Run }) {
  const { t } = useLang();
  const [reason, setReason] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); run(() => api(`/apply/status/${token}/appeal`, { body: { reason } })); }}>
      <Field label={t('Appeal this decision', 'الاعتراض على القرار')} hint={`${t('Until', 'حتى')} ${new Date(until).toLocaleDateString()}`}>
        <textarea required minLength={10} maxLength={2000} rows={3} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Btn type="submit">{t('Submit appeal', 'إرسال الاعتراض')}</Btn>
    </form>
  );
}
