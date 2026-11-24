// A salary or employment certificate, English and Arabic side by side. Rendered from the figures frozen when HR approved it.
const jod = (v: string) => `${v} JOD`;

export default function Letter({ l }: { l: any }) {
  const c = l.content;
  const salary = l.kind === 'SALARY' && c.salary;
  return (
    <div className="receipt mx-auto max-w-2xl bg-white p-8 text-sm leading-7 text-slate-900 shadow">
      <div className="mb-6 flex items-start justify-between">
        <div className="text-lg font-semibold">{c.company}</div>
        <div className="text-end text-xs text-slate-500">Ref {l.number}<br />{c.issuedAt}</div>
      </div>
      <p className="mb-4 font-medium">To: {l.addressee}{l.purpose ? ` (${l.purpose})` : ''}</p>
      <h2 className="mb-3 text-center text-base font-bold">{l.kind === 'SALARY' ? 'SALARY CERTIFICATE' : 'EMPLOYMENT CERTIFICATE'}</h2>
      <p>
        This is to certify that <b>{c.employeeName}</b> (employee no. {c.employeeNumber}) has been employed by {c.company} since {c.hireDate}
        {c.position ? <> as <b>{c.position}</b></> : null}{c.contractType ? ` on a ${c.contractType.toLowerCase()} contract` : ''} and is currently in active service.
        {salary ? <> Their monthly salary is <b>{jod(salary.total)}</b> (basic {jod(salary.basic)}{Number(salary.allowances) > 0 ? ` plus allowances ${jod(salary.allowances)}` : ''}).</> : null}
      </p>
      <p className="mt-2">This letter is issued at the employee's request and carries no liability for the company.</p>
      <hr className="my-5" />
      <div dir="rtl" lang="ar" className="text-right">
        <h2 className="mb-3 text-center text-base font-bold">{l.kind === 'SALARY' ? 'شهادة راتب' : 'شهادة عمل'}</h2>
        <p>
          نشهد بأن <b>{c.employeeNameAr || c.employeeName}</b> (الرقم الوظيفي {c.employeeNumber}) يعمل لدى {c.company} منذ {c.hireDate}
          {c.positionAr || c.position ? <> بوظيفة <b>{c.positionAr || c.position}</b></> : null} وهو على رأس عمله حتى تاريخه.
          {salary ? <> ويبلغ راتبه الشهري <b>{jod(salary.total)}</b> (أساسي {jod(salary.basic)}{Number(salary.allowances) > 0 ? ` وبدلات ${jod(salary.allowances)}` : ''}).</> : null}
        </p>
        <p className="mt-2">أُعطيت هذه الشهادة بناءً على طلبه دون أدنى مسؤولية على الشركة.</p>
      </div>
      <p className="mt-10 text-xs text-slate-500">Human Resources / الموارد البشرية</p>
    </div>
  );
}
