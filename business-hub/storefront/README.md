# Storefront (customer ordering)
Mobile-first public ordering site. Uses only the public `/store/:tenant/...` API (no login).
- `npm install && npm run dev` (port 5175); set `VITE_API_URL` and `VITE_TENANT` in `.env`.
- The tenant can also come from the URL: `/:tenant`, `/:tenant/b/:branchId`, `/:tenant/track/:code`.
- Branch must be enabled in back office: Online store settings (`PUT /online-store/:branchId`).
- Card payment is a demo placeholder producing a token (`tok_...`; `DECLINE...` simulates a decline). Card numbers are never collected; replace it with the gateway's hosted fields.
- Cart is kept per branch in localStorage; the checkout idempotency key survives reloads until the order succeeds or a payment is declined.
- English/Arabic toggle (RTL) in the header.
