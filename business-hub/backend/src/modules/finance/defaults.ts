import { ScopedClient } from '../../common/prisma/prisma.service';

// Placeholder chart of accounts and tax codes. The accountant must review both: the brief lists
// Jordanian chart-of-accounts structure and current tax rates as items needing verification.
export const DEFAULT_ACCOUNTS: [code: string, name: string, type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE', systemKey: string][] = [
  ['1000', 'Cash on hand', 'ASSET', 'CASH'],
  ['1010', 'Bank', 'ASSET', 'BANK'],
  ['1100', 'Accounts receivable', 'ASSET', 'AR'],
  ['1150', 'Marketplace clearing', 'ASSET', 'MARKETPLACE_CLEARING'],
  ['1160', 'Card settlement clearing', 'ASSET', 'CARD_CLEARING'],
  ['1170', 'Employee advances', 'ASSET', 'EMPLOYEE_ADVANCES'],
  ['1200', 'Inventory', 'ASSET', 'INVENTORY'],
  ['1210', 'Input tax receivable', 'ASSET', 'INPUT_TAX'],
  ['2000', 'Accounts payable', 'LIABILITY', 'AP'],
  ['2100', 'Output tax payable', 'LIABILITY', 'OUTPUT_TAX'],
  ['2200', 'Payroll payable', 'LIABILITY', 'PAYROLL_PAYABLE'],
  ['2210', 'Social security payable', 'LIABILITY', 'SSC_PAYABLE'],
  ['2220', 'Employee income tax payable', 'LIABILITY', 'PAYROLL_TAX_PAYABLE'],
  ['2300', 'Gift card liability', 'LIABILITY', 'GIFT_CARD'],
  ['2400', 'Customer loyalty liability', 'LIABILITY', 'LOYALTY'],
  ['3000', 'Owner equity', 'EQUITY', 'EQUITY'],
  ['4000', 'Sales revenue', 'REVENUE', 'SALES'],
  ['4100', 'Sales discounts and refunds', 'REVENUE', 'SALES_DISCOUNTS'],
  ['5000', 'Cost of goods sold', 'EXPENSE', 'COGS'],
  ['5100', 'Purchase price variance', 'EXPENSE', 'PURCHASE_VARIANCE'],
  ['5200', 'Inventory adjustments and wastage', 'EXPENSE', 'INVENTORY_ADJUSTMENT'],
  ['5300', 'Cash over/short', 'EXPENSE', 'CASH_VARIANCE'],
  ['6000', 'Salaries and wages', 'EXPENSE', 'SALARY_EXPENSE'],
  ['6010', 'Employer social security', 'EXPENSE', 'SSC_EXPENSE'],
  ['6100', 'Marketplace commissions', 'EXPENSE', 'COMMISSION_EXPENSE'],
  ['6200', 'Rounding', 'EXPENSE', 'ROUNDING'],
];

export const DEFAULT_TAX_CODES = [
  { code: 'S16', name: 'Standard rate', rate: '0.16', eligibleDefault: true, notes: 'Placeholder rate: verify against current legislation before go-live.' },
  { code: 'Z0', name: 'Zero rated', rate: '0', eligibleDefault: true, notes: 'Placeholder: verify scope.' },
  { code: 'EX', name: 'Exempt', rate: '0', eligibleDefault: false, notes: 'Placeholder: exempt supplies carry no recoverable input tax.' },
];

// Inserts only missing accounts and tax codes, so it is safe at bootstrap and when upgrading existing tenants.
export async function seedFinanceDefaults(db: ScopedClient, tenantId: string) {
  const [accts, taxes] = await Promise.all([db.chartAccount.findMany({ select: { code: true, systemKey: true } }), db.taxCode.findMany({ select: { code: true } })]);
  const haveAcct = new Set(accts.flatMap((a) => [a.code, a.systemKey ?? '']));
  const haveTax = new Set(taxes.map((t) => t.code));
  const newAccts = DEFAULT_ACCOUNTS.filter(([code, , , key]) => !haveAcct.has(code) && !haveAcct.has(key));
  const newTaxes = DEFAULT_TAX_CODES.filter((t) => !haveTax.has(t.code));
  if (newAccts.length) await db.chartAccount.createMany({ data: newAccts.map(([code, name, type, systemKey]) => ({ tenantId, code, name, type, systemKey })) });
  if (newTaxes.length) await db.taxCode.createMany({ data: newTaxes.map((t) => ({ tenantId, ...t })) });
}
