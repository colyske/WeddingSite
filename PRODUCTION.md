# Production setup and readiness

## Current operational status

The current public platform is **Join Our Wedding** at
https://www.joinourwedding.site. The fictional, read-only showcase is
https://showcase-wedding.joinourwedding.site, pinned on the homepage as
**View the showcase wedding**. Its sample data is not in wedding finance,
reporting or payout records, and checkout is disabled server-side.

Authentication/PKCE return, persistent wedding editing/publishing, guest RSVP,
verified-payment song bids, consented contribution lists, sponsor social cards,
KYC-gated payout requests and independent SuperAdmin/Owner provider switches are
implemented. The user has confirmed successful Google sign-in. Google's
Supabase-domain label remains separate, optional paid branding setup; see
README for the custom auth domain and Google consent-screen steps.

Payment adapters remain **test/sandbox only**. Never enable live payment or
remove Turnstile as a testing shortcut. A human-assisted test must be staged
before submission, identify provider/amount/currency/test number and obtain the
human's explicit confirmation. An embedded-browser widget not appearing is a
test blocker, not permission to bypass it. A real Safaricom phone can be charged
even in sandbox; do not substitute a real number for a test number.

The human normal-browser Paystack test on 2026-10-29 succeeded: KES 5 Atoti song
bid, one settlement event, one song credit and no fulfilment exception. The
simulated accounting record is 500 minor gross minus 40 platform fee = 460;
the separate 15 provider fee leaves 445 after both charges. Provider fees are
borne by the couple, not silently absorbed by the platform. This is **not**
real collection. Migration012 labels existing/new guest payments `test`,
prevents relabelling them live, excludes them and their adjustment credits
from withdrawable balances, and blocks test-funded payout requests/statuses.
Historic amounts, song credits and payment events are preserved.

Regular Admins have client support, per-wedding metrics and exception queues,
not organization overview, global ledger/payout history, audit or fee/settings
access. SuperAdmins and Owner can read those areas and manage permitted roles.
Only the protected Owner can change fee/payout/refund policies; provider
switches may be changed by SuperAdmins or Owner. API, RPC and RLS enforce this.
New free/in-kind solicitation/approval is retired, including stale-tab/direct
writes. Historical enquiries and already-approved cards remain on record.

Publication checkout is separate from wedding contributions and uses `test_paid`,
excluded from collected publication revenue. New USD-canonical fee conversion,
immutable FX evidence, freshness and rounding rules are described in README.
Historical fee/checkout records are not repriced; already-published unsettled
quotes are not automatic debt. Publication never requires KYC; payout request
and staff approval/sent require the existing both-partner KYC model.

### Remaining launch boundaries

- Provider-confirmed end-to-end success is not established by accepting an STK
  initiation or returning from hosted checkout. Failed sandbox results must
  produce no paid ledger/song credit. Live collection requires separate
  implementation/review and explicit approval, not just changing an env flag.
- Payouts are controlled requests/status records, not an automated money-transfer
  rail. Confirm the operational settlement, refunds/disputes and reconciliation
  process with the merchant before promising real disbursement.
- `/api/reminders` queues reminders and explicitly returns `sent: 0`; there is
  no outbound notification-delivery integration.
- WhatsApp group assistant, official business webhook/inbox and approved sync
  remain integration work. No bot can be claimed to join arbitrary groups.
- `ai-guidance.js` supplies authored hints/templates, not a connected AI model.
- Broad display currencies do not imply universal accounting/provider support.
  Existing wedding monetary contracts use two decimal places. Other exponents
  must not be enabled without an end-to-end monetary-unit migration.
- Production assets have been reviewed at 320/375/768/1280px; authenticated
  dashboard/payment fixtures are not a claim of real provider settlement.

Use **only** Supabase project `lvvtgxspwvmdhqyoyqyy`. Before each approved
migration, dry-run against that explicit project, inspect the exact pending
filenames and stop on unexpected changes. CI's migration job uses an isolated
local database; it never applies Production migrations. Run rollback SQL tests
only in that isolated database. Keep secrets in provider/environment secret
stores, never chat/source. Do not run broad Auth/config pushes to fix one URL.

## Historical initial-prototype record (not current operating instructions)

**Everything below records the original prototype state and may be obsolete.**
Do not use its old preview URL, Auth configuration, migration counts or missing-
feature statements to configure the current service. Refer to the current
README and the live, explicitly authorized environment instead.

## What is present

- Supabase SQL for platform roles, workspace memberships, Colin Mundia's protected Owner identity, wedding settings, fundraising, contributions, budgets, proposed expenses, payout requests, reconciliation records, audit events, provider policies, and a scheduled reminder queue.
- RLS and server-side RPC guards for workspace access, Client/Admin controls, verified-email and immutable-ID Owner bootstrap, protected Owner role changes, audit concealment from other roles, confirmed finance actions, payout balance limits, and verified payment webhook updates.
- Vercel serverless endpoints: `GET /api/auth/me`, `GET /api/finance?weddingId=…` (private report; add `&format=csv` for CSV), `POST /api/finance/actions`, `GET /api/ledger?weddingId=…&page=0&limit=10`, `GET /api/payments/options?weddingId=…&market=…&currency=…`, `POST /api/payments/checkout`, `POST /api/webhooks/stripe`, `POST /api/webhooks/paystack`, and the daily `/api/cron/queue-reminders`.
- Stripe Checkout and Paystack hosted-checkout adapters. Options fail closed unless provider keys match the selected test/live mode, server-side provider health succeeds, the global switch is explicitly enabled, and the wedding is published and configured for the selected market/currency. Checkout also checks origin, Turnstile, fundraiser, amount limits and explicit ledger-visibility consent. Signed/idempotent webhooks alone record a contribution as paid. The Stripe webhook endpoint is `/api/webhooks/stripe`; Paystack is `/api/webhooks/paystack`.
- GitHub Actions CI runs `npm run check` and `npm test`. It does not deploy. `vercel.json` configures security headers and an idempotent reminder-queue cron. The cron only queues work: no email or message is sent.
- Current Vercel Preview (authentication-protected): [platform](https://weddingsite-git-colyske-wedlink-wedding-platform-colyske.vercel.app/) · [guest site](https://weddingsite-git-colyske-wedlink-wedding-platform-colyske.vercel.app/client-site.html). The Vercel project is linked to `colyske/WeddingSite`, with `main` as the production branch; the feature-branch alias follows its latest Preview deployment.
- The dedicated Supabase project **WeddingSite** (`lvvtgxspwvmdhqyoyqyy`) is linked to this worktree. Migrations `202610160001` and `202610160002` are present in remote history. The unrelated `CareerBoost-AI` project (`zmirbpcrlrgrfdsfkdbb`) was not linked or changed.
- A remote count/query confirms Colin's Auth email is verified and his profile has `platform_role = 'owner'`; no additional invitation or bootstrap is needed.
- The original invite link was generated with a localhost redirect and must not be reused. The current Supabase Auth `site_url` is the protected Vercel feature-branch Preview; allowed redirects include that Preview and the local loopback development server. The Preview itself requires Vercel authentication, so a public, app-owned callback URL and real sign-in flow are still required before issuing future invitations.

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

The dedicated WeddingSite Supabase project already exists; do not use or link the unrelated CareerBoost project. Both migrations are applied there. The second migration binds the sole immutable Owner identity to Colin Mundia's confirmed Auth email (`colyske@gmail.com`) and verified user ID. The remote project currently has one confirmed Colin account and one Owner profile. The one-time bootstrap has already been completed; do not invite or bootstrap him again.

The Auth redirect settings were corrected after the original invitation was generated. The repository's `supabase/config.toml` now reflects the live Site URL and redirect allow-list instead of the old `localhost:3000` setting. The old link's localhost redirect cannot be fixed by upgrading the Supabase plan, and the link should not be reused. The current Site URL points at the Vercel feature-branch Preview, which is access-protected; do not issue future account invitations until a public, approved sign-in/callback URL is deployed and added to **Authentication → URL Configuration → Redirect URLs**. The old invitation URL exposed an access token and refresh token. Its access token is expired, and a remote check found no active Auth sessions for Colin. Do not paste or reuse the link or tokens.

Do not run `supabase config push` just to change redirect URLs: `supabase config diff` currently shows unrelated Auth, MFA, database-pooler, and storage settings that differ between the local file and the live project. Review those differences separately before any config push.

```sql
select
  count(*) as owner_profiles,
  count(*) filter (
    where lower(u.email) = 'colyske@gmail.com'
      and u.email_confirmed_at is not null
  ) as confirmed_colin_owner_profiles
from public.profiles p
left join auth.users u on u.id = p.id
where p.platform_role = 'owner';
```

Expected result: `owner_profiles = 1` and `confirmed_colin_owner_profiles = 1`. The one-time bootstrap function is restricted to `service_role`; it independently verifies the confirmed account. No other account can bootstrap, promote itself, replace that ID, demote/delete the profile, or inspect Owner profile/audit metadata through the ordinary role APIs. Routine ownership transfer is disabled. Recovery is a separately reviewed, privileged break-glass procedure and must preserve the same verified identity requirement. Do not invite or provision the account on Colin's behalf.

The application code does not read `SUPABASE_DB_PASSWORD`; the server endpoints read `SUPABASE_URL` and the public `SUPABASE_ANON_KEY` and/or server-only `SUPABASE_SERVICE_ROLE_KEY`. The database password is only useful to privileged database tooling such as Supabase CLI lint or direct database administration. Vercel does not automatically pass its configured value to a CLI running on a developer's computer. The CLI lint has not yet succeeded; use the Supabase Dashboard review or run the CLI with the value supplied through a secure local environment/secret store. Since the app does not need this password at runtime, remove it from Vercel Development/Preview/Production unless a separately reviewed Vercel server task has a specific need. Never commit or paste it into chat.

Copy these from **Supabase → Project Settings → API** into the corresponding Vercel environment only:

| Vercel variable | Supabase value | Handling |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | Public configuration. |
| `SUPABASE_ANON_KEY` | Publishable/anon key | Public project key; still enforce RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role secret key | Server-only secret; never expose to browsers or CI logs. |

Enable and test the chosen Supabase Auth sign-in method, email verification, redirect URLs, SMTP, rate limits, backups/PITR, and database region/retention settings. The current front end does not implement sign-in yet.

### Vercel project configuration

The `weddingsite` Vercel project already exists in the `colyske` account and is linked to `colyske/WeddingSite`, with `main` as its production branch. The latest feature-branch Preview was redeployed after the Owner safeguards and is Ready; Vercel authentication still protects it. Use the repository root; no framework build command is required. Preview has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `WEDDINGSITE_LIVE_PAYMENTS_ENABLED=false`. `SUPABASE_DB_PASSWORD` exists in all three scopes, but the app does not use it. Production has no `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, Turnstile secret, or payment-provider credentials. Configure future application variables in **Vercel → Project `weddingsite` → Settings → Environment Variables**, selecting Development/Preview/Production scopes carefully:

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

The repository's `.github/workflows/ci.yml` uses GitHub-hosted runners to run only syntax checks and unit tests. It does not deploy. Vercel is linked to the GitHub repository and automatically builds feature-branch Previews. The current protected Preview is Ready. Do not add service secrets to GitHub Actions when Vercel can hold them directly. Production remains unconfigured and must not be promoted without explicit release approval.

## Safe rollout checklist

1. For future schema changes, rehearse in a disposable Supabase project; the current ordered migrations are applied only to the dedicated WeddingSite project. Verify RLS with anon, Client, Admin, SuperAdmin, and the verified Owner test identity, and confirm sensitive fields/fees stay private.
2. Implement sign-in, session refresh, workspace APIs/UI, durable RSVP/capacity, client-owned data changes, privacy-safe AI moderation with human review, and real fee-gated publishing.
3. Complete finance approvals, refunds/disputes, statement reconciliation, audit retention/export, payout authorization and execution controls. Re-test concurrent balances and idempotent webhooks.
4. Wire a guest checkout UI that requests server-verified options and displays only currently configured providers. Add currency exponent support, legal receipts, privacy consent, anti-abuse, accessibility and failure recovery. Verify in provider test mode; never use a local demo pledge as a payment signal.
5. Implement and verify email/reminder delivery; queue-only cron must remain described as queue-only until an approved sender is wired.
6. Deploy to a private preview first. Verify headers, authentication, tenant isolation, origin checks, provider-mode checks, webhook signatures, FX outages, backups, observability, rate limits, deletion/export policies and rollback.
7. Obtain explicit Owner approval before production DNS/public site release or enabling live payment charges. Do not incur fees, publish publicly, configure live secrets, or enter real guest data without that approval.
