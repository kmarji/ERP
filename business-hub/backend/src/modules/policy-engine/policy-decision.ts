export type RiskTierName = 'LOW' | 'MEDIUM' | 'HIGH' | 'REGULATED';
export type Decision = 'AUTO' | 'DELEGATED' | 'APPROVAL_REQUIRED' | 'BLOCKED';

export interface PolicyRules {
  maxAutoAmount?: number;
  maxVariancePct?: number;
  minConfidence?: number;
  blocked?: boolean;
}

export interface PolicyInfo {
  version: number;
  riskTier: RiskTierName;
  rules: PolicyRules;
}

export interface LimitInfo {
  roleKey: string;
  maxAmount: number;
  legalEntityId: string | null;
  branchId: string | null;
  category: string | null;
}

export interface EvalInput {
  amount?: number;
  variancePct?: number;
  confidence?: number;
  branchId?: string | null;
  legalEntityId?: string | null;
  category?: string | null;
}

export interface EvalResult {
  decision: Decision;
  tier: RiskTierName;
  policyVersion: number | null;
  reason: string;
  approverRole: string | null;
  // True when only the owner can decide (beyond delegated authority or regulated).
  ownerEscalated: boolean;
  escalationRoute: string[];
}

const OWNER = 'OWNER';

// Pure and deterministic so policies are testable. `policy === null` means none configured;
// `blockedByDeactivation` means every version of the policy is switched off.
export function decide(
  policy: PolicyInfo | null,
  blockedByDeactivation: boolean,
  limits: LimitInfo[],
  roleRank: Record<string, number>,
  input: EvalInput,
): EvalResult {
  const tier: RiskTierName = policy?.riskTier ?? 'MEDIUM';
  const policyVersion = policy?.version ?? null;
  const base = { tier, policyVersion };

  if (blockedByDeactivation || policy?.rules.blocked) {
    return { ...base, decision: 'BLOCKED', reason: 'Policy is deactivated or blocks this action', approverRole: null, ownerEscalated: false, escalationRoute: [] };
  }

  const amount = input.amount ?? 0;
  const covering = limits
    .filter(
      (l) =>
        l.maxAmount >= amount &&
        (l.branchId === null || l.branchId === (input.branchId ?? null)) &&
        (l.legalEntityId === null || l.legalEntityId === (input.legalEntityId ?? null)) &&
        (l.category === null || l.category === (input.category ?? null)),
    )
    .map((l) => l.roleKey)
    .filter((k) => k !== OWNER)
    .sort((a, b) => (roleRank[a] ?? 0) - (roleRank[b] ?? 0));
  const route = [...new Set([...covering, OWNER])];

  if (tier === 'REGULATED') {
    return { ...base, decision: 'APPROVAL_REQUIRED', reason: 'Regulated action requires legal authorization and verified integration', approverRole: OWNER, ownerEscalated: true, escalationRoute: [OWNER] };
  }

  const r = policy?.rules ?? {};
  // Missing data is never treated as safe: a configured condition with no supplied value blocks auto-processing.
  const failures: string[] = [];
  if (r.maxAutoAmount !== undefined && !(input.amount !== undefined && input.amount <= r.maxAutoAmount)) failures.push('amount above auto limit');
  if (r.maxVariancePct !== undefined && !(input.variancePct !== undefined && input.variancePct <= r.maxVariancePct)) failures.push('variance above tolerance');
  if (r.minConfidence !== undefined && !(input.confidence !== undefined && input.confidence >= r.minConfidence)) failures.push('confidence below minimum');

  if (tier === 'LOW' && policy && failures.length === 0) {
    return { ...base, decision: 'AUTO', reason: 'Within policy conditions', approverRole: null, ownerEscalated: false, escalationRoute: [] };
  }

  const approverRole = route[0];
  const ownerEscalated = approverRole === OWNER;
  if (tier === 'HIGH' || ownerEscalated) {
    const why = !policy ? 'no policy configured' : tier === 'HIGH' ? 'high-risk action needs explicit approval' : failures.join(', ') || 'beyond delegated limits';
    return { ...base, decision: 'APPROVAL_REQUIRED', reason: why, approverRole, ownerEscalated, escalationRoute: route };
  }
  return {
    ...base,
    decision: 'DELEGATED',
    reason: failures.join(', ') || 'routine action routed to delegated role',
    approverRole,
    ownerEscalated: false,
    escalationRoute: route,
  };
}
