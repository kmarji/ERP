import { dueSlots } from './food-safety.service';

const at = (hhmm: string) => new Date(`2026-11-24T${hhmm}:00+03:00`);

describe('food safety schedule', () => {
  it('flags only slots that have passed without a reading', () => {
    expect(dueSlots(['08:00', '12:00', '16:00'], [], at('12:10'))).toEqual(['08:00', '12:00']);
    expect(dueSlots(['08:00', '12:00', '16:00'], [at('08:05')], at('12:10'))).toEqual(['12:00']);
  });
  it('one late reading does not cover every earlier slot', () => {
    expect(dueSlots(['08:00', '12:00'], [at('12:05')], at('12:10'))).toEqual(['08:00']);
  });
  it('an early reading within 30 minutes counts', () => {
    expect(dueSlots(['08:00'], [at('07:40')], at('08:10'))).toEqual([]);
  });
});
