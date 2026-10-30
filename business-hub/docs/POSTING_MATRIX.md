# Posting matrix

Every operational event posts through one `FinancePostingService.post`: balanced, idempotent (`idempotencyKey`), period-lock aware, append-only (corrections are reversals). Accounts are referenced by `systemKey`, so a tenant can renumber its chart. **The default chart and all tax rates are placeholders that need accountant/legal verification.**

| Source (`sourceType`) | Trigger | Debit | Credit |
|---|---|---|---|
| GoodsReceipt | Receipt matched (3-way) or approved | INVENTORY, INPUT_TAX (eligible part), PURCHASE_VARIANCE (if over) | AP (invoice total), PURCHASE_VARIANCE (if under) |
| Payable | Supplier payment released (approval-gated) | AP | BANK or CASH |
| Order | Sale completed (own posting track) | Tender accounts: CASH / CARD_CLEARING / MARKETPLACE_CLEARING / GIFT_CARD; SALES_DISCOUNTS | SALES, OUTPUT_TAX |
| Order (cost) | Same sale, recipe consumption | COGS | INVENTORY |
| Refund | Credit note | SALES, OUTPUT_TAX | Refund tender account |
| Refund (restock) | Returned stock | INVENTORY | COGS |
| Shift | Shift close with cash variance | CASH_VARIANCE (shortage) or CASH (overage) | CASH or CASH_VARIANCE |
| Settlement | Card / marketplace payout | BANK, COMMISSION_EXPENSE, CASH_VARIANCE (shortfall) | CARD_CLEARING or MARKETPLACE_CLEARING |
| GiftCard | Gift card sold | CASH or CARD_CLEARING | GIFT_CARD |
| StockCount | Count adjustment | INVENTORY_ADJUSTMENT (loss) or INVENTORY (gain) | INVENTORY or INVENTORY_ADJUSTMENT |
| Wastage | Wastage recorded | INVENTORY_ADJUSTMENT | INVENTORY |
| StockTransfer | Transfer received | INVENTORY (receiving branch) | INVENTORY (sending branch) |
| TaxReturn | Return filed / settled | OUTPUT_TAX | INPUT_TAX, BANK or CASH (net payable) |
| PayrollRun | Run finalized (owner authorization) | SALARY_EXPENSE and SSC_EXPENSE per branch | PAYROLL_PAYABLE, SSC_PAYABLE (employee + employer), PAYROLL_TAX_PAYABLE, EMPLOYEE_ADVANCES |
| PayrollPayment | Salaries paid (separate approval) | PAYROLL_PAYABLE | BANK or CASH |
| StatutoryObligation | SSC / income tax remitted | SSC_PAYABLE or PAYROLL_TAX_PAYABLE | BANK |
| EmployeeAdvance | Advance issued | EMPLOYEE_ADVANCES | CASH |
| MANUAL | Finance journal entry | as entered | as entered |

Tax-bearing sources (SupplierInvoice, Order, Refund) also write `TaxLedgerEntry` rows, the single input to the tax return working papers.
