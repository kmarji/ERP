import { missingFields, screen, validateCriteria } from './screening';

describe('screening', () => {
  it('refuses criteria that would filter on protected characteristics', () => {
    for (const type of ['AGE', 'GENDER', 'NATIONALITY', 'RELIGION', 'MARITAL_STATUS', 'PHOTO']) {
      const r = validateCriteria([{ type, value: 'x' }]);
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain('objective, job-related');
    }
    expect(validateCriteria([{ type: 'MIN_EXPERIENCE_YEARS', value: 'two' }]).ok).toBe(false);
    expect(validateCriteria([{ type: 'MIN_EXPERIENCE_YEARS', value: 1 }, { type: 'ANY_SKILL', value: ['barista', 'cashier'] }]).ok).toBe(true);
  });

  it('reports exactly what is missing', () => {
    expect(missingFields({}, ['barista']).sort()).toEqual(['availability', 'languages', 'skills', 'workAuthorization', 'yearsExperience']);
    expect(missingFields({ yearsExperience: 0, languages: ['Arabic'], availability: {}, workAuthorization: false }, [])).toEqual([]);
  });

  it('evaluates each criterion with a human-readable reason', () => {
    const intake = { yearsExperience: 2, skills: ['Barista', 'POS'], languages: ['Arabic'], certifications: [], availability: { weekends: true, nights: false }, workAuthorization: true };
    const r = screen(
      [
        { type: 'MIN_EXPERIENCE_YEARS', value: 1 },
        { type: 'REQUIRED_SKILL', value: ' barista ' },
        { type: 'LANGUAGE', value: 'english' },
        { type: 'WEEKEND_AVAILABILITY' },
        { type: 'NIGHT_AVAILABILITY' },
        { type: 'CERTIFICATION', value: 'food handler' },
        { type: 'LEGAL_WORK_ELIGIBILITY' },
      ],
      intake,
    );
    expect(r.pass).toBe(false);
    expect(r.results.map((x) => x.pass)).toEqual([true, true, false, true, false, false, true]);
    expect(r.results[2].detail).toContain('english');
  });

  it('passes when there are no criteria', () => {
    expect(screen([], {}).pass).toBe(true);
  });
});
