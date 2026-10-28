# Feature-to-surface matrix

Status: built features are implemented; payments are test mode (no real money).

| Feature | Configured (organizer) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Fundraising campaigns with milestones (separate from the gift registry) | Editor → "Fundraising campaigns": named campaigns, goal, ordered milestones, visibility | "A gift for our next chapter": progress bar, ticked milestones, 10/25/50/Other (test mode) | `fundraising_streams`, `fundraising_milestones`, `contributions.stream_id/milestone_id` | Guests see totals only; organizer sees ledger by campaign (guest, amount, campaign, milestone, status); Owner ledger |
| Wedding date, time, time zone (mandatory) | Editor | Hero, venue cards, countdown, .ics | `weddings`, `venues` | Public |
| Past / Completed state | Automatic from date in the wedding zone | "Completed" banner; RSVP, bids, pledges closed | `is_past` (RPC) | Public |
| Unpublish / archive (no delete) | Editor buttons (confirm) | Site hidden | `unpublished_at`, `archived_at`; delete blocked by trigger and API 405 | Wedding owner, admins |
| Publication fee policy | Admin / SuperAdmin fees and settings | Fee explained at publish | `platform_policies`, `publication_fees` | Client, admins, owner |
| KYC (legal names, ID, next of kin) | Editor KYC form | Never shown | `wedding_kyc` (no direct grants, masked) | Wedding owner, admins, owner role |
| Venues with date, time, address, map | Editor | Venue cards, programme | `venues` | Public |
| RSVP and e-card pass | Capacity in editor | RSVP form, then persisted pass, lookup by email or code | `guest_rsvps` | Public (own pass), organizer list |
| QR verification and check-in | - | Pass QR links to `/verify.html?code=` | `guest_rsvps` | Organizer checks in |
| DJ bids | Editor | Leaderboard, bid form | `dj_song_bids` | Public, organizer |
| VIP seating, sponsorship tiers, registry pledges | Editor | Buy buttons (test checkout) | `contributions`, ledger | Public ledger (opt-in names), organizer, admin, owner |
| Payouts | Organizer requests | - | `payout_records` | Organizer, admin, owner |
| Back office | - | - | Role changes, audit | Admin (limited), SuperAdmin, Owner (security tab) |
| Editorial design and wedding props | - | All pages | CSS/SVG only | Public |

## Limitations
- Payments are simulated; no live provider is connected.
- Pass lookup uses email or code only (no phone stored on RSVPs).
- Venue dates are saved on update, not on create.
- Not built (recommended later): Facebook/X/SMS share and Open Graph meta, guestbook, gallery, seating lookup, FAQ/travel, referral tracking, analytics, Swahili toggle, PWA.

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

Not built yet (recommended next): photo gallery/uploads with moderation (needs storage + size limits), PWA/offline pass, per-wedding Open Graph image, templates/themes, real WhatsApp/email delivery (needs credentials). Swahili covers the guest site only, not the organizer pages; seating lookup depends on the couple importing a guest list with phone numbers.

## Refinements batch

| Feature | Configured (organizer / admin) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
| Phone as primary identifier | CSV import has a phone column | RSVP, pass lookup and seating use phone (email optional) | Digits-only `guest_rsvps.phone`, `guests.phone`; placeholder key email for phone-only RSVPs is hidden | Couple, admins |
| DJ bids consolidated | - | One row per song (case-insensitive), totals add up, bid count; note says money goes to the wedding fundraiser, not the DJ | `get_dj_leaderboard` aggregates `dj_song_bids`. Bids are pledges: not ledgered or paid in demo mode | Public |
| Extra-guest fee, base RSVP fee | Editor "RSVP fees" (major units) | Fee note, quote dialog with line items, confirm before submit (HTTP 402 quote then confirm) | `contributions` rows (RSVP fee, Extra guests, Premium dietary), provider `test-simulator` | Couple, admins (ledger) |
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

Featured bids are charged through the configured test checkout. Only a provider-verified payment created during the campaign window can be counted; if campaign terms/capacity no longer permit finalization, the payment is routed to review and is not shown as a completed bid. The browser redirect alone is not confirmation. The new migration must be replayed and safely deployed before this feature is available in Production.

The prior release did not include refund/dispute accounting; see the branch-status section below for the current implementation and its verification limits.

## Verified refunds, disputes and settlement adjustments

| Feature | Behavior | Status |
|---|---|---|
| Refund/dispute webhook intake | Stripe and Paystack signatures are verified before normalization; raw webhook bodies are not stored. Adjustment events are deduplicated and correlated to the original verified payment reference. Exact-match Admin reconciliation is available for timestamped, provider-confirmed unmatched refunds. | Implemented; provider sandbox events not yet exercised |
| Refund accounting | Provider-confirmed processed refunds create immutable adjustment-ledger entries. An Owner policy is snapshotted at payment creation: couple absorbs the full refund, platform reimburses the known original fees proportionally (rounded down), or manual review. Unknown fees and ambiguous/out-of-order events hold funds. | Implemented; new migration awaiting CI replay |
| Dispute accounting | Open disputes hold the disputed amount; verified withdrawals/losses debit the couple balance once; verified reinstatements reverse that debit once. Unmatched or conflicting events are visible in Admin review. | Implemented; new migration awaiting CI replay |
| Payout availability | Settled net contributions plus immutable adjustments, minus outstanding holds, approved expenses and active withdrawals; payout requests and refund resolutions serialize on the wedding row. | Implemented; no payout provider execution |
| Admin/Owner operations | Admins see actionable adjustment/reconciliation queues and may allocate a provider-confirmed refund only after fee data is known. Owner sees aggregate queue counts and controls the default allocation for new payments. | Implemented; real provider and Production verification blocked |

These are code and local contract-test claims, not Production verification. No financial migration has been applied to Production, and no refund/dispute event, real payout, or configured test checkout has been exercised against provider credentials. Paystack refund events without a stable adjustment reference or timestamp are held for review rather than automatically posted.