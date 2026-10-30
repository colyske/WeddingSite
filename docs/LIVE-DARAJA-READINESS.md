# Live Daraja readiness (preparation only — NOT activated)

Live M-Pesa collection is **off by default**. Nothing here authorizes enabling it, deploying, applying a migration, or sending any real or sandbox payment.

## Adapter switches (`server/payment-adapters.js`)

Production is selected only when ALL are true; otherwise the adapter fails closed (sandbox still needs `WEDDINGSITE_PAYMENT_MODE=test` + `DARAJA_ENVIRONMENT=sandbox`):

| Key | Expected value |
|---|---|
| `WEDDINGSITE_PAYMENT_MODE` | `live` |
| `DARAJA_ENVIRONMENT` | `production` |
| `DARAJA_LIVE_COLLECTION_ENABLED` | `true` (kill switch; unset/anything else = off) |
| `DARAJA_SHORTCODE` | approved production **PayBill** shortcode, 5–7 digits (the adapter sends `CustomerPayBillOnline` with `PartyB` = shortcode; Till/Buy Goods is NOT supported or reviewed) |
| `DARAJA_LIVE_SHORTCODE_CONFIRMED` | exactly equal to `DARAJA_SHORTCODE` |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` / `DARAJA_PASSKEY` | production values for the SAME approved PayBill, from an approved Go Live app with the M-Pesa Express (STK Push) product enabled (never shown in UI/logs) |
| `WEDDINGSITE_PUBLIC_ORIGIN` | https origin; callback must be `<origin>/api/webhooks?provider=daraja` |

Endpoints (https://api.safaricom.co.ke vs https://sandbox.safaricom.co.ke), per Safaricom's SDK at pinned commit `678e3c33b20c1447c209eb88eded89f1bb751e11` ([m-pesa.js](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/m-pesa.js), [endpoints/oauth.js](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/oauth.js), [endpoints/lipa-na-mpesa-online.js](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/lipa-na-mpesa-online.js), [endpoints/lipa-na-mpesa-query.js](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/lipa-na-mpesa-query.js)):
`GET /oauth/v1/generate?grant_type=client_credentials`, `POST /mpesa/stkpush/v1/processrequest`, `POST /mpesa/stkpushquery/v1/query`; password = base64(shortcode+passkey+timestamp); `CustomerPayBillOnline`.
Token and health caches are keyed by environment + shortcode + credentials, so a sandbox token is never reused for production.

## Verification gate (unverified — must be confirmed in the current portal before activation)
The SDK is historical evidence, not proof of current merchant approval, callback signing, fees, limits, or whether the timestamp is UTC (the app uses Nairobi time). Current portal docs were not server-renderable during research (`/apis/<alias>` returns the generic SPA shell).

## Design (implemented, default OFF)
- **Admission** (new live checkouts) needs every adapter switch above AND Owner approval in the DB (`daraja_live_approval`, default `approved=false`, shortcode must match). Either off = no live admission.
- **Reconciliation** of already-admitted live rows needs only the configured production environment (mode live + env production + confirmed shortcode) and the row's immutable bound context (`payment_environment`, `daraja_shortcode`, `daraja_merchant_request_id`, exact CheckoutRequestID). Turning the kill switch or approval off never strands admitted payments. Callbacks are unsigned hints; the independent STK query is the proof.
- Test/sandbox rows and publication payments (test-only) are never queried with production credentials and vice versa; mismatches fail before any fetch.
- Migration `202610300015_daraja_live_approval.sql`: approval table (Owner RPCs, audited, direct access revoked), merchant context columns, `guard_live_payment_context` (immutable context; settlement requires persisted reference + merchant request ID + shortcode, also against the generic `record_verified_payment` RPC), and a **hard-OFF payout gate** (`payouts_enabled` is constrained false; `withdrawable_balance`, `request_payout` and `guard_test_payouts` all require it and non-pending provider fees). Unknown Daraja fees stay pending, funds held.
- STK init: only an explicit non-zero `ResponseCode` is a rejection. Timeouts, 5xx, malformed 2xx or missing IDs are **uncertain**: the pending row is kept, no automatic retry, response carries `paymentId`. The guest UI (`payment-intent.js`) stores that id, shows check-status, keeps one idempotency key per intent and blocks a second initiation. Live copy comes from trusted `options.mode` and warns of real money.
- Stripe/Paystack and publication checkout remain test-only.

## Validation
Mocked-network tests: `tests/daraja-live-gate.test.js`, `tests/daraja-live-reconcile.test.js` (plus existing suites). SQL: `tests/db/live-daraja.sql` runs only in the isolated CI migrations job (rolled back). No Production, provider, sandbox or payment activity was performed.

## Still required before any enablement
- Confirm the current Safaricom portal facts above (merchant approval, callback signing, fees, limits, timestamp zone).
- Payouts for live funds are not automated and remain disabled; enabling them needs a future reviewed migration.
## Owner onboarding actions
1. Complete Go Live in the Safaricom portal; record shortcode, passkey, keys in the host secret store.
2. Set the env keys above in a non-public environment, kill switch still unset.
3. Owner approves via `owner_set_daraja_live_approval` (protected Owner only).
4. **Separate explicit confirmation required** for (a) enablement and (b) a real-money test.


## Owner readiness and approval (protected Owner only)

- Owner-only `GET /api/admin?action=daraja-readiness` returns booleans (mode/environment, shortcode format and confirmation equality, credentials present, kill switch, Owner approval) and the callback URL to register. Adding `&health=1` runs an OAuth token probe only (never STK push or query) and only when credentials are configured for production, so it works with the kill switch off. No secrets, tokens or shortcode values are returned.
- Owner-only `POST /api/admin?action=daraja-approval` calls the audited `owner_set_daraja_live_approval`. Approving requires explicit confirmation, the exact configured production shortcode, and a passing OAuth readiness probe; revoking needs none of these and never touches the provider. SuperAdmin and Admin are refused.
- Approval does not turn on collection: the environment kill switch is a separate step, and a real-money test needs its own explicit confirmation. Payouts stay off.

