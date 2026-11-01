# WeddingSite

## Current hosted service

The current platform is [Join Our Wedding](https://www.joinourwedding.site).
The pinned [fictional showcase](https://showcase-wedding.joinourwedding.site/) is a
read-only fixture served by the application, not a database wedding. Its sample
contributions, guests and sponsor never enter reporting or payout metrics. Both
guest writes and checkout are blocked server-side for its reserved slug/ID.

Public contribution rows use confirmed `paid_amount_minor`, contribution type,
consented display name and date; amounts are divided by 100 in the wedding's
currency. Sponsor social profiles accept only HTTPS links on the named common
platform's domain. Contact details belong in designated contact fields, not free
text; browser/API validation and database content triggers enforce this for new
or changed content without rewriting historical records. This is an abuse
deterrent, not a guarantee against every creative encoding.

**SuperAdmin/Owner → Fees & settings → Enabled payment methods** controls the
platform-level provider allowlist independently for M-Pesa/Daraja, Card/Paystack
and Card/Stripe. The default retains all previously eligible test adapters.
Credentials, markets/currencies, provider health and mode-specific gates must still
pass; a provider switch cannot by itself enable live payments. Daraja has its
separate [live collection gates](docs/LIVE-DARAJA-READINESS.md). The additive
[Paystack live collection](docs/LIVE-PAYSTACK-READINESS.md) supports standard
platform-collected guest payments and platform-only publication, default-OFF.
The audited Owner-only settlement-mode control cannot select split settlement
until its account-specific allocation/statement contract is verified. Standard
collection does not require split eligibility or couple subaccount onboarding.
Options and checkout creation read
the current database policy, and a database insert guard rejects disabled
providers even from stale tabs. Disabling affects new intents, never reroutes,
cancels or prevents verification of an already-created payment. Changes require
confirmation and are audited. No configuration is silently enabled on save.

### Organizer-selected guest amount suggestions

The wedding editor stores optional `amount_presets` as
`{ currency, song: [minorUnits], gift: [minorUnits] }` via migration
`202610300014_wedding_amount_presets.sql`. Song suggestions cover new requests,
existing songs and their payment dialog. Gift suggestions cover registry gifts,
celebration/fundraising campaigns and milestone payment dialogs. Custom entry
remains available. Fixed offers, sponsor bid minimums, RSVP/publication fees,
account balances and protected Owner financial policy are not changed.

Lists contain 1-6 amounts, sorted and deduplicated on both API and database
writes. The editor parses at most two decimal places; persisted values must be
integer hundredths in a supported two-decimal currency and within the configured
checkout cap. Suggested shortcuts must be at least one major unit to match the
existing guest form minimum; this does not change checkout or custom-entry
policy. Unset weddings retain legacy song `[500,1000,2500,5000]` and gift
`[1000,2500,5000]` minor-unit defaults. Opening or saving unrelated settings
does not persist defaults or overwrite saved choices.

Changing currency clears the editor's draft lists, never converts or re-labels
saved amounts. Enter new lists or explicitly apply deterministic currency-aware
suggestions (KES or USD), then review/confirm before saving. API clients must
send `amountPresetsReviewed: true` and `amountPresetsBaseCurrency` with new
`amountPresets`, or an explicit `null` reset; stale currency edits are rejected.
The database rejects a saved preset currency that differs from its wedding.
Suggestions are not AI, do not infer guest wealth, do not call a model, and
never autosave. Non-USD labels may show a dated indicative USD equivalent from
the existing approved daily feed only while fresh (36 hours); FX never changes
the organizer's selected amounts. The read-only showcase keeps KES song
100/500/1000 and gift 500/1000/5000.

### Guided wedding drafts

Creation and the wedding editor use question-led sections with Back/Next, Skip,
direct section links, review, keyboard focus and live step announcements. The
`#step=` hash resumes the current section after reload/back; existing field, KYC,
moderation and payment links still work. An all-questions view remains available.
Optional giving and fee settings are disclosed progressively, not enabled by the
guide. Team invitations ask who should help, with what task and until when;
administrative tables and account/KYC/payout readiness remain separate.

The minimum identity is **nonblank couple names**. Currency, capacity and time
zone retain the visible existing defaults; the guide never invents names,
dates, venues or prices. Before creation, unsent answers are kept in this browser
tab only. After creating a draft, explicit **Save changes** writes answers to the
account so another signed-in device can resume; unsaved edits have a leave/reload
warning. Next and Skip do not save, submit, clear answers or publish.

`202611050001_guided_wedding_drafts.sql` permits missing date/location and empty
or partially answered venue lists on drafts/unpublished weddings. Omitted API
fields retain saved values; explicit null date/location or an empty/null venue
list clear them. Existing venue entries retain omitted fields when identified
by their saved ID. Core content and venues save in one transaction. Published
weddings require names, a site address, date, location and complete named,
dated, timed, addressed events including a wedding-day event. Database guards
apply to direct writes, couple/staff publishing and moderation approval; KYC is
not a publication gate. Existing published rows are not rewritten. Missing-date
fee quotes are explicitly unavailable, not guessed free/far-future quotes.

Create clients send a stable UUID `requestKey`. The database serializes retries
per account/key and returns the original saved wedding without consuming referral
intents again. Reusing a key with changed answers is rejected rather than
silently discarding edits. When the referral migration is installed, creation
always delegates to `referral_create_wedding`, even with no referral choice in
the request, preserving pending-intent disclosure. API and migrations must be
deployed together after separate release approval; no production migration,
payment/provider action or deployment is part of this change.

Draft regression coverage is in `tests/guided-setup.browser.test.js`,
`tests/guided-wedding-drafts.test.js` and the rollback-only
`tests/db/guided-wedding-drafts.sql` CI check.

### Support role and sandbox boundaries

Regular Admins have support weddings/metrics, client/regular-admin role lookup,
and exception queues, not organization-wide finance, audit, overview or settings.
SuperAdmins manage client/regular-admin roles; only Owner manages SuperAdmins.
Fee, payout and refund policy writes remain protected Owner-only, including
direct SQL/RPC boundaries. Guest test settlements retain their original
amounts and fulfilment, but are explicitly non-withdrawable; live settlement
cannot be enabled by an application or environment flag.

New free/in-kind sponsor enquiries and approvals are retired. Historical
records remain intact. Sponsor ads use the same validated, consent-aware card
in the guest site and editor, with accessible social/contact links. The
fictional showcase includes five pre-wedding events, KES 500/1,000/5,000 giving
suggestions and KES 100/500/1,000 song bids; all sample actions remain disabled.
Expandable help is usable with keyboard/touch. Story starters and guidance
are authored local templates, not a connected AI service.

### Publication checkout (test mode and separately approved live Paystack)

Nonzero publication quotes now have an authenticated checkout in the wedding
editor. The platform derives ownership, fee, currency and payment-method routing
server-side. The database locks and snapshots the quote when admitting checkout,
rejects stale amounts/currencies or disabled providers, and permits only one
unresolved intent per wedding. Already-published weddings are not newly charged.
Current policy still grants the first publication free unless the far-future
rule takes precedence; no fee setting is changed by this implementation.

Turnstile remains required. A provider return URL or accepted STK request cannot
settle a fee. Signed card events or authenticated provider queries must match
the stored reference, amount and currency. Separate `publication_checkouts`
records preserve attempts without creating contributions or couple payout credit.
Test settlement uses `publication_fees.status = 'test_paid'`, not `paid`, and is
excluded from collected-publication-revenue totals. Staff waivers are preserved
if they race a confirmed payment. Settled admitted quotes are not repriced when
policy changes; a changed wedding currency requires support review.

Publishing remains an explicit action after verification and never requires
KYC. Nonzero unpaid quotes continue to fail closed. Local polling is bounded;
timeout/query errors do not imply cancellation or permit a fresh charge.
Ambiguous initialization is held for review, not retried automatically. Support
can inspect the retained checkout reference and audit events; do not clear a
review hold without reconciling the recorded provider request. Provider refunds
or disputes retain separate staff review:
they do not credit wedding balances, automatically reverse fees or unpublish
an existing wedding. Historical published/unsettled quotes are not automatic debt.
Live Paystack publication uses its own environment/Owner gates, immutable
merchant/mode/quote context, independent verification and platform-only settlement
without splits. Live publication refunds/disputes hold new publication actions
until an audited Owner entitlement decision; no provider refund is initiated.
Live Daraja publication remains unsupported and is not enabled by Paystack.

### Paystack direct settlement

Live guest Paystack checkout uses one dynamic flat subaccount share: the platform
receives its Owner-configured fee and Paystack routes the remainder to the couple.
Actual provider fees and the Owner-selected fee bearer are verified, not estimated.
The receiving subaccount must be provider-verified for the exact merchant/mode/
currency, and the couple must consent to its current revision after completing
required-details-and-consent KYC (not independent ID verification). Publication
is not blocked by onboarding.

SQL and provider verification bind immutable amount/currency, fee policy,
USD-canonical fixed-fee FX, merchant/key fingerprint and destination context.
Direct allocations and statement reconciliation are reported separately and
**never become WeddingSite withdrawable funds**, including subsequent refunds or
disputes. Publication fees remain platform-only. All live Paystack controls stay
OFF by default; public documents and fixtures do not establish this account's
Kenya/currency/split eligibility. See the [readiness checklist](docs/LIVE-PAYSTACK-READINESS.md)
for prerequisites, unsupported evidence handling and separately approved activation.

### USD publication fees and supported currencies

Publication policy amounts are **USD cents**: `2500` means USD 25, not 25 in
every wedding currency. The far-future `5000` means USD 50; the first-publication
allowance and 18-month threshold are unchanged. Migration `202610300011` makes
this denomination explicit without changing historical fee or checkout rows.
New quotes use the wedding's currency with the USD base shown underneath.

The approved indicative quote source is ExchangeRate-API's daily
`https://open.er-api.com/v6/latest/USD` feed. The server validates and stores
immutable rate snapshots. Rates older than 36 hours, missing currencies and
invalid responses fail closed for new non-USD publication checkout. A retained
rate within 36 hours may be used if refresh fails, with its original published
timestamp visible. USD quotes require no external rate. Each admitted checkout
retains its USD amount, local amount, rate, source and timestamp; later rates
never reprice it. The quoted local minor-unit amount is rounded **up**; Daraja
rounds up to whole KES. This is a platform fee quote, not the provider's
settlement/accounting FX rate or a claim of live collected revenue.

Wedding creation/editing offers the runtime's supported ISO currencies with
**two decimal places**, matching the existing hundredths-based budget,
contribution, RSVP and payout contracts. The FX display engine also recognizes
zero/three/four-decimal ISO currencies, but these are not enabled for wedding
accounting or checkout: changing only a dropdown would misprice existing forms
and provider amounts. For example JPY/KRW (zero), KWD/BHD (three) and CLF (four)
remain display-only where the FX source publishes them. Precious-metal,
non-ISO and missing-rate codes do not acquire a conversion by default.
Currency support is not payment acceptance: checkout additionally requires
the configured merchant's explicit currency/market allowlist, provider health,
platform switch and test-mode credentials. Daraja remains Kenya/KES only.

Production Supabase Auth uses `https://www.joinourwedding.site` as its Site URL.
Redirects allow both platform origins and paths, the Production Vercel host and
existing local development callbacks; the stale preview is removed. Google
sign-in explicitly uses `/signin.html?oauth_state=...` on the requesting trusted
platform origin, with PKCE code exchange in the callback.

Google's `supabase.co` destination label is separate from the return URL.
Changing it requires a Supabase custom auth subdomain, available on a paid plan,
plus the [custom-domain add-on](https://supabase.com/docs/guides/platform/manage-your-usage/custom-domains)
at $0.0137/hour (approximately $10/month). Pro starts at $25/month; compute and
other usage may add charges. No paid add-on is enabled by this repository.
To configure after approval: register `auth.joinourwedding.site` with Supabase,
add its prescribed CNAME/TXT DNS records, wait for verification/TLS, add
`https://auth.joinourwedding.site/auth/v1/callback` to the Google OAuth client's
authorized redirect URIs, then activate the domain and update the auth URL.
Retain the old provider callback during transition. In Google Auth Platform
Branding, set the app name to **Join Our Wedding**, upload the supplied brand
logo, authorize `joinourwedding.site`, and set the homepage, privacy and terms
URLs to this platform. Google may require brand/domain verification. These
Google project changes require its administrator; do not purchase a plan or
claim verification on the user's behalf.

The older prototype notes below describe the initial static implementation, not
the current Production deployment.

WeddingSite contains two distinct experiences:

1. **The WeddingSite platform** (`index.html`) is a multi-tenant planning workspace concept with Client, Admin, and SuperAdmin permission previews. It demonstrates tenant setup, committee minutes and tasks, finance controls, site content review, publication-fee gating, wedding settings, and the separate guest-site preview.
2. **A generated wedding guest site** (`client-site.html`) is a polished invitation for the illustrative Amara Njeri and Kito Mwangi wedding, with RSVP, capacity, attire, optional dietary accommodation, DJ bids, fundraisers, consent-based public ledger, and currency display.

The browser UI is an interactive demo. A separate server-side foundation is also included under `api/`, `server/`, and `supabase/migrations/`; the static UI is not yet wired to those endpoints and this repository is **not production-ready**.

## Preview

**Hosted preview:** [WeddingSite on Vercel](https://weddingsite-git-colyske-wedlink-wedding-platform-colyske.vercel.app/) (platform) · [guest-site sample](https://weddingsite-git-colyske-wedlink-wedding-platform-colyske.vercel.app/client-site.html). This preview is protected by Vercel authentication; sign in to the WeddingSite Vercel team to open it. It is a sample demo, not a live wedding service.

Open `index.html` directly or serve the repository directory using Node.js:

```sh
npx serve .
```

Then open `/` for the platform and `/client-site.html` for the guest site. The pages use external Unsplash photography, Google Fonts, and current USD exchange rates from ExchangeRate-API; if FX is cached, stale, or unavailable, the UI labels that state rather than presenting a fixed rate as live.

The current worktree preview server is also available at [http://127.0.0.1:4173/](http://127.0.0.1:4173/) on this machine only; open `/client-site.html` for the guest sample. It binds to loopback and is not reachable from other devices.

## Demo role model and content review

- **Client** owns their wedding data, can edit details freely, and can approve guest-facing content. Safe wedding facts may auto-approve in the browser demo; uncertain, sensitive, committee-originated, or high-impact content stays private for human review.
- **Admin** coordinates assigned workspace tasks and drafts but cannot publish or change platform-level roles.
- **SuperAdmin** manages platform policy and support, but cannot publish client content. The platform API still requires a full privacy review before production use.
- The protected platform Owner is **Colin Mundia** (`colyske@gmail.com`). The Client/Admin/SuperAdmin preview does not display that identity or role, and the demo role selector cannot impersonate it. The database migration binds the role to Colin's confirmed Supabase Auth identity, prevents another user from acquiring it, and blocks deletion, demotion, or reassignment.

The role selector is for demonstration only; it is not authentication or authorization. The Owner-protection migration is applied to the dedicated Supabase project, but production enforcement still requires a real sign-in flow and frontend/API wiring. The one-time bootstrap requires Colin to have an existing, email-confirmed Supabase Auth account; no account is created or invited automatically. The AI-writing and moderation-like interactions are local examples/templates, not a connected AI model or a reliable safety service. Suggestions are not facts and remain editable.

## Wedding, currency, and payment behavior

- Wedding currency is the primary amount; the USD equivalent appears in brackets when a published exchange rate is available. Visitors can choose display currency. FX source, rate time, fetch time, stale status, and unavailable status are shown. Rates are indicative, not settlement quotes.
- Clients configure guest capacity, up to four palette colors, optional fundraising streams, song-bid amounts and the couple-funded optional meal accommodation. Guests must opt into the meal upgrade; no guest is unexpectedly charged. RSVP capacity enforcement and all public-site changes currently live only in browser storage.
- Guests can choose whether their ledger pledge is private, anonymous, or shown by a chosen name, and separately consent to public display. The demo does not convert a pledge to paid. Guests never see platform fee calculations; those belong in private Client/Admin accounting views.
- No payment gateway buttons are shown unless provider credentials are configured, server-side health checks pass, global payments are explicitly enabled, and the wedding, market, and currency have an enabled policy. With the current unconfigured demo, payment is unavailable and the guest UI only records local demo pledges.
- The fee settings and “paid publication fee” state in the browser UI are illustrations. There is no production publication-fee checkout or publishing gate.

## Server and database foundation

The repository includes:

- A Supabase PostgreSQL migration for workspace roles, tenant data, protected Owner records, contribution ledger, expenses, budget/payout/reconciliation, audit records, payment-provider policy, and reminder queueing with RLS and guarded RPCs.
- Vercel API functions for auth identity lookup, private finance reports/actions and CSV export, public consent-based ledger pagination, provider availability and hosted checkout, Stripe/Paystack signed webhook processing, and scheduled reminder queueing.
- Fail-closed Stripe and Paystack adapters. Provider health is checked server-side; payment availability also requires explicit per-wedding market/currency enablement. Verified webhooks alone can mark contributions as paid. No payout execution endpoint exists.
- `.env.example`, `vercel.json`, and GitHub Actions checks. The GitHub workflow runs syntax checks and unit tests only; it does not deploy.
- `supabase/config.toml` for local schema development and ordered migrations `202610160001_finance_and_access.sql` and `202610160002_protected_owner_identity.sql`. Both migrations are applied to the dedicated WeddingSite Supabase project, and Colin's confirmed Auth account has the protected Owner role. The role is ready in the database; the web app still has no sign-in or Auth callback flow.

These are foundations, not complete product integrations. There is no login UI or frontend session wiring, no persistent RSVP/capacity/content-publishing flow, no publication-fee checkout, no actual reminder delivery, no connected AI, and no production release. The current Vercel Preview serves the static demo; its production deployment is not the application release. Payment endpoints are not called by the current guest page.

## Local checks

Requires Node.js 20 or newer:

```sh
npm run check
npm test
```

See [PRODUCTION.md](PRODUCTION.md) for implementation gaps, dashboard configuration names, safe provider setup, and deployment steps. Never paste credentials into chat, commit them, enable live payments, or publish publicly without owner approval.
# Client-wedding referrals

`/api/referrals` is rewritten to the existing wedding function, which dispatches
to `server/referrals.js` before wedding-specific authentication and validation.
The referral handler retains its own authorization checks; sharing deployment
capacity keeps the API functions plus middleware within Vercel's Hobby limit.

Client referrals are separate from guest RSVP sharing. Any signed-in account can
opt in at `/referrals.html` with versioned consent. The couple reviews and may
decline attribution at wedding creation. First valid capture wins; accepted
attribution is immutable and grants no workspace or platform role.

The protected Owner controls the default-OFF/zero referral policy under **Client
referrals** in the back office. Policy writes require the current revision and
are audited. Rates are snapshotted when a contribution is admitted: later changes
apply to new contributions, not old pending/paid payments. Weddings created before
first activation remain ineligible. Referrers see aggregates only; global journal
and policy history are restricted to Owner/SuperAdmin, not regular Admin.

**HELD estimates only, not operational referral earnings. Payable is always zero.**
Only verified LIVE contributions with a platform fee count, net of confirmed
refund/dispute principal. Signed estimate corrections never change couple net,
provider amounts or payout balances. Currencies are never combined. There is no
funding attestation, unlock, provider request, transfer or payout route.

`funds_available_at` is a timer, not verified platform cash. Original provider
costs and Paystack allocation evidence exist, but platform-side settlement,
incremental loss/cost inventory and other revenue commitments are incomplete.
The cap contract therefore fails closed to zero available. Future funding/payout
work requires separately approved settlement and commitment reconciliation,
eligibility/control-account evidence, identity/KYC, jurisdictional tax review and
payout authorization. No verification or compliance approval is claimed here.

Self-account protection uses creator/owner IDs and legacy `client`-authority
membership IDs. Explicit partner-account UUID links do not yet exist: complete
partner/controlled-account exclusion requires a verified wedding-to-partner or
account-control relationship distinct from helper grants. Email is not identity
proof. Later helper/admin grants do not invalidate legitimate referrals.

Migrations `202611040001+` and SQL regression fixtures are for isolated local/CI
validation. Do not apply them to Production or merge a migration PR without
separate user approval.
