// Screening uses a closed list of objective, job-related criteria. Anything else (age, gender, nationality, religion,
// marital status, appearance, ...) cannot be configured, so it cannot be used to filter candidates (brief s10).
export const CRITERIA_TYPES = ['MIN_EXPERIENCE_YEARS', 'REQUIRED_SKILL', 'ANY_SKILL', 'LANGUAGE', 'WEEKEND_AVAILABILITY', 'NIGHT_AVAILABILITY', 'CERTIFICATION', 'LEGAL_WORK_ELIGIBILITY'] as const;
export type CriterionType = (typeof CRITERIA_TYPES)[number];

export interface Criterion {
  type: CriterionType;
  value?: number | string | string[] | boolean;
  label?: string;
}

export interface Intake {
  yearsExperience?: number;
  skills?: string[];
  languages?: string[];
  certifications?: string[];
  availability?: { weekends?: boolean; nights?: boolean };
  workAuthorization?: boolean; // the candidate's own confirmation that they may legally work; documents are verified later
  expectedSalary?: number;
  motivation?: string;
}

export interface CriterionResult {
  type: CriterionType;
  label: string;
  pass: boolean;
  detail: string;
}

export function validateCriteria(criteria: unknown): { ok: true; criteria: Criterion[] } | { ok: false; error: string } {
  if (!Array.isArray(criteria)) return { ok: false, error: 'criteria must be a list' };
  const out: Criterion[] = [];
  for (const c of criteria as any[]) {
    if (!c || typeof c.type !== 'string') return { ok: false, error: 'each criterion needs a type' };
    if (!(CRITERIA_TYPES as readonly string[]).includes(c.type)) {
      return { ok: false, error: `'${c.type}' is not an allowed screening criterion. Only objective, job-related criteria are permitted: ${CRITERIA_TYPES.join(', ')}` };
    }
    if (c.type === 'MIN_EXPERIENCE_YEARS' && !(typeof c.value === 'number' && c.value >= 0)) return { ok: false, error: 'MIN_EXPERIENCE_YEARS needs a non-negative number' };
    if (['REQUIRED_SKILL', 'LANGUAGE', 'CERTIFICATION'].includes(c.type) && typeof c.value !== 'string') return { ok: false, error: `${c.type} needs a text value` };
    if (c.type === 'ANY_SKILL' && !(Array.isArray(c.value) && c.value.every((v: unknown) => typeof v === 'string') && c.value.length)) return { ok: false, error: 'ANY_SKILL needs a list of skills' };
    out.push({ type: c.type, value: c.value, label: typeof c.label === 'string' ? c.label : undefined });
  }
  return { ok: true, criteria: out };
}

const norm = (s: string) => s.trim().toLowerCase();
const has = (list: string[] | undefined, v: string) => (list ?? []).some((x) => norm(x) === norm(v));

// Fields the candidate must provide before anything can be assessed.
export function missingFields(intake: Intake, requiredSkills: string[]): string[] {
  const missing: string[] = [];
  if (typeof intake.yearsExperience !== 'number' || intake.yearsExperience < 0) missing.push('yearsExperience');
  if (!Array.isArray(intake.languages) || !intake.languages.length) missing.push('languages');
  if (!intake.availability || typeof intake.availability !== 'object') missing.push('availability');
  if (typeof intake.workAuthorization !== 'boolean') missing.push('workAuthorization');
  if (requiredSkills.length && (!Array.isArray(intake.skills) || !intake.skills.length)) missing.push('skills');
  return missing;
}

export function screen(criteria: Criterion[], intake: Intake): { pass: boolean; results: CriterionResult[] } {
  const results = criteria.map<CriterionResult>((c) => {
    const label = c.label ?? c.type;
    switch (c.type) {
      case 'MIN_EXPERIENCE_YEARS': {
        const have = intake.yearsExperience ?? 0;
        return { type: c.type, label, pass: have >= (c.value as number), detail: `${have} year(s) of experience, ${c.value} required` };
      }
      case 'REQUIRED_SKILL':
        return { type: c.type, label, pass: has(intake.skills, c.value as string), detail: `requires skill '${c.value}'` };
      case 'ANY_SKILL': {
        const wanted = c.value as string[];
        return { type: c.type, label, pass: wanted.some((w) => has(intake.skills, w)), detail: `requires at least one of: ${wanted.join(', ')}` };
      }
      case 'LANGUAGE':
        return { type: c.type, label, pass: has(intake.languages, c.value as string), detail: `requires language '${c.value}'` };
      case 'WEEKEND_AVAILABILITY':
        return { type: c.type, label, pass: intake.availability?.weekends === true, detail: 'requires weekend availability' };
      case 'NIGHT_AVAILABILITY':
        return { type: c.type, label, pass: intake.availability?.nights === true, detail: 'requires night-shift availability' };
      case 'CERTIFICATION':
        return { type: c.type, label, pass: has(intake.certifications, c.value as string), detail: `requires certification '${c.value}'` };
      case 'LEGAL_WORK_ELIGIBILITY':
        return { type: c.type, label, pass: intake.workAuthorization === true, detail: 'candidate must confirm they may legally work (documents are verified before hiring)' };
    }
  });
  return { pass: results.every((r) => r.pass), results };
}
