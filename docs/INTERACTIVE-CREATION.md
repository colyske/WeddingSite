# Interactive wedding creation

New dashboard starter drafts use `create_interactive_wedding`, a transactional,
idempotent wrapper around the existing deferred starter creation. Existing
weddings retain their previous configuration and editor. No financial, KYC or
audit history is migrated.

The main editor embeds the actual `guest.html` renderer on the same origin.
Section taps and keyboard-accessible edit buttons open a native modal dialog
containing the existing validated form controls. Saves use the existing
authenticated content, structure, extras and campaign endpoints. Errors keep
the dialog and answers open. Unsaved changes prevent returning from a dialog;
the existing unload warning also protects navigation. Private identity and
publication remain in the authenticated parent at the final step.

The frame reads only an allowlisted server projection through a same-origin
parent capability. No postMessage listener, preview bearer URL, private wedding
object, KYC, account details, guest identities or moderation details cross into
the frame. Preview guest requests are handled by a local read-only adapter;
checkout and mutations cannot reach the guest API. Visits and payment-return
restoration are disabled. The preview intentionally shows zero activity, not
fixture progress, patrons or sold seats.

## Currency and permanent revenue assumptions

Only newly created interactive weddings have permanent giving, sponsors,
featured-sponsor, song-request and VIP surfaces. Visibility does not authorize
payment rails or create inventory, publication eligibility or transactions.
Unconfigured products remain visible as incomplete private-preview sections.

KES uses the current showcase Celebration fund target: **KES 500,000**
(`50000000` minor units), with no raised balance. Other currencies use the selected template's first goal only when it is
explicitly configured in that exact currency. Current Owner amount presets are
guest contribution choices, not fundraising targets. Without a matching
template goal the fund stays visibly incomplete and must be explicitly priced
before publication. No KES goal is converted or relabelled. The isolated
`creationFundPreset` contract and transactional SQL initializer must stay in
sync if this preset changes.

Currency changes reuse the existing starter amount invalidation: draft fees,
prices, goals and nested milestones become unpriced structures. Published or
financial-history weddings cannot use this draft reset. The database enforces
permanent revenue flags and a positive, same-currency visible fund for published
interactive weddings; the existing publication/payment checks remain
authoritative. The new additive migration must be applied before deploying code
that selects `interactive_creation`.
