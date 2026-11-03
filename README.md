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

### Guest-entered contribution amounts

Guests type contribution and song-bid amounts; organizer/guest suggested-amount
controls are not shown. Starter copying neither reads nor writes legacy
`amount_presets`. Fixed package/offer prices, campaign goals, RSVP fees and
legal/payment minimum validation remain separate and unchanged.

### Public setup reuse and the showcase default

Browse published weddings at `/#weddings`. The retired `/inspiration.html` URL
redirects there (permanent hosting redirect and static fallback); its catalogue
UI/assets and discovery links are removed. Shared legacy fixture helpers remain
only for previously saved starter/retry compatibility, not product discovery.
**From scratch** uses the read-only, explicitly fictional showcase's reusable
configuration through the same unpaid, idempotent native draft path. A selected
public wedding overrides that default. The shared guest layout and saved palette,
event/activity sequence, feature choices and unpriced offering/goal structures
are populated, not merely previewed. No source wedding is edited.

Eligible public wedding pages also offer **Use this style**, for past, current
and future celebrations alike. `server/wedding-style.js` reads an explicit
allowlist of already-public platform configuration, not personal content or
nonpublic settings. It requires a published, unarchived, unrestricted source and
rechecks eligibility before staging a new creation. Public visibility is not
permission to reproduce original writing. Generic prompts replace real-source
package, event, registry, milestone and meal labels. Sources are never edited.

| Couple-configurable surface | Copied into starter | Needs personalization / review | Never copied |
|---|---|---|---|
| Theme/layout | Palette; existing shared platform layout | Colour choices | Photos, client-authored artwork, music URL |
| Pre-wedding / wedding-day events | Pre/main type, sequence, main-event flag; recognized activity types mapped to fixed editable labels; repeated public venues represented by generic venue groups | Own title, description, date, time, venue, address, map and instructions | Source prose, dates/times/addresses/map links, private planning tasks, assignees/status/history |
| Couple/story/site address | No real/fictitious identity claims | Own names, address slug, welcome story | Source names, identities, contacts |
| Guest RSVP | Supported fee structures and premium meal-choice count with generic labels | Fees, meal labels, capacity; standard fixed RSVP questions retain existing behaviour | Guest list, answers, attendance, passes, check-ins, custom questions (not supported) |
| Sponsorship offerings | Public tier count/prices; curated sample offerings; generic real-source package names/terms | Own names, offering promises and minimums | Sponsor identities, purchased sponsorships, paid amounts |
| Registry / fundraising | Goal and milestone structure, public target amounts, public feature switches | Own purpose/labels/targets and visibility | Amounts raised, reached-state, contributions, ledger |
| VIP offerings | Public total-seat offering and price, generic title/notes | Actual availability, description, own price | Seats sold, reservations, purchasers |
| Contribution/bid suggestions | Nothing; guests type amounts | Existing minimum validation remains | Source suggested amounts, bids or payments |
| Featured sponsorship | Public enabled offering's slot/minimum/increment structure; starter is always disabled with null dates | New campaign window and explicit enablement | Prior auction windows, bids, winners |
| FAQ/travel/attire | Neutral editable prompts | Own answers and guest guidance | Source FAQ/travel/attire/personal instructions |
| Money/account/privacy | Nothing | Own receiving/payment configuration and real consent | KYC, payout/provider/referral settings, helpers/invites, financial records |
| Publication/lifecycle | New private draft only | Own publication readiness/review | Published/paid/archive/moderation state, live-readiness claims |

Style entry goes directly to a private wedding guide, without a collection
preflight or redundant review form. Names may be left blank until the native
couple step, including From scratch. Actual referral
attribution still requires an explicit accept/decline decision. The native guide controls edit
packages, RSVP settings, registry/VIP, fundraising goals/milestones, featured
campaign structure and guest prompts; there is no duplicate setup form.
Other ordinary wizard entry points remain unchanged. No custom RSVP-question
schema is introduced. Names/story/date/venue readiness is not inherited.
Cover photos and guest instructions remain optional (the current wizard contract).

When destination and source currencies match, numeric configuration is retained
owner-only in `starter_pending_setup`, marked `reviewed:false` in its original source currency. No active fees, packages, goals,
VIP or featured offering is created until review. Palette/events/guest prompts,
meal labels and feature preferences are immediately editable; RSVP starts free.
The native currency step offers explicit same-currency application only after a
fresh authenticated collection check, or explicit omission of source prices.
A mismatch, empty result or failure is inline and does not block personalization
or discard pending structure. `wedding_starter_structures` stores independent,
owner-only unpriced editing scaffolds for packages, gifts, VIP/featured offers
and nested campaign milestones. They hydrate the actual native editors, survive
explicit omission and save/reload, and are not usable checkout offers.
Choosing a different destination currency clears **all** source amounts, including
nested milestone targets and already-reviewed configuration on never-published
private template drafts, retaining the unpriced structures. Currency changes
are refused if that template has publication or financial history; historical
records are never cleared, converted or relabelled. The server ignores old monetary
values in a currency-change save, not just the UI. Destination defaults never
silently pick the source currency. Pending monetary review blocks publication,
not private saves. Static accounting membership is pinned to the existing SQL
allowlist, not runtime ICU defaults, and is never proof of collection readiness.
The read-only showcase is an explicitly fictional demonstration, never a customer.
Standard custom-sponsorship/legal minimums are unchanged.

`server/starter-capabilities.js` reuses the shared read-only
`collectionCapabilities()` export; it does not duplicate provider rules or invoke
recording mode. An unavailable/malformed capability response fails explicitly
with 503 during money application, not unpaid creation. Migrations
`202611090001_wedding_starter_drafts.sql` and
`202611100002_deferred_wedding_starters.sql` are DB-first:
CI commits it on a populated predecessor and checks unchanged wedding/venue rows,
then tests the fresh schema and rollback-only `tests/db/wedding-starter-drafts.sql`.
Push CI also uploads `starter-mobile-evidence`: 320px/375px screenshots plus
the tested commit, asset hashes, overflow measurements and page errors. All
browser APIs are mocked; this is not deployed-backend or payment evidence.
It does not backfill live wedding content. Existing guided-draft/readiness
migrations through `202611080001` are prerequisites.

`create_deferred_wedding_starter` wraps the existing authenticated, referral-aware
`create_wedding_draft` transaction. The backend stages only a positively checked
source (not fabricated payment readiness). The entire normalized setup is bound
to owner/request key/full input hash, with a two-minute source-validation TTL.
It atomically stores pending money and reusable nonmoney setup. A retry returns
the same draft even after a lost response, without new source checks or overwriting
later edits. Money review is a separate owner-checked, service-only transaction;
the API freshly verifies supported same-currency collection for `apply`.
Review request keys/hashes prevent duplicate application and preserve replay
after a lost response even if availability later changes. Application refuses
to overwrite prices/goals already personalized while review was pending.
Late insertion failures roll back all changes and retain pending configuration.
The older reviewed-starter RPC remains compatible and still requires its
service-only capability proof; no existing payment gates are weakened.
Nothing records a provider configuration, transaction or publication state.
Tab drafts require explicit replacement, and sign-in retains the selected source.
The persisted tab snapshot keeps the complete original request stable through
retry/reload even if a public source later changes.

### Guided setup behaviour

Creation and the wedding editor use question-led sections with Back/Next, Skip,
direct section links, review, keyboard focus and live step announcements. The
`#step=` hash resumes the current section after reload/back; existing field, KYC,
moderation and payment links still work. An all-questions view remains available.
Optional giving and fee settings are disclosed progressively, not enabled by the
guide. Team invitations ask who should help, with what task and until when;
administrative tables and account/KYC/payout readiness remain separate.

Ordinary creation asks for **nonblank couple names**; a selected style can start
an unpaid private draft with names still unanswered. Publication always requires
the couple's own names. Currency, capacity and time
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

Turnstile remains required. Publication and guest checkout resolve the public
widget key as `TURNSTILE_SITE_KEY || TURNSTILE_PUBLIC_KEY` (SITE takes precedence).
Publication options expose no methods or widget key unless a public key and
`TURNSTILE_SECRET_KEY` are both present and the payment-mode gate permits admission.
Configuration alone does not establish provider readiness or live availability.
A provider return URL or accepted STK request cannot
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

## Historical initial-prototype record

The Preview, demo role model, wedding/payment behavior and server-foundation
sections below describe the initial prototype, not current live availability.
Their missing-feature and unconfigured-provider statements are historical;
use the current hosted-service and publication sections above and the
provider-specific readiness documents for implemented capabilities and gates.
No historical check establishes current Production configuration or settlement.

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
## Guarded manual external payouts (default OFF)

The shared manual control plane records statement-backed reservations, durable
execution claims, receipts and exact statement-debit reconciliation; the operator
moves money only outside the site in an authorized official portal. Migration
`202611130001` adds protected-Owner reviewed policy/readiness and deactivation,
without enabling admission or inventing operational settings. Other eligible staff
need two people; protected-Owner solo processing is explicit and retains every
evidence/accounting requirement. Deployment and operational activation are separate.
See [manual operator prerequisites and policy contract](docs/CONTROLLED-MANUAL-PAYOUTS.md).

## Default-off M-Pesa B2C payouts

Guarded B2C v1 dispatch uses the controlled-payout foundation's shared custody,
reservations and exclusive manual/automatic execution claim. Both deployment and
Owner policy default OFF with two-person review and no limits. The Owner may
explicitly configure audited automated approval; phone control, independent
identity/name evidence, actual disbursable collected funds, fees, holds and
independent final reconciliation remain mandatory. No production/provider
activation has occurred. See [B2C operator guide and exact contract
evidence/limitations](docs/B2C-PAYOUTS.md).
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
