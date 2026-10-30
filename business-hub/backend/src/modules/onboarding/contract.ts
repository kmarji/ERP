const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ContractInput {
  employer: { name: string; taxNumber?: string | null };
  candidateName: string;
  position: { title: string; titleAr?: string | null };
  branch: string;
  salaryBasic: string;
  allowances: { name: string; amount: number }[];
  startDate: string;
  endDate?: string | null;
  contractType: string;
  probationMonths: number;
  weeklyHours: string;
}

// Bilingual contract draft. ponytail: fixed template; add per-tenant template editing + legal review when counsel provides wording.
export function buildContract(i: ContractInput): { en: string; ar: string } {
  const allow = i.allowances.map((a) => `${esc(a.name)}: ${a.amount.toFixed(3)} JOD`);
  const termEn = i.contractType === 'FIXED_TERM' ? `fixed term ending ${esc(i.endDate)}` : 'open-ended';
  const termAr = i.contractType === 'FIXED_TERM' ? `محدد المدة وينتهي في ${esc(i.endDate)}` : 'غير محدد المدة';
  const en = `<html dir="ltr"><body><h1>Employment Contract</h1>
<p>Employer: <b>${esc(i.employer.name)}</b> (tax no. ${esc(i.employer.taxNumber ?? 'n/a')})</p>
<p>Employee: <b>${esc(i.candidateName)}</b></p>
<p>Position: ${esc(i.position.title)} at ${esc(i.branch)}. Start date: ${esc(i.startDate)}. Term: ${termEn}.</p>
<p>Basic salary: ${esc(i.salaryBasic)} JOD per month. ${allow.length ? `Allowances: ${allow.join('; ')}.` : ''}</p>
<p>Probation: ${i.probationMonths} month(s). Working hours: ${esc(i.weeklyHours)} per week.</p>
<p>Employer signature: ______________ &nbsp; Employee signature: ______________</p></body></html>`;
  const ar = `<html dir="rtl"><body><h1>عقد عمل</h1>
<p>صاحب العمل: <b>${esc(i.employer.name)}</b> (الرقم الضريبي ${esc(i.employer.taxNumber ?? 'غير متوفر')})</p>
<p>الموظف: <b>${esc(i.candidateName)}</b></p>
<p>الوظيفة: ${esc(i.position.titleAr ?? i.position.title)} في ${esc(i.branch)}. تاريخ المباشرة: ${esc(i.startDate)}. مدة العقد: ${termAr}.</p>
<p>الراتب الأساسي: ${esc(i.salaryBasic)} دينار شهريا. ${allow.length ? `البدلات: ${allow.join('؛ ')}.` : ''}</p>
<p>فترة التجربة: ${i.probationMonths} شهر. ساعات العمل: ${esc(i.weeklyHours)} أسبوعيا.</p>
<p>توقيع صاحب العمل: ______________ &nbsp; توقيع الموظف: ______________</p></body></html>`;
  return { en, ar };
}
