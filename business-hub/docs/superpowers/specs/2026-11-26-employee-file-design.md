# Employee file: editable sensitive details, allowances, nationality, work permits

## Intent
HR keeps the employee file correct (for example after a bank change), records the full pay package,
and never loses track of a work permit that is unstarted, incomplete or about to expire.

## Changes
1. **Sensitive details**: HR and Owner can add and edit national ID, date of birth, address and IBAN,
   on existing employees. All optional. Saved encrypted. The audit trail records who changed which
   fields, not the values. Viewing stays audited as today.
2. **Allowances**: "Add employee" and contract "New version" get repeatable name + amount rows
   (housing, laundry, ...). Basic salary stays required. "New version" starts with the current
   allowances filled in; removing all rows saves none. The contracts table shows them.
3. **Nationality**: required on "Add employee", editable on the file.
4. **Work permit**: "Requires a work permit" checkbox. When checked, permit number and expiry date,
   both optional. Editable on the file. Unchecking clears both.
5. **Badge** beside the name in the employee list and on the file:
   - red "Work permit incomplete": number or expiry missing
   - red "Permit expired": expiry date has passed (shown even if the number is missing)
   - amber "Permit expires in N days": 60 days or fewer
6. **Alerts**: in-app notifications to the HR role, the Owner role and the employee, at 60, 30 and
   7 days before expiry and on the day. Checked daily and when the permit is saved. Each stage is sent
   once; changing the expiry date restarts the stages. If several stages are already past, only the
   latest is sent.

## Not doing
- Permit history or scanned copies.
- HR tasks, blocking schedules or payroll for a missing or expired permit.
- Email or SMS (not connected).
- Repeat notifications for incomplete permits (badge only).
- Asking candidates for nationality in recruitment (screening deliberately excludes it).

## Approaches
- **A. Fields on the employee record (chosen)**: smallest change; a renewal overwrites old details.
- B. Separate permit history: browsable past permits, more screens. Can be added later.
- C. A plus HR tasks: stronger follow-up, a second list to keep in step.

## Calls made by the builder (check these)
- Existing employees and recruitment hires start with blank nationality and no permit flag; HR fills them in.
- Terminated employees get no alerts and no badge.
- Branch managers see the badge but not the permit number.
- Thresholds are fixed, not a configurable policy.
- An employee without a login gets no notification; HR and Owner still do.
- A role notification is shared: when one HR user marks it read, it is read for all HR users.

## Check
One backend e2e test: save sensitive details and read them back; flag with no details gives "incomplete";
expiry within 30 days notifies HR, Owner and employee exactly once.
