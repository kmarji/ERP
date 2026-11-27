# Contract templates

Status: approved (PDF).

## Intent
HR uploads the company's own Word contracts once; offers use them, filled in automatically.

## Design
- **Onboarding > Contract templates** (HR, Owner): upload `.docx` (5 MB max), name it, choose which
  contract type it is for (open-ended, fixed term, or both), replace or deactivate it, download it.
- Markers in the document, for example `{{employee_name}}`:
  `employee_name, employee_name_ar, nationality, job_title, job_title_ar, branch, employer_name,
  tax_number, start_date, end_date, contract_type, basic_salary, allowances, total_salary,
  probation_months, weekly_hours, offer_number, today`.
  `nationality` and `employee_name_ar` are blank when not recorded (recruitment does not ask nationality).
- Upload is refused if it holds a marker not on the list (names shown), so typos surface early.
- Creating an offer: pick a template (the only matching one is preselected) or the built-in text.
- The filled contract is made once, when the offer is created, and kept with the offer. Changing a
  template later does not change existing offers.
- The candidate opens it on the careers status page before signing; HR can download it.
- Arabic and English: whatever the uploaded document contains. No translation.

## Format the candidate sees: PDF (chosen)
Reads on any phone and cannot be casually edited. Needs LibreOffice on the server (a much larger
server image; fonts must be checked for Arabic). Word was the lighter alternative.

## Approaches
- A. Upload Word with markers (**chosen**): keeps company formatting.
- B. Type templates in the app: basic formatting only.
- C. Fixed PDF: nothing filled in.

## Builder calls
- New libraries to fill Word files (`docxtemplater`, `pizzip`).
- Contracts for employees added directly (without an offer) are not covered.

## Check
Upload rejects unknown markers and non-Word files; an offer from a template contains the candidate's
values; a later template change leaves it as it was; HR-only access.
