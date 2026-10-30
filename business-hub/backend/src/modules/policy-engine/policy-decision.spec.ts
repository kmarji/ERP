import { decide, LimitInfo, PolicyInfo } from './policy-decision';

const rank = { BRANCH_MANAGER: 40, FINANCE: 60, OWNER: 100 };
const limits: LimitInfo[] = [
  { roleKey: 'BRANCH_MANAGER', maxAmount: 200, legalEntityId: null, branchId: null, category: null },
  { roleKey: 'FINANCE', maxAmount: 5000, legalEntityId: null, branchId: null, category: null },
];
const low: PolicyInfo = { version: 3, riskTier: 'LOW', rules: { maxAutoAmount: 100, maxVariancePct: 2, minConfidence: 0.9 } };

describe('policy decision', () => {
  it('auto-processes in-tolerance low-risk actions', () => {
    const r = decide(low, false, limits, rank, { amount: 50, variancePct: 1, confidence: 0.95 });
    expect(r.decision).toBe('AUTO');
    expect(r.policyVersion).toBe(3);
  });

  it('routes a variance breach to the lowest covering role, not the owner', () => {
    const r = decide(low, false, limits, rank, { amount: 150, variancePct: 5, confidence: 0.95 });
    expect(r).toMatchObject({ decision: 'DELEGATED', approverRole: 'BRANCH_MANAGER', ownerEscalated: false });
    expect(r.escalationRoute).toEqual(['BRANCH_MANAGER', 'FINANCE', 'OWNER']);
  });

  it('escalates to finance when the amount exceeds the manager limit', () => {
    const r = decide(low, false, limits, rank, { amount: 1000, variancePct: 1, confidence: 0.95 });
    expect(r).toMatchObject({ decision: 'DELEGATED', approverRole: 'FINANCE' });
  });

  it('escalates to the owner only when beyond every delegated limit', () => {
    const r = decide(low, false, limits, rank, { amount: 9000, variancePct: 1, confidence: 0.95 });
    expect(r).toMatchObject({ decision: 'APPROVAL_REQUIRED', approverRole: 'OWNER', ownerEscalated: true });
  });

  it('treats missing data as unsafe', () => {
    expect(decide(low, false, limits, rank, { amount: 50 }).decision).not.toBe('AUTO');
  });

  it('never auto-processes regulated actions', () => {
    const p: PolicyInfo = { version: 1, riskTier: 'REGULATED', rules: {} };
    expect(decide(p, false, limits, rank, { amount: 1 })).toMatchObject({ decision: 'APPROVAL_REQUIRED', ownerEscalated: true });
  });

  it('requires approval for high-risk even when small', () => {
    const p: PolicyInfo = { version: 1, riskTier: 'HIGH', rules: {} };
    expect(decide(p, false, limits, rank, { amount: 10 }).decision).toBe('APPROVAL_REQUIRED');
  });

  it('blocks deactivated policies', () => {
    expect(decide(null, true, limits, rank, { amount: 1 }).decision).toBe('BLOCKED');
  });

  it('falls back to owner approval when no policy and no limits exist', () => {
    expect(decide(null, false, [], rank, { amount: 1 })).toMatchObject({ decision: 'APPROVAL_REQUIRED', approverRole: 'OWNER' });
  });
});
