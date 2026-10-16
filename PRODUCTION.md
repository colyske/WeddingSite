# Production setup and readiness

**Do not describe or use this repository as production-ready.** It contains a static browser demo plus a backend foundation. No provider credentials were inspected or configured, the SQL migration has not been run against a real Supabase project, no frontend authentication/API integration exists, and nothing was deployed or publicly published. Payments and irreversible financial actions remain disabled.

## What is present

- Supabase SQL for platform roles, workspace memberships, an undeletable/non-demotable Owner record, wedding settings, fundraising, contributions, budgets, proposed expenses, payout requests, reconciliation records, audit events, provider policies, and a scheduled reminder queue.
- RLS and server-side RPC guards for workspace access, Client/Admin controls, protected Owner role changes, confirmed finance actions, payout balance limits, and verified payment webhook updates.
- Vercel serverless endpoints: `GET /api/auth/me`, `GET /api/finance?weddingId=…` (private report; add `&format=csv` for CSV), `POST /api/finance/actions`, `GET /api/ledger?weddingId=…&page=0&limit=10`, `GET /api/payments/options?weddingId=…&market=…&currency=…`, `POST /api/payments/checkout`, `POST /api/webhooks/stripe`, `POST /api/webhooks/paystack`, and the daily `/api/cron/queue-reminders`.
- Stripe Checkout and Paystack hosted-checkout adapters. Options fail closed unless provider keys match the selected test/live mode, server-side provider health succeeds, the global switch is explicitly enabled, and the wedding is published and configured for the selected market/currency. Checkout also checks origin, Turnstile, fundraiser, amount limits and explicit ledger-visibility consent. Signed/idempotent webhooks alone record a contribution as paid. The Stripe webhook endpoint is `/api/webhooks/stripe`; Paystack is `/api/webhooks/paystack`.
- GitHub Actions CI runs `npm run check` and `npm test`. It does not deploy. `vercel.json` configures security headers and an idempotent reminder-queue cron. The cron only queues work: no email or message is sent.

## Known incomplete work / blockers

1. **No user-facing login/session flow or backend-wired platform UI.** `/api/auth/me` accepts Supabase bearer tokens, but the HTML role switch is illustrative browser state. Frontend auth, tenant provisioning, membership management, production role UI, and session protection still need implementation.
2. **No production site publishing or publication-fee payment flow.** Fee/copy behavior in the browser is local demo data; the migration stores policy but does not implement a publication-fee order, provider checkout, or atomic publish gate.
3. **No persisted RSVP, atomic guest-capacity enforcement, AI content checks, moderation queue, or generated tenant-specific website service.** The static guest site is only a sample. Connect those controls server-side before using guest data or relying on safety/approval.
4. **No connected payment UI.** `client-site.html` does not request `/api/payments/options` or call checkout; it offers only a clearly labeled local demo pledge. Provider endpoints do not make a gateway available to guests until the frontend flow is reviewed and wired. No payment provider is enabled in the example configuration.
5. **Finance operations are partly recordkeeping.** Expense submission records proposals; payout submission only creates a request and cannot transfer funds. Reconciliation evidence is recorded for review; no external statement matching, dispute/refund handling, expense approval/settlement workflow, or payout execution exists.
6. **No notification delivery.** Cron queues due task reminders, but email/SMS/WhatsApp is not configured or sent. No WhatsApp-group bot is included.
7. **No live AI integration.** Writing ideas and browser heuristics are templates/demos and must not be used as moderation or privacy guarantees.
8. **SQL parser/database validation is pending.** Apply only to a disposable Supabase development project first; review migration behavior, RLS, grants, function ownership and upgrade/rollback strategy before any production data.

## Required provider projects and dashboard values

Create the accounts/projects in the chosen provider dashboards. Enter secret values directly into their encrypted secret stores; **never paste secrets into chat or commit them**. Use separate Supabase/Vercel environments and test credentials for development, preview and production.

### Supabase

Create a Supabase project with Auth enabled, and apply `supabase/migrations/202610160001_finance_and_access.sql` in a development project using the Supabase SQL editor or the approved Supabase CLI workflow. The migration creates an auth-user profile as `client`; it does not create a protected Owner automatically. After verifying the intended first Owner's Supabase Auth user ID, an authorized project operator must bootstrap that account in the SQL editor, for example:

```sql
update public.profiles
set platform_role = 'owner'
where id = '<verified-auth-user-uuid>';
```

Confirm exactly one Owner exists before proceeding. The migration prevents routine Owner demotion/deletion and routine Owner transfer; recovery/transfer requires a separately reviewed break-glass process. Do not seed real guest or payment data in the prototype.

Copy these from **Supabase → Project Settings → API** into the corresponding Vercel environment only:

| Vercel variable | Supabase value | Handling |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | Public configuration. |
| `SUPABASE_ANON_KEY` | Publishable/anon key | Public project key; still enforce RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role secret key | Server-only secret; never expose to browsers or CI logs. |

Enable and test the chosen Supabase Auth sign-in method, email verification, redirect URLs, SMTP, rate limits, backups/PITR, and database region/retention settings. The current front end does not implement sign-in yet.

### Vercel project configuration

Import the repository into Vercel only after the owner approves the target account/team and private preview setup. Use the repository root; no framework build command is required. Add the following variables in **Vercel → Project → Settings → Environment Variables**, selecting the correct Development/Preview/Production scopes:

| Name | Required for | Guidance |
| --- | --- | --- |
| `SUPABASE_URL` | API/database access | From the Supabase project. |
| `SUPABASE_ANON_KEY` | User-token validation | From Supabase API settings. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only scheduled/provider operations | Secret; Vercel server runtime only. |
| `WEDDINGSITE_PUBLIC_ORIGIN` | Hosted checkout | Exact HTTPS origin with no path, e.g. `https://preview.example`; HTTPS is required except localhost testing. |
| `WEDDINGSITE_LIVE_PAYMENTS_ENABLED` | Any real hosted checkout | Keep `false` until authorized and end-to-end tested; set `true` only after owner approval. |
| `WEDDINGSITE_PAYMENT_MODE` | Provider key-mode check | `test` until separately approved for live charges; `live` requires live-mode approval. |
| `TURNSTILE_SECRET_KEY` | Hosted checkout abuse prevention | Cloudflare Turnstile secret; server-side only. Checkout rejects requests without a valid challenge. |
| `STRIPE_SECRET_KEY` | Stripe adapter | Use a restricted test key initially; server-side only. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification | Secret created for the exact `/api/webhooks/stripe` endpoint/environment. |
| `STRIPE_SUPPORTED_CURRENCIES` | Stripe availability allowlist | Comma-separated ISO currency codes enabled for the relevant Stripe account. |
| `STRIPE_SUPPORTED_MARKETS` | Stripe availability allowlist | Comma-separated configured market codes; coordinate exact codes with product configuration. |
| `PAYSTACK_SECRET_KEY` | Paystack adapter | Test secret key initially; server-side only. |
| `PAYSTACK_SUPPORTED_CURRENCIES` | Paystack availability allowlist | Comma-separated ISO currency codes supported by the account. |
| `PAYSTACK_SUPPORTED_MARKETS` | Paystack availability allowlist | Comma-separated configured market codes. |
| `CRON_SECRET` | Vercel scheduled queue endpoint | Long random secret; Vercel Cron sends it in an Authorization header. |

`TURNSTILE_SITE_KEY` is public site configuration, not a secret; only add it to frontend configuration after a Turnstile widget is implemented. The current HTML does not render that widget and has no checkout UI, so provider keys alone do **not** make guest payments available.

The example `.env.example` lists these names without real values. Never put secret values in HTML, browser JavaScript, `NEXT_PUBLIC_*`, GitHub source files, screenshots, issue comments, or chat.

### Stripe / Paystack setup (test mode only, after approval)

1. Create the provider project under the owner's account. Configure business verification, merchant settlement details, supported currencies/markets, refunds/disputes and required compliance directly in that provider.
2. Start with Stripe test keys (`sk_test_…`) or Paystack test key (`sk_test_…`). Set `WEDDINGSITE_PAYMENT_MODE=test`, configure the appropriate allowlists and create provider webhook endpoints pointing at the Vercel deployment's exact webhook URLs.
3. Add each generated webhook signing secret/key only to its matching Vercel environment. Keep the global live-payments switch off until webhook delivery, idempotency, amount/currency matching, privacy consent and reconciliation have been tested.
4. A wedding also needs a matching enabled row in `payment_provider_configs`, set through the authenticated `configure_payment_provider` RPC. The current UI does not call the API/RPC, so this remains an integration step; do not enable a wedding manually for real payments until UI, consent and settlement flows have been completed and reviewed.
5. The availability endpoint checks environment shape, provider API health, wedding publication and per-wedding market/currency rules. It does not settle funds or prove the complete merchant, tax, compliance, or payout setup.

The `api/payments/checkout.js` currently sends an amount to hosted checkout and stores only ledger essentials; Paystack additionally receives the guest email for provider checkout and it is not written to the contribution row. Confirm provider data-processing terms and retention before use. Currency minor-unit exponent handling beyond two-decimal currencies must be tested and added before enabling currencies such as JPY.

## Currency and FX

Wedding-selected currency is the primary display unit; USD is its bracketed equivalent. FX values are for display only and must never set provider settlement or accounting amounts. The browser demo fetches ExchangeRate-API's current open USD feed and shows provider/rate time/fetch time/stale/unavailable state. Production FX service choice, contractual terms, uptime monitoring, market support and rate snapshots for audit are not configured.

## GitHub and deployment controls

The repository's `.github/workflows/ci.yml` uses GitHub-hosted runners to run only syntax checks and unit tests. There is no GitHub deploy workflow, Vercel token, Supabase credential, automatic publication, or production environment secret in this repository. If adding automatic deployment later, the owner must approve repository permissions, branch/environment protection and required reviews, then store a narrowly scoped Vercel deployment token in GitHub Actions secrets. Do not use repository secrets for application service keys if Vercel can hold them directly.

## Safe rollout checklist

1. Review and run the migration in a disposable development Supabase project; verify RLS with anon, Client, Admin, SuperAdmin, and Owner test users, and confirm sensitive fields/fees stay private.
2. Implement sign-in, session refresh, workspace APIs/UI, durable RSVP/capacity, client-owned data changes, privacy-safe AI moderation with human review, and real fee-gated publishing.
3. Complete finance approvals, refunds/disputes, statement reconciliation, audit retention/export, payout authorization and execution controls. Re-test concurrent balances and idempotent webhooks.
4. Wire a guest checkout UI that requests server-verified options and displays only currently configured providers. Add currency exponent support, legal receipts, privacy consent, anti-abuse, accessibility and failure recovery. Verify in provider test mode; never use a local demo pledge as a payment signal.
5. Implement and verify email/reminder delivery; queue-only cron must remain described as queue-only until an approved sender is wired.
6. Deploy to a private preview first. Verify headers, authentication, tenant isolation, origin checks, provider-mode checks, webhook signatures, FX outages, backups, observability, rate limits, deletion/export policies and rollback.
7. Obtain explicit Owner approval before production DNS/public site release or enabling live payment charges. Do not incur fees, publish publicly, configure live secrets, or enter real guest data without that approval.
