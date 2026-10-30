import { ScopedClient } from '../../common/prisma/prisma.service';

// Starting policies every tenant gets so routine work auto-processes from day one.
// Owners and finance tune these in the Policies screen; changes create new versions.
const POLICIES: { key: string; riskTier: 'LOW' | 'MEDIUM' | 'HIGH' | 'REGULATED'; rules: Record<string, number | boolean> }[] = [
  { key: 'purchase_request.approve', riskTier: 'LOW', rules: { maxAutoAmount: 200 } },
  { key: 'purchase_order.issue', riskTier: 'LOW', rules: { maxAutoAmount: 500 } },
  { key: 'receiving.three_way_match', riskTier: 'LOW', rules: { maxVariancePct: 2, minConfidence: 0.85, maxAutoAmount: 5000 } },
  { key: 'payable.release_payment', riskTier: 'HIGH', rules: {} },
  { key: 'inventory.count_adjustment', riskTier: 'LOW', rules: { maxAutoAmount: 100, maxVariancePct: 5 } },
  { key: 'inventory.wastage', riskTier: 'LOW', rules: { maxAutoAmount: 50 } },
  { key: 'tax.file_return', riskTier: 'REGULATED', rules: {} },
  { key: 'vacancy.approve', riskTier: 'LOW', rules: { maxAutoAmount: 30000 } },
  { key: 'vacancy.over_budget', riskTier: 'HIGH', rules: {} },
  { key: 'recruitment.auto_advance', riskTier: 'LOW', rules: { minConfidence: 0.8 } },
  { key: 'offer.approve', riskTier: 'LOW', rules: { maxVariancePct: 0, maxAutoAmount: 24000 } },
  { key: 'ssc.submit', riskTier: 'REGULATED', rules: {} },
  { key: 'payroll.finalize', riskTier: 'HIGH', rules: {} },
  { key: 'payroll.release_payment', riskTier: 'HIGH', rules: {} },
  { key: 'leave.approve', riskTier: 'LOW', rules: { maxAutoAmount: 0 } },
  { key: 'time.correction', riskTier: 'LOW', rules: { maxAutoAmount: 30 } },
  { key: 'offboarding.settlement', riskTier: 'HIGH', rules: {} },
  { key: 'payroll.adjustment', riskTier: 'LOW', rules: { maxAutoAmount: 50 } },
  { key: 'menu.price_change', riskTier: 'LOW', rules: { maxVariancePct: 10 } },
  { key: 'pos.discount', riskTier: 'LOW', rules: { maxVariancePct: 10 } },
  { key: 'pos.refund', riskTier: 'LOW', rules: { maxAutoAmount: 15 } },
  { key: 'pos.void_sent_line', riskTier: 'LOW', rules: { maxAutoAmount: 0 } },
  { key: 'pos.cash_variance', riskTier: 'LOW', rules: { maxAutoAmount: 2 } },
  { key: 'pos.offline_price_variance', riskTier: 'LOW', rules: { maxVariancePct: 5 } },
];

const LIMITS: [policyKey: string, roleKey: string, maxAmount: number][] = [
  ['purchase_request.approve', 'PROCUREMENT', 500],
  ['purchase_request.approve', 'BRANCH_MANAGER', 2000],
  ['purchase_request.approve', 'FINANCE', 20000],
  ['purchase_order.issue', 'PROCUREMENT', 1000],
  ['purchase_order.issue', 'FINANCE', 20000],
  ['receiving.three_way_match', 'PROCUREMENT', 500],
  ['receiving.three_way_match', 'BRANCH_MANAGER', 1500],
  ['receiving.three_way_match', 'FINANCE', 15000],
  ['payable.release_payment', 'FINANCE', 10000],
  ['inventory.count_adjustment', 'BRANCH_MANAGER', 500],
  ['inventory.count_adjustment', 'FINANCE', 10000],
  ['inventory.wastage', 'BRANCH_MANAGER', 200],
  ['inventory.wastage', 'FINANCE', 5000],
  ['menu.price_change', 'FINANCE', 1000000],
  ['vacancy.approve', 'HR', 50000],
  ['vacancy.approve', 'FINANCE', 500000],
  ['vacancy.over_budget', 'FINANCE', 200000],
  ['offer.approve', 'HR', 30000],
  ['offer.approve', 'FINANCE', 200000],
  ['payroll.finalize', 'OWNER', 1000000000],
  ['payroll.release_payment', 'OWNER', 1000000000],
  ['leave.approve', 'BRANCH_MANAGER', 10],
  ['leave.approve', 'HR', 60],
  ['time.correction', 'BRANCH_MANAGER', 480],
  ['offboarding.settlement', 'FINANCE', 50000],
  ['payroll.adjustment', 'HR', 500],
  ['payroll.adjustment', 'FINANCE', 5000],
  ['pos.discount', 'BRANCH_MANAGER', 200],
  ['pos.discount', 'FINANCE', 2000],
  ['pos.refund', 'BRANCH_MANAGER', 100],
  ['pos.refund', 'FINANCE', 1000],
  ['pos.void_sent_line', 'BRANCH_MANAGER', 500],
  ['pos.cash_variance', 'BRANCH_MANAGER', 20],
  ['pos.cash_variance', 'FINANCE', 500],
  ['pos.offline_price_variance', 'BRANCH_MANAGER', 100000],
];

// Inserts only what is missing, so it is safe at bootstrap and when upgrading existing tenants.
export async function seedPolicyDefaults(db: ScopedClient, tenantId: string) {
  const [havePolicies, haveLimits] = await Promise.all([db.policy.findMany({ select: { key: true } }), db.approvalLimit.findMany({ select: { policyKey: true, roleKey: true } })]);
  const keys = new Set(havePolicies.map((p) => p.key));
  const limitKeys = new Set(haveLimits.map((l) => `${l.policyKey}|${l.roleKey}`));
  const newPolicies = POLICIES.filter((p) => !keys.has(p.key));
  const newLimits = LIMITS.filter(([k, r]) => !keys.has(k) && !limitKeys.has(`${k}|${r}`));
  if (newPolicies.length) await db.policy.createMany({ data: newPolicies.map((p) => ({ tenantId, key: p.key, riskTier: p.riskTier, rules: p.rules })) });
  if (newLimits.length) await db.approvalLimit.createMany({ data: newLimits.map(([policyKey, roleKey, maxAmount]) => ({ tenantId, policyKey, roleKey, maxAmount })) });
}
