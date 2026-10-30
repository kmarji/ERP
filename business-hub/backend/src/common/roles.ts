// Default roles seeded per tenant. rank orders authority: exceptions route to the lowest authorized rank.
export const DEFAULT_ROLES = [
  { key: 'SYSTEM', name: 'System automation', rank: 0 },
  { key: 'EMPLOYEE', name: 'Employee', rank: 5 },
  { key: 'CASHIER', name: 'Cashier', rank: 10 },
  { key: 'KITCHEN', name: 'Kitchen', rank: 10 },
  { key: 'PROCUREMENT', name: 'Procurement / storekeeper', rank: 30 },
  { key: 'BRANCH_MANAGER', name: 'Branch manager', rank: 40 },
  { key: 'HR', name: 'HR / recruiter', rank: 50 },
  { key: 'FINANCE', name: 'HQ finance / accountant', rank: 60 },
  { key: 'OWNER', name: 'Business owner', rank: 100 },
] as const;

export type RoleKey = (typeof DEFAULT_ROLES)[number]['key'];
