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

**Admin/Owner → Fees & settings → Enabled payment methods** controls the
platform-level provider allowlist independently for M-Pesa/Daraja, Card/Paystack
and Card/Stripe. The default retains all previously eligible test adapters.
Credentials, markets/currencies, provider health and test-only mode must still
pass; a switch cannot enable live payments. Options and checkout creation read
the current database policy, and a database insert guard rejects disabled
providers even from stale tabs. Disabling affects new intents, never reroutes,
cancels or prevents verification of an already-created payment. Changes require
confirmation and are audited. No configuration is silently enabled on save.

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
