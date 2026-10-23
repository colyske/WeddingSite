# WeddingSite

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
