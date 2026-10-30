import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Btn, Card, Err, inputCls, useAsync, useLang } from '../lib';

interface Notice {
  status: string;
  questions: number;
  estimatedMinutes: number;
  expiresAt: string;
  consentGiven: boolean;
  notice: { version: string; en: string[]; ar: string[] };
}
interface Q { done: boolean; followUp?: boolean; index?: number; total?: number; question?: string }
interface Msg { role: 'AI' | 'ME'; text: string }

export default function Interview() {
  const { token = '' } = useParams();
  const { t, lang } = useLang();
  const n = useAsync(() => api<Notice>(`/apply/interview/${token}`), [token]);
  const [err, setErr] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(() => sessionStorage.getItem(`rec-${token}`) === '1');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [cur, setCur] = useState<Q | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [human, setHuman] = useState(false);
  const [finished, setFinished] = useState(false);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const show = (q: Q) => {
    setCur(q);
    if (q.done) setFinished(true);
    else if (q.question) setMsgs((m) => [...m, { role: 'AI', text: q.question! }]);
  };

  if (n.error) return <Err msg={n.error} />;
  const d = n.data;
  if (!d) return <p>…</p>;

  const requestHuman = () => window.confirm(t('Ask for a human interviewer instead of the automated assistant?', 'طلب مقابلة مع شخص بدلاً من المساعد الآلي؟')) && guard(async () => { await api(`/apply/interview/${token}/request-human`, { method: 'POST' }); setHuman(true); });
  const humanBtn = !human && !finished && !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(d.status) && (
    <Btn variant="ghost" className="w-full border-brand-600 text-brand-700" onClick={requestHuman} disabled={busy}>{t('I would like a human interviewer instead', 'أفضّل مقابلة مع شخص')}</Btn>
  );

  if (human) return <Card title={t('Request received', 'تم استلام الطلب')}><p>{t('A recruiter will contact you to arrange an interview with a person. Nothing about this affects your application.', 'سيتواصل معك موظف التوظيف لترتيب مقابلة مع شخص. هذا لا يؤثر على طلبك.')}</p></Card>;
  if (finished || d.status === 'COMPLETED') return <Card title={t('Thank you', 'شكراً لك')}><p className="mb-3">{t('You have completed the interview. A person reviews every case and we will be in touch about the next step.', 'أكملت المقابلة. يراجع موظف كل حالة وسنتواصل معك بشأن الخطوة التالية.')}</p><StatusLink /></Card>;
  if (['CANCELLED', 'EXPIRED'].includes(d.status)) return <Card title={t('Interview unavailable', 'المقابلة غير متاحة')}><p className="mb-3">{d.status === 'EXPIRED' ? t('This invitation has expired. A recruiter will contact you.', 'انتهت صلاحية الدعوة. سيتواصل معك موظف التوظيف.') : t('This interview was cancelled.', 'تم إلغاء هذه المقابلة.')}</p><StatusLink /></Card>;

  // 1. notice and consent
  if (!d.consentGiven) {
    const first = lang === 'ar' ? d.notice.ar : d.notice.en;
    const second = lang === 'ar' ? d.notice.en : d.notice.ar;
    return (
      <div>
        <h1 className="mb-1 text-xl font-semibold">{t('Before we begin', 'قبل أن نبدأ')}</h1>
        <p className="mb-3 text-sm text-slate-600">{d.questions} {t('questions, about', 'أسئلة، حوالي')} {d.estimatedMinutes} {t('minutes', 'دقيقة')}</p>
        <Card title={t('How your answers are used', 'كيف تُستخدم إجاباتك')}>
          <ul className="list-disc space-y-2 ps-5 text-sm">{first.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <details className="mt-3 text-sm text-slate-600"><summary className="cursor-pointer">{t('Same notice in the other language', 'الإشعار نفسه باللغة الأخرى')}</summary><ul dir={lang === 'ar' ? 'ltr' : 'rtl'} className="mt-2 list-disc space-y-2 ps-5 pe-5">{second.map((p, i) => <li key={i}>{p}</li>)}</ul></details>
          <p className="mt-3 text-xs text-slate-500">{t('Notice version', 'نسخة الإشعار')}: {d.notice.version}</p>
        </Card>
        <Err msg={err} />
        <Card>
          <label className="mb-3 flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={processing} onChange={(e) => setProcessing(e.target.checked)} />{t('I agree that my answers are recorded as a transcript and assessed as described above. (required)', 'أوافق على تسجيل إجاباتي كنص وتقييمها كما هو موضح أعلاه. (مطلوب)')}</label>
          <label className="mb-4 flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={recording} onChange={(e) => setRecording(e.target.checked)} />{t('Optional: I also agree to an audio recording. It does not affect how my answers are assessed.', 'اختياري: أوافق أيضاً على التسجيل الصوتي. لا يؤثر ذلك على تقييم إجاباتي.')}</label>
          <Btn className="w-full" disabled={!processing || busy} onClick={() => guard(async () => { await api(`/apply/interview/${token}/consent`, { body: { processing: true, recording, noticeVersion: d.notice.version } }); sessionStorage.setItem(`rec-${token}`, recording ? '1' : '0'); n.reload(); })}>{t('I agree, continue', 'أوافق، متابعة')}</Btn>
        </Card>
        {humanBtn}
      </div>
    );
  }

  // 2. ready to start
  if (!cur) {
    return (
      <div>
        <Err msg={err} />
        <Card title={t('Ready when you are', 'جاهز عندما تكون جاهزاً')}>
          <p className="mb-3 text-sm">{t('Answer in your own words. There is no rush, and you can answer in Arabic or English.', 'أجب بكلماتك الخاصة. لا داعي للعجلة ويمكنك الإجابة بالعربية أو الإنجليزية.')}</p>
          <Btn className="w-full" disabled={busy} onClick={() => guard(async () => { show(await api<Q>(`/apply/interview/${token}/start`, { method: 'POST' })); })}>{d.status === 'IN_PROGRESS' ? t('Continue the interview', 'متابعة المقابلة') : t('Start the interview', 'بدء المقابلة')}</Btn>
        </Card>
        {humanBtn}
      </div>
    );
  }

  // 3. chat
  const send = () => guard(async () => {
    const answer = text.trim();
    setMsgs((m) => [...m, { role: 'ME', text: answer }]);
    setText('');
    show(await api<Q>(`/apply/interview/${token}/answer`, { body: { text: answer } }));
  });
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm text-slate-600">
        <span>{t('Question', 'السؤال')} {cur.index}/{cur.total}</span>
        <progress className="h-2 w-40" value={(cur.index ?? 1) - 1} max={cur.total ?? 1} aria-label={t('Progress', 'التقدم')} />
      </div>
      <div className="mb-3 space-y-2" aria-live="polite">
        {msgs.map((m, i) => (
          <p key={i} className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${m.role === 'AI' ? 'bg-brand-50 text-slate-900' : 'ms-auto bg-brand-600 text-white'}`}>{m.text}</p>
        ))}
      </div>
      <Err msg={err} />
      <label className="block text-sm"><span className="sr-only">{t('Your answer', 'إجابتك')}</span>
        <textarea rows={5} maxLength={2000} className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Type your answer…', 'اكتب إجابتك…')} />
      </label>
      <div className="mb-3 mt-1 text-end text-xs text-slate-500">{text.length}/2000</div>
      <Btn className="mb-3 w-full" disabled={busy || !text.trim()} onClick={send}>{t('Send answer', 'إرسال الإجابة')}</Btn>
      {recording && <Recorder token={token} />}
      {humanBtn}
    </div>
  );
}

const StatusLink = () => {
  const { t } = useLang();
  return <Link className="text-brand-700 underline" to="/" onClick={(e) => { e.preventDefault(); window.history.back(); }}>{t('Back', 'رجوع')}</Link>;
};

// Optional audio recording, uploaded as one file; the interview works the same if recording is unavailable.
function Recorder({ token }: { token: string }) {
  const { t } = useLang();
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [state, setState] = useState<'idle' | 'recording' | 'saved' | 'unavailable'>(typeof MediaRecorder === 'undefined' || !navigator.mediaDevices ? 'unavailable' : 'idle');
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((x) => x.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('file', new File([blob], 'interview.webm', { type: blob.type || 'audio/webm' }));
        try {
          await api(`/apply/interview/${token}/recording`, { form });
          setState('saved');
        } catch (e: any) {
          setErr(e.message);
          setState('idle');
        }
      };
      r.start();
      rec.current = r;
      setState('recording');
    } catch {
      setState('unavailable');
    }
  };
  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <p className="mb-2 font-medium">{t('Audio recording (optional)', 'التسجيل الصوتي (اختياري)')}</p>
      <Err msg={err} />
      {state === 'unavailable' && <p className="text-slate-600">{t('Recording is not available on this device. You can continue with typed answers only.', 'التسجيل غير متاح على هذا الجهاز. يمكنك المتابعة بالإجابات المكتوبة فقط.')}</p>}
      {state === 'idle' && <Btn variant="ghost" onClick={start}>{t('Start recording', 'بدء التسجيل')}</Btn>}
      {state === 'recording' && <Btn variant="danger" onClick={() => rec.current?.stop()}>{t('Stop and save', 'إيقاف وحفظ')}</Btn>}
      {state === 'saved' && <p className="text-emerald-700">{t('Recording saved.', 'تم حفظ التسجيل.')}</p>}
    </div>
  );
}
