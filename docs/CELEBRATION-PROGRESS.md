# Celebration Fund progress

The source-coloured progress bar consumes `get_public_celebration_progress(slug)`, never a sum of the
campaign, registry, leaderboard, sponsor or VIP display totals. The first enabled
fundraising stream in the wedding's current currency (ordered by `sort_order`,
`created_at`, then ID) supplies the explicit goal and unchanged contribution
target. Its milestones retain stream-scoped attainment: `campaign_raised_minor`
counts only adjusted fundraiser payments to that exact parent stream, not the
other-source umbrella total. Other campaign cards remain campaign-specific.

Each contribution is counted once across the wedding: fundraiser payments
(including milestone-attributed payments and other fundraisers), song bids,
registry, sponsorship (including featured bids), or VIP. RSVP fees, in-kind
offers, unverified, test, pending, refunded and incomplete-action payments do not
count. Currency must equal both the goal and wedding currency; no FX conversion
or combining currencies occurs. The live/verified/completed requirements match
the current authoritative public sponsor and song contracts; rows are not
inferred from names or unlinked historical display records.

Raised means **adjusted gross**, using the existing
`displayable_contribution_amount` helper: processed refunds, lost disputes and
pending/open/review holds subtract only the affected portions, floored at zero.
Failed refunds and won/reversed disputes restore their portions under that same
helper. Fees, withdrawal amounts, payout balances and payout eligibility are not
read or changed. The public payload contains only aggregate amounts, currency,
goal and campaign ID, never payer identities or payment references.

Below goal, each source segment's width is its amount divided by the goal and the
neutral remainder completes the bar. At or above goal, the bar is full,
segments show shares of the actual total, and the true total and completion
remain visible separately. The legend uses largest-remainder rounding to
reconcile to 100.0%; segment widths always use unrounded proportions. Zero is
entirely neutral. No explicit goal means the existing no-goal progress presentation.
The user-selected fallback retains the existing polished progress-bar styling
with five distinct source colours and matching legend swatches. Segments sit
inside a generously sized pill track with a static ivory/gold frame and soft
dimensional highlight; decorative layers never change segment widths. Labels remain
outside the bar, with accessible textual totals and legend. No cake geometry,
chart switcher, animation or new dependency is shipped. Existing `givingProgress`
remains unchanged for other cards.

## Database-first release

Apply `202611220001_celebration_progress.sql` to the linked production database
before merging/deploying the API consumer. This migration adds only a stable
read-only RPC; it changes no records or financial contracts. Failure to load or
reconcile progress is reported, not silently shown as zero.

`tests/db/celebration-progress.sql` runs on an isolated migrated test database
inside a rollback transaction. Never run fixtures against production.
`node --test tests/celebration-fund.test.js tests/showcase.browser.test.js`
covers segment proportions, reconciliation, zero/over-goal, accessibility, payment-target
preservation and responsive rendering. Set `WEDDING_SCREENSHOTS` to an existing
artifact directory for desktop/mobile evidence.
