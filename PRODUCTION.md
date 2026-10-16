# Production setup and readiness

**Do not describe or use this repository as production-ready.** It contains a static browser demo plus a backend foundation. The dedicated WeddingSite Supabase project has both migrations applied, including the verified Colin-only Owner safeguards. PostgreSQL-compatible migration and Owner-behavior tests passed locally, and remote migration/grant status was checked. Remote schema lint could not connect because the CLI temporary database role needs `SUPABASE_DB_PASSWORD`; no password is configured or was exposed. The Owner account itself is not bootstrapped because no confirmed Colin Supabase Auth account exists yet. A Vercel Preview is protected by Vercel authentication; only the Supabase URL, public API key and payments-disabled flag are configured for Preview. There is no user-facing login or frontend/API integration, no Production environment configuration and no production release. Real payments and irreversible financial actions remain disabled.

## What is present

- Supabase SQL for platform roles, workspace memberships, Colin Mundia's protected Owner identity, wedding settings, fundraising, contributions, budgets, proposed expenses, payout requests, reconciliation records, audit events, provider policies, and a scheduled reminder queue.
- RLS and server-side RPC guards for workspace access, Client/Admin controls, verified-email and immutable-ID Owner bootstrap, protected Owner role changes, audit concealment from other roles, confirmed finance actions, payout balance limits, and verified payment webhook updates.
- Vercel serverless endpoints: `GET /api/auth/me`, `GET /api/finance?weddingId=…` (private report; add `&format=csv` for CSV), `POST /api/finance/actions`, `GET /api/ledger?weddingId=…&page=0&limit=10`, `GET /api/payments/options?weddingId=…&market=…&currency=…`, `POST /api/payments/checkout`, `POST /api/webhooks/stripe`, `POST /api/webhooks/paystack`, and the daily `/api/cron/queue-reminders`.
- Stripe Checkout and Paystack hosted-checkout adapters. Options fail closed unless provider keys match the selected test/live mode, server-side provider health succeeds, the global switch is explicitly enabled, and the wedding is published and configured for the selected market/currency. Checkout also checks origin, Turnstile, fundraiser, amount limits and explicit ledger-visibility consent. Signed/idempotent webhooks alone record a contribution as paid. The Stripe webhook endpoint is `/api/webhooks/stripe`; Paystack is `/api/webhooks/paystack`.
- GitHub Actions CI runs `npm run check` and `npm test`. It does not deploy. `vercel.json` configures security headers and an idempotent reminder-queue cron. The cron only queues work: no email or message is sent.
- Current Vercel Preview (authentication-protected): [platform](https://weddingsite-9jq2jlmv0-colyske.vercel.app/) · [guest site](https://weddingsite-9jq2jlmv0-colyske.vercel.app/client-site.html). The Vercel project is linked to `colyske/WeddingSite`, with `main` as the production branch; a direct preview deployment was created from the feature worktree.
- The dedicated Supabase project **WeddingSite** (`lvvtgxspwvmdhqyoyqyy`) is linked to this worktree. Migrations `202610160001` and `202610160002` are present in remote history. The unrelated `CareerBoost-AI` project (`zmirbpcrlrgrfdsfkdbb`) was not linked or changed.
- The verified Colin account count and protected Owner profile count are currently both zero. No invitation or account was created. Owner bootstrap can run only after Colin creates and confirms an Auth account.
- Vercel Preview currently has only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `WEDDINGSITE_LIVE_PAYMENTS_ENABLED` configured; no service-role, Turnstile, payment-provider or Production variables are present. Values were not retrieved or printed. Payment APIs remain fail-closed.

## Known incomplete work / blockers

1. **No user-facing login/session flow or backend-wired platform UI.** `/api/auth/me` accepts Supabase bearer tokens, but the HTML role switch is illustrative browser state. Frontend auth, tenant provisioning, membership management, production role UI, and session protection still need implementation.
2. **No production site publishing or publication-fee payment flow.** Fee/copy behavior in the browser is local demo data; the migration stores policy but does not implement a publication-fee order, provider checkout, or atomic publish gate.
3. **No persisted RSVP, atomic guest-capacity enforcement, AI content checks, moderation queue, or generated tenant-specific website service.** The static guest site is only a sample. Connect those controls server-side before using guest data or relying on safety/approval.
4. **No connected payment UI.** `client-site.html` does not request `/api/payments/options` or call checkout; it offers only a clearly labeled local demo pledge. Provider endpoints do not make a gateway available to guests until the frontend flow is reviewed and wired. No payment provider is enabled in the example configuration.
5. **Finance operations are partly recordkeeping.** Expense submission records proposals; payout submission only creates a request and cannot transfer funds. Reconciliation evidence is recorded for review; no external statement matching, dispute/refund handling, expense approval/settlement workflow, or payout execution exists.
6. **No notification delivery.** Cron queues due task reminders, but email/SMS/WhatsApp is not configured or sent. No WhatsApp-group bot is included.
7. **No live AI integration.** Writing ideas and browser heuristics are templates/demos and must not be used as moderation or privacy guarantees.
8. **Production integration and authorization remain incomplete.** Both migrations executed successfully in a PostgreSQL-compatible PGlite test database; Owner bootstrap/immutability/RLS scenarios passed; and the dedicated WeddingSite remote migration history and grants were checked. Remote schema lint remains blocked until an operator supplies the database password through a secure local environment or runs an equivalent review in the Supabase Dashboard. Do not use the prototype with real wedding or payment data until a full security review, auth integration, rollback plan and production launch approval are complete.

## Required provider projects and dashboard values

Create the accounts/projects in the chosen provider dashboards. Enter secret values directly into their encrypted secret stores; **never paste secrets into chat or commit them**. Use separate Supabase/Vercel environments and test credentials for development, preview and production.

### Supabase

The dedicated WeddingSite Supabase project already exists; do not use or link the unrelated CareerBoost project. Both migrations are applied there. The second migration binds the sole immutable Owner identity to Colin Mundia's confirmed Auth email (`colyske@gmail.com`) and verified user ID; it does not create an account, send an invite, or bootstrap a user automatically. The remote project currently has no confirmed Colin account and no Owner profile. Colin must first create an account using the normal Supabase Auth flow and complete email verification. Then, an authorized operator can run this in **WeddingSite → SQL Editor**:

```sql
select public.bootstrap_protected_owner(id)
from auth.users
where lower(email) = 'colyske@gmail.com'
  and email_confirmed_at is not null;
```

The function independently verifies that the supplied ID belongs to the confirmed account; calling it before signup returns no rows. It is not executable by `anon`, `authenticated`, or ordinary app users. Verify the result in the privileged SQL Editor (`select count(*) from public.profiles where platform_role = 'owner';`). There must be exactly one row. No other account can bootstrap, promote itself, replace that ID, demote/delete the profile, or inspect Owner profile/audit metadata through the ordinary role APIs. Routine ownership transfer is disabled. Recovery is a separately reviewed, privileged break-glass procedure and must preserve the same verified identity requirement. Do not invite or provision the account on Colin's behalf.

The Supabase CLI migration push and Management API query succeeded without exposing a database password. A CLI `db lint` connection uses a temporary database role and currently fails password authentication. If that CLI lint is required, the project operator must provide `SUPABASE_DB_PASSWORD` directly to the local CLI process using a secure local secret store, or review the schema from the Supabase Dashboard. This is a local operator credential, not a Vercel runtime variable; do not commit it or put it in chat.

Copy these from **Supabase → Project Settings → API** into the corresponding Vercel environment only:

| Vercel variable | Supabase value | Handling |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | Public configuration. |
| `SUPABASE_ANON_KEY` | Publishable/anon key | Public project key; still enforce RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role secret key | Server-only secret; never expose to browsers or CI logs. |

Enable and test the chosen Supabase Auth sign-in method, email verification, redirect URLs, SMTP, rate limits, backups/PITR, and database region/retention settings. The current front end does not implement sign-in yet.

### Vercel project configuration

The `weddingsite` Vercel project already exists in the `colyske` account and is linked to `colyske/WeddingSite`, with `main` as its production branch. The hosted Preview is protected by Vercel authentication. Use the repository root; no framework build command is required. The Preview currently has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `WEDDINGSITE_LIVE_PAYMENTS_ENABLED=false`; no Production variables, server-role key, Turnstile secret, or payment-provider credentials are configured. Configure any future variables in **Vercel → Project `weddingsite` → Settings → Environment Variables**, selecting Development/Preview/Production scopes carefully:

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

The repository's `.github/workflows/ci.yml` uses GitHub-hosted runners to run only syntax checks and unit tests. It does not deploy. Vercel is linked to the GitHub repository. The protected Preview was created from the feature branch; a redeployment of the latest source is still required after pushing these Owner safeguards. Do not add service secrets to GitHub Actions when Vercel can hold them directly. Production remains unconfigured and must not be promoted without explicit release approval.

## Safe rollout checklist

1. For future schema changes, rehearse in a disposable Supabase project; the current ordered migrations are applied only to the dedicated WeddingSite project. Verify RLS with anon, Client, Admin, SuperAdmin, and the verified Owner test identity, and confirm sensitive fields/fees stay private.
2. Implement sign-in, session refresh, workspace APIs/UI, durable RSVP/capacity, client-owned data changes, privacy-safe AI moderation with human review, and real fee-gated publishing.
3. Complete finance approvals, refunds/disputes, statement reconciliation, audit retention/export, payout authorization and execution controls. Re-test concurrent balances and idempotent webhooks.
4. Wire a guest checkout UI that requests server-verified options and displays only currently configured providers. Add currency exponent support, legal receipts, privacy consent, anti-abuse, accessibility and failure recovery. Verify in provider test mode; never use a local demo pledge as a payment signal.
5. Implement and verify email/reminder delivery; queue-only cron must remain described as queue-only until an approved sender is wired.
6. Deploy to a private preview first. Verify headers, authentication, tenant isolation, origin checks, provider-mode checks, webhook signatures, FX outages, backups, observability, rate limits, deletion/export policies and rollback.
7. Obtain explicit Owner approval before production DNS/public site release or enabling live payment charges. Do not incur fees, publish publicly, configure live secrets, or enter real guest data without that approval.
