# Business Hub: demo guide

Demo data and credentials only. Never reuse any of this in production.

Server address used below: `192.168.8.12` (the `PUBLIC_HOST` in `docker/.env`). If the server's IP changes, update `PUBLIC_HOST` and run `docker compose up -d --build` in `docker/`.

## URLs
| App | URL | For |
|---|---|---|
| Back-office | http://192.168.8.12:8080/login | Owner, finance, HR, managers |
| Tablet POS | http://192.168.8.12:8081 | Cashiers (kitchen display at `/kds`) |
| Online storefront | http://192.168.8.12:8082/demo | Customers: pick Abdoun (pickup + delivery) or Sweifieh (pickup) |
| Careers | http://192.168.8.12:8083/demo | Job candidates (one open Barista vacancy) |
| API docs (Swagger) | http://192.168.8.12:3000/docs | Technical audience |

If a page says "failed to fetch" from another PC, open ports 3000 and 8080-8083 on the server's firewall.

## Logins
Business / tenant: `demo`. Password for every account: `ChangeMe-12345`

| Role | Email | Use it to show |
|---|---|---|
| Owner | owner@demo.test | Owner home, approvals, policies, payroll authorization |
| Finance | finance@demo.test | Finance, tax, payables, payroll review |
| Procurement | procurement@demo.test | Purchasing, receiving, suppliers |
| HR | hr@demo.test | Recruitment, employees, payroll runs |
| Branch manager (Abdoun) | manager.amm1@demo.test | Branch approvals, scheduling |
| Cashier (Abdoun) | cashier.amm1@demo.test | The POS |

## POS tablet setup (once per browser or device)
1. Open the POS, sign in as `cashier.amm1@demo.test`.
2. Branch screen: pick **Amman - Abdoun**.
3. Device section: id `9b24bb4c-d41e-409a-9c92-080c8f1bb69d`, key `fbc2ac99f0c4b830efadc1887dd0d87dcbda0d895fb3e0b6`, then "Save + download menu".
4. Optional: Receipt printer section (printer IP, port 9100) for the phone/tablet app. The browser uses the normal print dialog.

A database seeded from scratch gets its own tablet with a new key, printed once by `npm run prisma:seed`.

## Setting up on a new machine
```bash
git clone <repo> && cd business-hub          # or copy the folder
cp docker/.env.example docker/.env           # then set JWT_SECRET, BOOTSTRAP_TOKEN, DATA_ENCRYPTION_KEY (openssl rand -base64 32) and PUBLIC_HOST (this machine's LAN IP)
cd docker && docker compose up -d --build && cd ..
./seed.sh                                    # waits for the backend, then seeds everything below
```
`seed.sh` needs Node 20+ and `npm` on the host (it installs backend dependencies on first run). It is safe to run again: nothing that exists is duplicated or changed, except that menu items without a tax code get S16. A fresh database gets its own POS tablet; **the device id and key are printed once at the end of the seed output**, so copy them into the POS tablet setup below (the id and key shown there belong to the original machine). Then open the firewall for ports 3000 and 8080-8083 if other devices will connect.

## Seeded data
- **Users:** the six accounts above, three branches (Abdoun, Sweifieh, Irbid). **Menu:** 3 categories, 8 items. **POS tablet:** Demo Tablet 1 (Abdoun).
- **Suppliers:** Jordan Dairy Co., Levant Coffee Roasters, Amman Mills, with 4 priced products (milk, espresso beans, flour, cups).
- **People:** positions Barista and Cashier with headcount budgets, one open Barista vacancy (Abdoun), and 5 employees with contracts (Omar, Lina, Yousef, Rana, Tariq). Tariq has no bank account on purpose: payroll flags it as an exception, the rest appear in the bank file.
- **Online store:** enabled for Abdoun (pickup + delivery to Abdoun, Sweifieh, Jabal Amman, fee 1.000, minimum order 3.000) and Sweifieh (pickup only). Orders arrive in Online orders in the back-office for staff to accept.

## Suggested demo flow (about 10 minutes)
1. **Sale (POS):** open a shift, add Latte + Croissant, pay cash, show the receipt. Open `/kds` on a second screen to show the kitchen ticket.
2. **Offline:** turn off Wi-Fi, sell with cash, reconnect, show the sale syncing (Offline sales screen).
3. **Cash up:** close the shift with a counted amount; a shortage or overage posts to the books.
4. **Back-office, owner:** Sales (the sale just made), Finance (journal entry it created), Owner home, Audit trail.
5. **Exceptions and approvals:** big refund or discount by the cashier needs a manager; show Approvals as the manager. Routine work auto-completes, only exceptions reach a person.
6. **Purchasing (WF-01):** as procurement, create a purchase request for milk or beans from the seeded suppliers and issue the order; as finance, show the three-way match and payables.
7. **Payroll:** as HR, create a run for last month and calculate (5 employees, one missing-bank-account exception to acknowledge); finance reviews; the owner authorizes. Note that payroll cannot be finalized until the rule set is verified (Payroll, Rules).

## Not demo-ready yet
- **Tax:** menu items use tax code S16, a placeholder 16% rate (prices include tax). Say it is a placeholder.
- **Stock:** no recipes or stock quantities, so sales do not consume inventory.
- **Careers link on a new machine:** the vacancy's public code is random; the job list at the careers URL always shows it.
- **Payroll rules** are unverified placeholders: a run can be calculated and reviewed but not finalized until someone verifies the rule set (Payroll, Rules). Verify it before the demo if you want to show finalization, and say the values are placeholders.
- **Integrations are stubs** (JoFotara, social security, delivery apps, card terminals). Card payments are a typed approval code. Tax, social security and payroll values are placeholders, not legal values. Say so up front.
- Nothing here has been tested on a real tablet, printer or phone.
