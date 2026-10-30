// Deterministic scoring: the AI/rule engine scores each answer; the weights, scale and thresholds are configuration.
export interface RubricCompetency {
  key: string;
  name: string;
  weight: number;
  keywords?: string[];
}

export interface Rubric {
  scale: { min: number; max: number };
  competencies: RubricCompetency[];
  thresholds: { advance: number; review: number };
  maxFollowUps?: number;
}

export interface TemplateQuestion {
  id: string;
  text: string;
  textAr?: string;
  competency: string;
  weight?: number;
  minWords?: number;
}

export interface QuestionScore {
  questionId: string;
  competency: string;
  score: number;
  evidence: string[];
  reasoning: string;
}

export function validateTemplate(questions: unknown, rubric: unknown): string | null {
  const r = rubric as Rubric;
  if (!Array.isArray(questions) || !questions.length) return 'a template needs at least one question';
  if (!r || !r.scale || !(r.scale.max > r.scale.min)) return 'rubric.scale needs min < max';
  if (!Array.isArray(r.competencies) || !r.competencies.length) return 'rubric needs competencies';
  if (r.competencies.some((c) => !c.key || !(c.weight > 0))) return 'every competency needs a key and a positive weight';
  if (!r.thresholds || !(r.thresholds.advance > r.thresholds.review) || r.thresholds.review < r.scale.min) return 'thresholds need advance > review >= scale.min';
  const keys = new Set(r.competencies.map((c) => c.key));
  const ids = new Set<string>();
  for (const q of questions as TemplateQuestion[]) {
    if (!q.id || !q.text) return 'every question needs an id and text';
    if (ids.has(q.id)) return `duplicate question id ${q.id}`;
    ids.add(q.id);
    if (!keys.has(q.competency)) return `question ${q.id} references unknown competency '${q.competency}'`;
  }
  return null;
}

// Weighted mean across competencies (each competency's score is the mean of its questions), on the rubric's scale.
export function overallScore(scores: QuestionScore[], rubric: Rubric): number {
  let total = 0;
  let weights = 0;
  for (const c of rubric.competencies) {
    const mine = scores.filter((s) => s.competency === c.key);
    if (!mine.length) continue;
    total += (mine.reduce((s, x) => s + x.score, 0) / mine.length) * c.weight;
    weights += c.weight;
  }
  return weights ? Math.round((total / weights) * 100) / 100 : rubric.scale.min;
}

export function recommend(overall: number, rubric: Rubric): 'ADVANCE' | 'REVIEW' | 'DECLINE' {
  if (overall >= rubric.thresholds.advance) return 'ADVANCE';
  if (overall >= rubric.thresholds.review) return 'REVIEW';
  return 'DECLINE';
}
