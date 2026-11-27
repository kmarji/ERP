import { weekBounds } from './common';

const week = (day: string, startsOn?: number) => {
  const w = weekBounds(new Date(`${day}T00:00:00Z`), startsOn);
  return [w.start.toISOString().slice(0, 10), w.end.toISOString().slice(0, 10)];
};

describe('weekBounds', () => {
  it('starts on Monday unless told otherwise', () => expect(week('2026-11-26')).toEqual(['2026-11-23', '2026-11-29']));
  it('follows the company start day', () => {
    expect(week('2026-11-26', 6)).toEqual(['2026-11-21', '2026-11-27']);
    expect(week('2026-11-26', 0)).toEqual(['2026-11-22', '2026-11-28']);
  });
  it('keeps the start day in its own week', () => expect(week('2026-11-21', 6)).toEqual(['2026-11-21', '2026-11-27']));
});
