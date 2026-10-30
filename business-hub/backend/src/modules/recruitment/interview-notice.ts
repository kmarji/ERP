export const INTERVIEW_NOTICE_VERSION = '2026-10-v1';

// What every candidate is told before an AI-assisted interview. Consent is requested only after this is shown.
export function interviewNotice(retentionMonths: number) {
  return {
    version: INTERVIEW_NOTICE_VERSION,
    en: [
      'This is an online interview in which an automated assistant asks you a fixed set of job-related questions. Every candidate for this position is asked the same questions.',
      'We record your written answers as a transcript. If you choose to, we also keep an audio recording. Recording is optional and does not affect how your answers are assessed.',
      'An automated tool assesses your answers against a published rubric and produces a recommendation with the evidence it used. It never rejects anyone by itself: a person reviews every case that is not clearly progressing, and every rejection is decided by a person.',
      'We do not assess age, gender, nationality, religion, marital status, health, accent or appearance.',
      `Your data is kept for ${retentionMonths} months unless you are hired, then deleted or anonymised.`,
      'Your rights: you may ask for a human interviewer instead, ask to see or erase your data, and appeal a rejection. Use the link on your application status page.',
    ],
    ar: [
      'هذه مقابلة عبر الإنترنت يطرح فيها مساعد آلي مجموعة ثابتة من الأسئلة المتعلقة بالوظيفة. يُطرح السؤال نفسه على جميع المتقدمين لهذه الوظيفة.',
      'نسجّل إجاباتك المكتوبة كنص. وإذا رغبت فقط، نحتفظ أيضاً بتسجيل صوتي. التسجيل اختياري ولا يؤثر على تقييم إجاباتك.',
      'تقوم أداة آلية بتقييم إجاباتك وفق معايير معلنة وتقدم توصية مع الأدلة التي استندت إليها. لا ترفض الأداة أي شخص بمفردها: يراجع موظف كل حالة لا تتقدم بوضوح، وكل رفض يقرره شخص.',
      'لا نقيّم العمر أو الجنس أو الجنسية أو الدين أو الحالة الاجتماعية أو الحالة الصحية أو اللهجة أو المظهر.',
      `تُحفظ بياناتك لمدة ${retentionMonths} أشهر ما لم يتم توظيفك، ثم تُحذف أو تُجهّل.`,
      'حقوقك: يمكنك طلب مقابلة مع شخص بدلاً من المساعد الآلي، وطلب الاطلاع على بياناتك أو حذفها، والاعتراض على الرفض من صفحة حالة طلبك.',
    ],
  };
}
