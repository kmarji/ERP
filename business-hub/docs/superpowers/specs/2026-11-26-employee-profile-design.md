# Employee profile page

## Intent
Make the employee file easy to read, and record the items a typical HR profile has that we lack.
Reference: a screenshot from another HR product (not committed: it shows a real person).

## Layout
- Clicking an employee in the list opens the profile at full page width, with a back link.
- Left panel: **User info** (photo or initials, name, Arabic name, employee number, status, permit badge,
  phone, email, Reset password) and **Personal info** (gender, nationality, marital status; national ID,
  birth date, age, address and IBAN behind **Show**, audited as today).
- Right: **Professional info** (job role, work type, direct manager, branch, work location, department,
  section, hiring date, end of probation, period of employment).
- **Salary package**: basic, social security salary, total, allowances; **New package** (today's "new
  contract version") and **History** (today's contracts table).
- Below, same card style: work permit, branch assignments, login and role, payroll ratios, training, SSC.
- Cards show read-only values with an **Edit** button that opens the form, with Save and Cancel.
  Lists with their own actions (assignments, training, SSC, roles) keep them.
- Every existing function stays. Stacks into one column on narrow screens.

## New data
| Item | Rule |
|---|---|
| Photo | Optional JPG or PNG, 5 MB max. Upload and remove from User info. |
| Gender | Optional: Male, Female. |
| Marital status | Optional: Single, Married, Divorced, Widowed. |
| Work type | Optional: Full time, Part time, Temporary. Separate from contract type. |
| Department, section, work location | Optional text, suggesting values already used. |
| Probation months | Set on "Add employee" (default 3), editable in Professional info. |

All are on "Add employee" (optional) except the photo, and editable on the profile.

## Calculated
- Age from birth date (shown only after Show).
- End of probation = hiring date + probation months.
- Period of employment = hiring date to today, or to termination date.
- Total salary = basic + allowances of the active contract.
- Social security salary = what payroll uses today: basic + allowances, before any ceiling. Labelled so.
  Payroll rules do not change.

## Edit permissions
- Today's rules stay for existing fields.
- Hiring date, branch and job role stay as today (branch through assignments). Job role becomes editable
  by company-wide HR or owner.
- Photo upload and remove: company-wide HR or owner. Photo visible to whoever can see the employee.
- Gender and marital status: visible to company-wide HR, finance and owner only; edited by company-wide
  HR or owner. Never used in recruitment.

## Not doing
- "User support ID" (specific to the other product).
- Managed lists for department, section, work location (approach B, later if needed).
- Employee portal changes.
- Excluding allowances from the social security salary.

## Approaches
- **A. Typed text with suggestions (chosen)**: quick to build and use; spellings can drift.
- B. Managed lists in Settings: consistent for reporting; needs setup screens.

## Calls made by the builder (check these)
- Photos get their own endpoint with the employee's access rules, not the general documents download.
- Probation months live on the employee, so a new salary package does not reset the probation end date.
  Existing employees take the value from their first contract.
- Age, probation end and period of employment are not stored.

## Check
Backend e2e: new fields save and read back; gender and marital status hidden from branch managers;
photo accepts a PNG, rejects other files and branch-scoped HR. Frontend builds.
