# Who may open a document

Status: approved.

## Intent
Only authorised people open contracts and other files. Today any signed-in user can, given the ID.

## Rule
One check for viewing, listing and downloading. The owner and the uploader always may. Otherwise:

| File | Who else |
|---|---|
| Candidate ID and bank documents, interview recordings | HR |
| Offer contracts, payslips, payroll and bank files | HR, finance |
| Tax filing files | Finance |
| Leave certificates | HR, the employee, their line manager |
| Discipline evidence | HR |
| Supplier invoices and delivery evidence | Finance, purchasing (procurement), that branch's manager |
| Checklist and training guides | All staff |
| Checklist, audit, food safety and corrective action proof | That branch's manager, HR |
| Not linked to a record | Nobody else |

- Branch-limited roles see only their own branch. Delegated roles count.
- Private candidate and employee routes (own contract, own payslip) are unchanged.
- Nobody can attach a file they may not open.
- Uploads no longer accept a caller-chosen record label (`subjectType`, `subjectId`).
- Refusals answer "not found" (or "unknown document" when attaching).
- The company's role matrix does not widen file access.

## Approaches
- **One central check (chosen).**
- A download route per module: many screen changes, same result.
- HR and owner only: staff could no longer open training guides.
