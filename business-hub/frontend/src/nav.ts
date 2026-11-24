// Single registry of back-office screens. Each milestone appends its routes here.
export interface NavItem {
  to: string;
  label: string;
  group: string;
  roles?: string[]; // hidden unless the user holds one of these roles...
  areas?: string[]; // ...or the company's role matrix gives them one of these modules
}

const MGR = ['OWNER', 'HR', 'BRANCH_MANAGER'];
const HR_FIN = ['OWNER', 'HR', 'FINANCE'];

export const NAV: NavItem[] = [
  { to: '/', label: 'Owner home', group: 'Overview' },
  { to: '/exceptions', label: 'Exceptions', group: 'Overview' },
  { to: '/approvals', label: 'Approvals', group: 'Overview' },
  { to: '/purchasing', label: 'Purchasing', group: 'Purchasing' },
  { to: '/receiving', label: 'Receiving', group: 'Purchasing' },
  { to: '/suppliers', label: 'Suppliers', group: 'Purchasing' },
  { to: '/payables', label: 'Payables', group: 'Purchasing' },
  { to: '/products', label: 'Products', group: 'Inventory' },
  { to: '/inventory', label: 'Inventory', group: 'Inventory' },
  { to: '/stock-operations', label: 'Stock operations', group: 'Inventory' },
  { to: '/menu', label: 'Menu', group: 'Menu' },
  { to: '/sales', label: 'Sales', group: 'Sales' },
  { to: '/pos-devices', label: 'POS devices', group: 'Sales' },
  { to: '/online-orders', label: 'Online orders', group: 'Sales' },
  { to: '/online-store', label: 'Online store', group: 'Sales' },
  { to: '/marketplaces', label: 'Marketplaces', group: 'Sales' },
  { to: '/customers', label: 'Customers', group: 'Customers' },
  { to: '/recruitment', label: 'Recruitment', group: 'People' },
  { to: '/onboarding', label: 'Onboarding', group: 'People' },
  { to: '/people', label: 'Employees', group: 'People' },
  { to: '/scheduling', label: 'Scheduling', group: 'Workforce', roles: MGR, areas: ['Workforce'] },
  { to: '/time', label: 'Time & attendance', group: 'Workforce', roles: MGR, areas: ['Workforce'] },
  { to: '/leave', label: 'Leave', group: 'Workforce', roles: MGR, areas: ['Workforce'] },
  { to: '/discipline', label: 'Discipline', group: 'Workforce', roles: ['OWNER', 'HR'], areas: ['Discipline'] },
  { to: '/payroll', label: 'Payroll', group: 'Workforce', roles: HR_FIN, areas: ['Payroll'] },
  { to: '/offboarding', label: 'Offboarding', group: 'Workforce', roles: HR_FIN, areas: ['Offboarding'] },
  { to: '/operations', label: 'Operations dashboard', group: 'Operations', roles: MGR, areas: ['OpsOverview'] },
  { to: '/checklists', label: 'Checklists', group: 'Operations', roles: MGR, areas: ['Operations'] },
  { to: '/training', label: 'Training & SOPs', group: 'Operations', roles: MGR, areas: ['Learning'] },
  { to: '/audits', label: 'Audits', group: 'Operations', roles: MGR, areas: ['Audits'] },
  { to: '/food-safety', label: 'Food safety', group: 'Operations', roles: MGR, areas: ['Audits', 'Operations', 'OpsOverview'] },
  { to: '/actions', label: 'Corrective actions', group: 'Operations', roles: MGR, areas: ['Audits', 'Operations', 'OpsOverview'] },
  { to: '/me', label: 'My space', group: 'Workforce' },
  { to: '/finance', label: 'Finance', group: 'Finance' },
  { to: '/tax', label: 'Tax filing', group: 'Finance' },
  { to: '/policies', label: 'Policies', group: 'Governance' },
  { to: '/audit', label: 'Audit trail', group: 'Governance' },
  { to: '/settings', label: 'Settings', group: 'Governance' },
];
