import { addMonths, employmentPeriod } from './profile';

const on = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe('addMonths', () => {
  it('adds calendar months and clamps to the end of a shorter month', () => {
    expect(addMonths(on('2026-08-09'), 3)).toEqual(on('2026-11-09'));
    expect(addMonths(on('2026-01-31'), 1)).toEqual(on('2026-02-28'));
    expect(addMonths(on('2026-11-30'), 3)).toEqual(on('2027-02-28'));
  });
});

describe('employmentPeriod', () => {
  it.each([
    ['2026-08-09', '2026-11-26', { years: 0, months: 3, days: 17 }],
    ['2025-01-31', '2026-03-01', { years: 1, months: 1, days: 1 }],
    ['2027-01-01', '2026-11-26', { years: 0, months: 0, days: 0 }],
  ])('%s to %s', (from, to, want) => expect(employmentPeriod(on(from), on(to))).toEqual(want));
});
