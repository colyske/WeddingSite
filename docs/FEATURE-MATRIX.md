# Feature-to-surface matrix

Status: features below are implemented where marked. Production payments fail closed until a test provider is fully configured; no live payment processing is enabled or claimed.

| Feature | Configured (organizer) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Google sign-in | Enable Google in Supabase Auth; store the Google Client ID/Secret in Supabase, not WeddingSite code | Sign-in page checks provider status, starts state-bound PKCE, and exchanges the callback code server-side; email/password, magic link and recovery remain | Supabase Auth session; role is loaded from the protected profile | Client by default; privileged APIs still check server-side roles |
| Fundraising campaigns with milestones (separate from the gift registry) | Editor → "Fundraising campaigns": named campaigns, goal, ordered milestones, visibility | "A gift for our next chapter": progress bar, ticked milestones, 10/25/50/Other (test mode) | `fundraising_streams`, `fundraising_milestones`, `contributions.stream_id/milestone_id` | Guests see totals only; organizer sees ledger by campaign (guest, amount, campaign, milestone, status); Owner ledger |
| Wedding date, time, time zone (mandatory) | Editor | Hero, venue cards, countdown, .ics | `weddings`, `venues` | Public |
| Past / Completed state | Automatic from date in the wedding zone | "Completed" banner; RSVP and paid actions closed | `is_past` (RPC) | Public |
| Unpublish / archive (no delete) | Editor buttons (confirm) | Site hidden | `unpublished_at`, `archived_at`; delete blocked by trigger and API 405 | Wedding owner, admins |
| Publication fee policy | Admin / SuperAdmin fees and settings | Fee explained at publish | `platform_policies`, `publication_fees` | Client, admins, owner |
| KYC (legal names, ID, next of kin) | Editor KYC form; payout notice links to both partners' required details and consent. Not part of setup score or publishing | Never shown | `wedding_kyc` (no direct grants, masked); completeness is not independent identity verification | Wedding owner, admins, owner role |
| Venues with date, time, address, map | Editor | Venue cards, programme | `venues` | Public |
| RSVP and e-card pass | Capacity in editor | Phone-based RSVP and pass lookup | `guest_rsvps` | Public (own pass), organizer list |
| QR verification and check-in | - | Pass QR links to `/verify.html?code=` | `guest_rsvps` | Organizer checks in |
| DJ bids | Editor | Leaderboard, bid form | `dj_song_bids` | Public, organizer |
| VIP seating, sponsor packages, registry and campaign contributions | Editor | Purchase options use hosted checkout; completion requires verified payment | `contributions`, ledger | Public ledger (opt-in names), organizer, admin, owner |
| Payouts | Organizer requests; both-partner KYC completeness is enforced by SQL at request, approval and marking sent. Cancellation remains available. No automatic money transfer | - | `payout_records`; blocked requests return `kycRequired` and the editor links to `#kyc-section` | Organizer, admin, owner |
| Back office | - | - | Role changes, audit | Admin (limited), SuperAdmin, Owner (security tab) |
| Editorial design and wedding props | - | All pages | CSS/SVG only | Public |

## Limitations
- Checkout availability is derived from configured currency/market capabilities and read-only provider health. A visible payment method or accepted STK initiation is not proof of settlement.
- Historical guest records without a phone need an organizer guest-list re-import before those guests can use phone-based seating lookup.
- Not built: photo gallery/uploads with moderation, PWA/offline pass, per-wedding Open Graph image, templates/themes, and real WhatsApp/email delivery (which require approved integrations and external configuration).

## Sharing, referrals and engagement (completion batch)

| Feature | Configured (organizer) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Share panel (copy, native share, WhatsApp, Facebook, X, email, SMS) with invitation text | - | Hero button, "Share the celebration" section, footer link, RSVP pass | - | Public |
| Open Graph / Twitter previews | - | Shared link `/w/<slug>` is served by `/api/guest?action=og` (server-rendered meta, then redirects to the site); JS also sets tags on the page. Preview image is a fixed stock photo, not the couple's own | - | Public |
| Save the date (.ics) and Add to Google Calendar | Date, time, zone | Share section | - | Public |
| Referral tracking | - | Each RSVP gets a random 8-char code and a personal link `?ref=<code>`; consent note beside the link | `site_visits` (salted HMAC of IP+UA, never raw IP, one row per visitor/ref/day), `guest_rsvps.ref_code/referred_by_code` | Couple, admins, owner role ("Guests who invited others", counts only, no emails) |
| Visit rate limit / dedupe | - | - | Per-instance in-memory limiter (best effort) plus DB unique index (authoritative) | - |
| Guestbook with moderation | Approve / hide in Guest engagement | Wish form and approved wishes | `guest_wishes` (RLS: managers only; guests post through API) | Public sees approved only; couple/admins moderate |
| Travel & FAQ | Editor "FAQ & travel info" | "Travel & FAQ" section | `weddings.faq`, `weddings.travel_info` | Public |
| Organizer analytics | - | - | `wedding_analytics()` RPC: visitors, referred visitors, RSVPs, bids, wishes | Couple, admins, owner role |
| Seating lookup | Guest list CSV import in editor (header row; columns name, phone, email, dietary, table) | "Find your seat": guest enters the phone number they were invited with; only their own name and table return (rate limited, exact match) | `guests.table_number` | Couple (full list); guest sees own table only |
| Group RSVP | - | Plus-ones count plus "names of the people coming with you" on the RSVP form | `guest_rsvps.plus_one_count`, `party_names` | Couple, admins (Guest RSVPs table: "Party of N: names") |
| English / Swahili toggle | - | SW/EN button in the navbar; fixed interface text and section headings only (couple-written content is not translated); choice kept in the browser | `localStorage` only | Public |
| Post-wedding thank-you | Automatic once the date passes | Memories/thank-you banner; guestbook still open | `is_past` | Public |

Swahili currently covers the guest site only, not organizer pages. Seating lookup depends on the couple importing a guest list with phone numbers.

## Refinements batch

| Feature | Configured (organizer / admin) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Phone as primary identifier | CSV import has a phone column | RSVP, pass lookup and seating use phone (email optional) | Digits-only `guest_rsvps.phone`, `guests.phone`; placeholder key email for phone-only RSVPs is hidden | Couple, admins |
| DJ bids consolidated | - | One row per song (case-insensitive), totals add up only after payment verification; note says money goes to the wedding fundraiser, not the DJ | `get_dj_leaderboard` aggregates `dj_song_bids`; paid action finalization is provider-verified | Public |
| Extra-guest fee, base RSVP fee | Editor "RSVP fees" (major units) | Fee note, itemized quote, and checkout before RSVP completion | `contributions` rows (RSVP fee, Extra guests, Premium dietary); verified provider payment required | Couple, admins (ledger) |
| Premium dietary fee | Editor: premium options + fee; standard options stay free | Premium group in the dietary select | Ledger line | Couple, admins |
| Palette names and hex | Editor palette: name each colour | "Wedding theme - colour palette" label, `Name (#HEX)` | `weddings.palette_names` | Public |
| Pre-wedding events | Editor: event type "Before the wedding" plus street address | "Before the wedding" section, time, name, address, Get directions (Google Maps) | `venues.kind`, `venues.address` | Public |
| The Celebration timeline | Editor: wedding-day events | Time, name, address, Get directions | `venues` | Public |
| Admin fees in major units | Fees tab shows and saves 2-decimal major units, with a conversion note | - | Stored as minor units | Admin, owner |
| Admin per-wedding metrics | "Metrics" button on each wedding | - | `admin_wedding_metrics()` | Admin, owner |
| Pagination and search | Weddings, users, ledger, audit: search, 20 per page (10/20/50/100) | - | Client-side over newest 500 rows | Admin, owner |
| Active admin tab | Highlighted tab, `aria-selected` | - | - | Admin, owner |

## Paid featured sponsor campaign

| Feature | Configured (organizer) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Fixed sponsor packages plus optional featured slots | Wedding editor sets the opening/closing instants, slot count, minimum paid bid, and increment; campaign terms lock after the first paid bid | Campaign state, current leaders, next eligible bid, and a bid action; closed-window leaders are the featured slots | `sponsor_featured_campaigns`, `sponsor_featured_bids`, paid `contributions`, and sponsor advert cards | Public sees company names and verified totals; wedding organizers see sponsor records |

Featured bids are charged through the configured test checkout. Only a provider-verified payment created during the campaign window can be counted; if campaign terms/capacity no longer permit finalization, the payment is routed to review and is not shown as a completed bid. The browser redirect alone is not confirmation. The campaign migration has passed CI replay and is applied in Production; checkout remains unavailable until a test provider is configured.

Refund/dispute accounting and deployment status are summarized below.

## Verified refunds, disputes and settlement adjustments

| Feature | Behavior | Status |
|---|---|---|
| Refund/dispute webhook intake | Stripe and Paystack signatures are verified before normalization; raw webhook bodies are not stored. Adjustment events are deduplicated and correlated to the original verified payment reference. Exact-match Admin reconciliation is available for timestamped, provider-confirmed unmatched refunds. | Implemented; provider sandbox events not yet exercised |
| Refund accounting | Provider-confirmed processed refunds create immutable adjustment-ledger entries. An Owner policy is snapshotted at payment creation: couple absorbs the full refund, platform reimburses the known original fees proportionally (rounded down), or manual review. Unknown fees and ambiguous/out-of-order events hold funds. | Implemented; CI replay passed and migration applied in Production; no provider sandbox event tested |
| Dispute accounting | Open disputes hold the disputed amount; verified withdrawals/losses debit the couple balance once; verified reinstatements reverse that debit once. Unmatched or conflicting events are visible in Admin review. | Implemented; CI replay passed and migration applied in Production; no provider sandbox event tested |
| Payout availability | Settled net contributions plus immutable adjustments, minus outstanding holds, approved expenses and active withdrawals; payout requests and refund resolutions serialize on the wedding row. | Implemented; no payout provider execution |
| Admin/Owner operations | Admins see actionable adjustment/reconciliation queues and may allocate a provider-confirmed refund only after fee data is known. Owner sees aggregate queue counts and controls the default allocation for new payments. | Implemented; real provider and Production verification blocked |

CI successfully replayed and linted the migrations on a fresh isolated database. Migrations `202610300002`, `202610300003`, and `202610300004` are present in the linked Production migration history, and the post-merge Production deployment is Ready. The Production payment-options API was queried for a published QA wedding and returned `paymentAvailable: false`; no checkout, refund/dispute sandbox event, or payout was initiated. Authenticated Owner/Admin browser operations remain unverified. Paystack refund events without a stable adjustment reference or timestamp are held for review rather than automatically posted.

Production environment-variable names observed as missing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUPPORTED_CURRENCIES`, `STRIPE_SUPPORTED_MARKETS`, `PAYSTACK_SUPPORTED_CURRENCIES`, and `PAYSTACK_SUPPORTED_MARKETS`. `PAYSTACK_SECRET_KEY`, `TURNSTILE_PUBLIC_KEY`, `TURNSTILE_SECRET_KEY`, and `WEDDINGSITE_PUBLIC_ORIGIN` are present by name only; secret values remain hidden and were not read. The checkout code accepts either `TURNSTILE_SITE_KEY` or `TURNSTILE_PUBLIC_KEY`. `WEDDINGSITE_PAYMENT_MODE` is configured as test and `WEDDINGSITE_LIVE_PAYMENTS_ENABLED` as false. The API's no-provider response is authoritative for current checkout readiness.

## Safaricom Daraja M-Pesa sandbox collection

| Feature | Behavior | Status |
|---|---|---|
| Provider selection | Daraja is offered only for Kenya (`KE`) / Kenyan shilling (`KES`) wedding collection, derived from platform configuration — no per-wedding or organizer processor setup. It is not a payout method. | Implemented and deployed |
| Payment gating | Checkout requires `WEDDINGSITE_PAYMENT_MODE=test` plus test/sandbox credentials. `WEDDINGSITE_LIVE_PAYMENTS_ENABLED` is not required or read; live mode is never accepted (Stripe/Paystack need `sk_test_` keys; Daraja uses only the sandbox base URL). | Implemented with regression tests |
| STK Push | Validates Kenyan mobile numbers and whole-KES amounts, creates a sandbox-only push, and leaves the contribution pending until server verification. | Implemented with adapter regression tests |
| Callback and settlement | Callback payload is an unsigned notification, not payment evidence; a callback `Amount` that disagrees with the stored amount confirms nothing. The server calls STK Query for the exact stored CheckoutRequestID. STK Query returns only status fields (`ResponseCode`, `ResponseDescription`, `MerchantRequestID`, `CheckoutRequestID`, `ResultCode`, `ResultDesc`) — it does **not** return or verify the amount. The recorded amount is the server-created, immutable contribution amount bound to that CheckoutRequestID at initiation, recorded through the idempotent verified-payment RPC. Redirects and initiation acceptance never confirm an action. | Implemented with mocked callback tests |
| Required secure settings | `WEDDINGSITE_PAYMENT_MODE=test`, `DARAJA_ENVIRONMENT=sandbox`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`, `DARAJA_PASSKEY`, plus the already-used `WEDDINGSITE_PUBLIC_ORIGIN`. Use Vercel's encrypted environment settings; do not put credentials in the repository or a chat. | Provisioned by the user in Production (names verified only) |
| Callback reachability | `<WEDDINGSITE_PUBLIC_ORIGIN>/api/webhooks?provider=daraja` must be reachable directly (no redirect). STK Push sends the callback URL per request; no Daraja portal registration is needed. | Public origin serves the route directly |

The official [Safaricom developer portal](https://developer.safaricom.co.ke/apis) is reachable, but its public API catalog did not expose current STK test-number guidance in this environment; legacy STK documentation URLs returned 404. We cannot substantiate that the commonly cited public test MSISDN guarantees success for this application's sandbox flow. Do not infer customer cancellation from a generic terminal status, or recommend using a real number to debug sandbox behavior.

The latest existing failed Atieno song checkout examined on 29 October 2026 has zero paid amount, is not provider-verified, and has no completed action or action result. The historical numeric ResultCode was not retained, so its exact reason cannot be reconstructed from that record. Authenticated STK Query remains authoritative: acceptance without a ResultCode stays pending, zero confirms payment, and nonzero is terminal/unpaid. Terminal query results now log only sanitized numeric codes and return the code on a status transition; codes are not persisted, so later status reads may omit them. No new payment was initiated for this investigation.

Google OAuth is implemented in the app but not end-to-end verified in Production. A read-only Supabase Auth settings request using the Production environment's existing browser-public anon key returned HTTP 200 and `external.google=false`; this request did not expose or retrieve credentials. Configure Google in Supabase Auth, set the Supabase Site URL to `https://weddingsite-six-bice.vercel.app`, allow `https://weddingsite-six-bice.vercel.app/signin.html**`, and add `https://lvvtgxspwvmdhqyoyqyy.supabase.co/auth/v1/callback` to the Google OAuth client's authorized redirect URIs. The Google Client Secret belongs only in Supabase Auth provider settings. The app callback is `/signin.html`; PKCE code exchange and profile-backed role retrieval are handled by the server. Site URL and redirect allow-list values were not included in the public settings response, so their current values remain unverified.
## joinourwedding.site domain and "Join Our Wedding" branding

| Feature | Behavior | Status |
|---|---|---|
| Wedding subdomains | `https://<couple-slug>.joinourwedding.site` is rewritten (Vercel host match) to `/api/guest?action=page`, which serves the published wedding with canonical/OG meta, 404s unknown/unpublished slugs, and 308s reserved labels (`www`, `api`, `admin`, `signin`, ...) to the root. | Implemented with tests |
| Root / www | Root and `www` serve the platform; only one host-level redirect may exist at a time (no www/root loop). | Implemented |
| Canonical links | Share/copy/OG/ICS/QR links use the subdomain URL (`WSSite.weddingUrl`); slugs that are not valid DNS labels fall back to `/guest.html?slug=`. `/w/<slug>` and `/guest.html?slug=` keep working. | Implemented |
| Auth isolation | Sessions live in per-origin `sessionStorage` (no cookies), so wedding subdomains never receive platform tokens. Sign-in/account links point at the root platform. | Implemented |
| Checkout origins | Accepted: `WEDDINGSITE_PUBLIC_ORIGIN`, `WEDDINGSITE_LEGACY_ORIGINS`, or the wedding's own subdomain (requires `WEDDINGSITE_WEDDING_BASE_DOMAIN`). Provider returns go back to the starting origin. | Implemented with tests |
| Reserved slugs | New weddings and slug edits cannot take reserved labels. | Implemented |
| Branding | User-facing name is "Join Our Wedding" with the literal domain `joinourwedding.site`; internal identifiers (`WEDDINGSITE_*`, storage keys, migrations, repo/Vercel/Supabase names) are unchanged. | Implemented |
| Manual console items | Add `joinourwedding.site` to the Cloudflare Turnstile widget hostnames; optionally point the Paystack test webhook to the new origin; the Google provider redirect stays `https://lvvtgxspwvmdhqyoyqyy.supabase.co/auth/v1/callback`. | Requires account owner |

## Legal pages, Google sign-in and Production status (latest)

Guest song requests now start from a visible title/artist/amount form even when the paid leaderboard is empty. Existing songs retain preset bids and a custom-amount option without retyping the song. Both use `song_bid` through the same provider-verified pipeline; checkout initialization creates only a pending contribution. Titles/artists are whitespace-normalized and matched case-insensitively to existing paid entries. The existing database fulfillment remains service-only and idempotent and aggregates paid bids, never pending requests. Browser/API regressions cover empty/populated lists, request preservation on challenge/provider failure, cancellation, and verified-success rendering; these tests do not establish provider-backed payment or Production ledger settlement.

| Item | Status |
| --- | --- |
| Privacy Policy `/privacy.html`, Terms `/terms.html` | Live on www, root (via www redirect) and vercel.app; linked from shared footer (platform root on wedding subdomains), sign-in/sign-up and guest promo footer. Operator identity, contact, governing law, fee rates and retention periods are marked `[to be confirmed]`; no compliance claims. |
| Published wedding subdomain | `atieno-and-otieno.joinourwedding.site` 200 with canonical/OG meta; unknown slug 404; reserved label 308 to root. |
| Google OAuth | Supabase `external.google` enabled; app start leg verified to Supabase authorize then `accounts.google.com` sign-in page with Supabase callback. Return leg/session exchange not verified until a real Google login completes. |
| Daraja sandbox (KES/KE) | Read-only options report M-Pesa available and OAuth healthy. Existing paid and failed records exist; this review did not initiate a payment or establish the exact reason for the latest failed sandbox request. |
| Paystack test | User-configured currencies/markets are recognized by deployed `providerChecks`. The old `/integration` health probe failed; the adapter now uses the [documented read-only `/integration/payment_session_timeout` endpoint](https://paystack.com/docs/api/integration/), fails closed on errors, and advertises Card only after a healthy check. Deployed availability must be checked after release. |

## Compact shared-theme experience

- Guest navigation wraps all six links without horizontal scrolling, including tablet widths. Song rows show a keyboard-accessible "Bid on song" disclosure; amounts expand only when requested. Existing songs precede the new-song form. Only verified fulfillment triggers leaderboard scroll/highlight, including a new song.
- The guest theme/dress section and editor use the same existing `palette`/`palette_names`; optional clothing guidance remains in `attire_notes`. The previous sections displayed the same stored palette twice, so no palette or notes are deleted or migrated.
- Custom swatches retain their original values. UI ink is derived separately with contrast of at least 4.5:1 on the darkest light section and 7:1 against white, preserving readable buttons and dark sections even for pale/black palettes. Shared surfaces have tighter spacing, alternating guest section backgrounds, visible focus states and readable disabled controls.
- Responsive regressions cover 320/375px and desktop public/authenticated layouts; no forms, emails or payments are submitted during the read-only surface review. Mocked checkout tests are not evidence of provider settlement.
