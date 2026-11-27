import { overtimeMinutes } from './overtime';

const rules = { dailyThresholdMinutes: 480, weeklyThresholdMinutes: 2880 };

describe('overtimeMinutes', () => {
  it('counts daily excess without counting it again weekly', () => expect(overtimeMinutes([600, 600, 600, 600, 600], rules)).toEqual([120, 120, 120, 120, 120]));
  it('counts the weekly excess once the week passes the threshold', () => expect(overtimeMinutes([480, 480, 480, 480, 480, 480, 480], rules)).toEqual([0, 0, 0, 0, 0, 0, 480]));
});
