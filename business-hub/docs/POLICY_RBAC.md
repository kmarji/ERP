# Roles and policy matrix

## Roles (rank orders authority; exceptions route to the lowest authorized rank)
SYSTEM 0, EMPLOYEE 5, CASHIER 10, KITCHEN 10, PROCUREMENT 30, BRANCH_MANAGER 40, HR 50, FINANCE 60, OWNER 100. Roles can be scoped to a branch; delegations grant a role for a window.

## Rules that hold everywhere
- A policy decision is `AUTO`, `DELEGATED`, `APPROVAL_REQUIRED` or `BLOCKED`. Policies are versioned; changing one creates a new version.
- The requester of an approval cannot approve it. Payroll preparer cannot review; payroll reviewer and authorizer are different people from the preparer.
- Approvals are visible only to the approving role and, for branch-scoped roles, only for that branch.
- Immutable: journals, journal lines, stock movements, audit events (extension guard + database triggers).

## Approval limits (defaults; JOD; tune in Policies)
| Policy | Auto up to | Then approver (up to) |
|---|---|---|
| purchase_request.approve | 200 | PROCUREMENT 500, BRANCH_MANAGER 2,000, FINANCE 20,000 |
| purchase_order.issue | 500 | PROCUREMENT 1,000, FINANCE 20,000 |
| receiving.three_way_match | 2% variance, 5,000, confidence 0.85 | PROCUREMENT 500, BRANCH_MANAGER 1,500, FINANCE 15,000 |
| payable.release_payment | never | FINANCE 10,000 |
| inventory.count_adjustment / wastage | 100 / 50 | BRANCH_MANAGER 500 / 200, FINANCE 10,000 / 5,000 |
| pos.discount / refund / cash_variance | 10% / 15 / 2 | BRANCH_MANAGER, then FINANCE |
| vacancy.approve / offer.approve | 30,000 / 24,000 (annual) | HR, then FINANCE |
| leave.approve / time.correction | never / 30 min | BRANCH_MANAGER, HR |
| payroll.adjustment | 50 | HR 500, FINANCE 5,000 |
| payroll.finalize, payroll.release_payment | never | OWNER |
| offboarding.settlement | never | FINANCE 50,000 |
| tax.file_return, ssc.submit | never (regulated) | owner authorization |
