import { alertStage, permitStatus } from './work-permit';

const today = new Date('2026-11-26T00:00:00.000Z');
const e = (over: Partial<Parameters<typeof permitStatus>[0]> = {}) => ({ status: 'ACTIVE', needsWorkPermit: true, workPermitNumber: 'WP-1' as string | null, workPermitExpiry: null as Date | null, ...over });
const on = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe('permitStatus', () => {
  it('shows nothing when no permit is needed or the employee left', () => {
    expect(permitStatus(e({ needsWorkPermit: false }), today)).toBeNull();
    expect(permitStatus(e({ status: 'TERMINATED' }), today)).toBeNull();
  });
  it('is incomplete without number or expiry', () => {
    expect(permitStatus(e({ workPermitNumber: null }), today)).toEqual({ state: 'INCOMPLETE', daysLeft: null });
    expect(permitStatus(e({ workPermitNumber: null, workPermitExpiry: on('2026-12-06') }), today)).toEqual({ state: 'INCOMPLETE', daysLeft: 10 });
  });
  it('expired wins over incomplete; the expiry day itself is not expired', () => {
    expect(permitStatus(e({ workPermitNumber: null, workPermitExpiry: on('2026-11-25') }), today)).toEqual({ state: 'EXPIRED', daysLeft: -1 });
    expect(permitStatus(e({ workPermitExpiry: on('2026-11-26') }), today)).toEqual({ state: 'EXPIRING', daysLeft: 0 });
  });
  it('warns from 60 days out', () => {
    expect(permitStatus(e({ workPermitExpiry: on('2027-01-25') }), today)).toEqual({ state: 'EXPIRING', daysLeft: 60 });
    expect(permitStatus(e({ workPermitExpiry: on('2027-01-26') }), today)).toBeNull();
  });
});

describe('alertStage', () => {
  it.each([[61, null], [60, 60], [31, 60], [30, 30], [8, 30], [7, 7], [1, 7], [0, 0], [-3, 0]])('%i days -> %s', (days, stage) => {
    expect(alertStage(days)).toBe(stage);
  });
});
