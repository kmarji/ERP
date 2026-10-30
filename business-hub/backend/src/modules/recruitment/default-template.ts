import { Rubric, TemplateQuestion } from './rubric';

// A starting point for front-of-house roles. Every candidate for a vacancy gets the same questions and rubric.
export function defaultTemplate(language: 'en' | 'ar'): { name: string; language: string; questions: TemplateQuestion[]; rubric: Rubric } {
  return {
    name: language === 'ar' ? 'مقابلة خدمة العملاء (افتراضي)' : 'Front-of-house interview (default)',
    language,
    questions: [
      { id: 'q1', competency: 'service', minWords: 20, text: 'Tell me about a time you dealt with a difficult or upset customer. What did you do and what was the result?', textAr: 'حدثني عن موقف تعاملت فيه مع زبون غاضب أو منزعج. ماذا فعلت وما كانت النتيجة؟' },
      { id: 'q2', competency: 'teamwork', minWords: 20, text: 'Describe a very busy period where you had to work closely with a team. How did you contribute?', textAr: 'صف فترة عمل مزدحمة كان عليك فيها العمل مع فريق. كيف ساهمت؟' },
      { id: 'q3', competency: 'reliability', minWords: 15, text: 'How do you make sure you arrive on time and cover the shifts you are scheduled for? Please give an example.', textAr: 'كيف تضمن الحضور في الموعد وتغطية المناوبات المجدولة لك؟ أعطني مثالاً.' },
      { id: 'q4', competency: 'hygiene', minWords: 15, text: 'What steps do you take to keep food and your work area safe and clean?', textAr: 'ما الخطوات التي تتبعها للحفاظ على سلامة الطعام ونظافة مكان العمل؟' },
    ],
    rubric: {
      scale: { min: 0, max: 5 },
      competencies: [
        { key: 'service', name: 'Customer service', weight: 3, keywords: ['listen', 'apolog', 'solution', 'calm', 'resolve', 'replace', 'refund', 'empath', 'استمع', 'اعتذر', 'حل', 'هدأ', 'تعويض'] },
        { key: 'teamwork', name: 'Teamwork', weight: 2, keywords: ['team', 'help', 'coordinate', 'communicat', 'support', 'together', 'share', 'فريق', 'ساعد', 'تعاون', 'نسق'] },
        { key: 'reliability', name: 'Reliability', weight: 2, keywords: ['on time', 'schedule', 'early', 'plan', 'reliab', 'notify', 'shift', 'موعد', 'مبكر', 'التزم', 'جدول'] },
        { key: 'hygiene', name: 'Food safety and hygiene', weight: 2, keywords: ['wash', 'glove', 'clean', 'sanitiz', 'temperature', 'expir', 'allergen', 'hygien', 'غسل', 'قفاز', 'نظاف', 'تعقيم', 'حرارة'] },
      ],
      thresholds: { advance: 3.5, review: 2.5 },
      maxFollowUps: 2,
    },
  };
}
