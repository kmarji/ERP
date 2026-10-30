import { buildContract } from './contract';

const base = { employer: { name: 'Demo Cafe', taxNumber: '12345' }, candidateName: 'Sara <b>', position: { title: 'Barista', titleAr: 'باريستا' }, branch: 'Abdoun', salaryBasic: '450.000', allowances: [{ name: 'Transport', amount: 30 }], startDate: '2026-11-01', contractType: 'OPEN', probationMonths: 3, weeklyHours: '48' };

describe('contract text', () => {
  it('is bilingual, complete and escapes HTML', () => {
    const c = buildContract(base);
    for (const t of [c.en, c.ar]) {
      expect(t).toContain('Demo Cafe');
      expect(t).toContain('450.000');
      expect(t).toContain('2026-11-01');
      expect(t).toContain('Sara &lt;b&gt;');
    }
    expect(c.en).toContain('Transport: 30.000 JOD');
    expect(c.en).toContain('open-ended');
    expect(c.ar).toContain('باريستا');
    expect(c.ar).toContain('dir="rtl"');
  });

  it('states the end date for fixed-term contracts', () => {
    expect(buildContract({ ...base, contractType: 'FIXED_TERM', endDate: '2027-10-31' }).en).toContain('fixed term ending 2027-10-31');
  });
});
