// Candidate answers are untrusted text that will be read by an automated assessor. Attempts to steer it are flagged so
// a person always reviews that application. This is a tripwire, not a defence on its own: the assessor's output only
// ever feeds a recommendation, and nobody is rejected by the AI.
const PATTERNS: RegExp[] = [
  /ignore\s+(all|any|the|your|previous|prior|above)\s+(previous\s+|prior\s+)?(instructions?|prompts?|rules?)/i,
  /disregard\s+(all|any|the|your|previous|prior)/i,
  /(system|developer)\s+(prompt|message|instruction)/i,
  /you\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|chatgpt|language model|evaluator|grader)/i,
  /(give|assign|award|rate)\s+(me\s+)?(a\s+)?(score\s+of\s+)?(5|five|10|ten|full|perfect|maximum|max|highest)/i,
  /\b(score|rate)\s+(me|this)\s+(5|five|10|ten|highest|perfect|maximum)/i,
  /recommend\s+(me\s+)?(for\s+)?(hire|hiring|advance)/i,
  /تجاهل\s+(كل\s+)?(التعليمات|الأوامر)/,
];

export function detectInjection(text: string): string[] {
  return PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 40));
}
