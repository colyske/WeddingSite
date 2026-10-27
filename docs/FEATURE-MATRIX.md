# Feature-to-surface matrix

Status: built features are implemented; payments are test mode (no real money).

| Feature | Configured (organizer) | Shown (guest site) | Recorded | Who sees it |
|---|---|---|---|---|
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
