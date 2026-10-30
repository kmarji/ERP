// Single registry of back-office screens. Each milestone appends its routes here.
export interface NavItem {
  to: string;
  label: string;
  group: string;
  roles?: string[]; // hidden unless the user holds one of these roles
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
  { to: '/scheduling', label: 'Scheduling', group: 'Workforce', roles: MGR },
  { to: '/time', label: 'Time & attendance', group: 'Workforce', roles: MGR },
  { to: '/leave', label: 'Leave', group: 'Workforce', roles: MGR },
  { to: '/payroll', label: 'Payroll', group: 'Workforce', roles: HR_FIN },
  { to: '/offboarding', label: 'Offboarding', group: 'Workforce', roles: HR_FIN },
  { to: '/me', label: 'My space', group: 'Workforce' },
  { to: '/finance', label: 'Finance', group: 'Finance' },
  { to: '/tax', label: 'Tax filing', group: 'Finance' },
  { to: '/policies', label: 'Policies', group: 'Governance' },
  { to: '/audit', label: 'Audit trail', group: 'Governance' },
  { to: '/settings', label: 'Settings', group: 'Governance' },
];
