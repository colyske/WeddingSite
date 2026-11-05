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

Each tap opens a task-specific editor, not its former wizard group: names,
address, story and cover are separate; currency excludes payout preferences;
colours, dress guidance, travel, FAQ, programme groups and individual revenue
products each have their own scope. Section wording has a separate explicit
control. Existing form fields remain mounted and saved through the same shared
validation/save flow, so hiding unrelated fields does not clear their values.
Hash navigation retains the selected task and the first visible input receives
focus. Native dialog focus trapping and dirty-close protection remain intact.

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

Fund saves carry the editor's expected currency and lock the wedding row in the
service-only save wrapper. A stale pre-change editor cannot restore/relabel an
old goal after invalidation. Currency-change saves keep the server-preserved
unpriced structure and reload controls instead of overwriting it with a
pre-change client snapshot.

## Editable showcase content

The revised creation experience seeds the platform-authored fictional showcase
story (with explicit partner placeholders), attire/travel/FAQ, all seven
programme/activity structures, and the gift, fund, milestone, sponsor-package
and VIP descriptions. Names, address, accounting currency, wedding date and
time zone remain couple-owned fundamentals. Event dates are blank and venue
addresses are explicitly `Sample venue:` placeholders. Publication requires
replacement of sample partner/venue details and an explicit saved content review.
Arbitrary public weddings still expose only reusable configuration, not their
personal writing.

Shared section headings and editorial introductions can be replaced or cleared
in the section dialog; saved `page_content` is plain-text and allowlisted.
System payment/privacy explanations are not editable policy. The shared
lookbook uses original palette-coloured SVG outfit illustrations, not third-party
photographs; editing/removing palette colours updates/removes those looks.
The existing optional public HTTPS cover-photo control remains available.

Unpriced offering scaffolds appear only in the private projection with no
invented stock or balances. Saved milestone definitions/targets remain visible,
but reached state and all activity stay zero. E-card, sharing and seating
surfaces are visible, explicitly system-managed inactive previews: no valid
QR ticket, booked seat, sponsor endorsement, contact or payment is seeded.
The final KYC/publication workflow stays outside the guest frame.

The private renderer itself exposes explicit **Edit names** and **Currency**
controls. Address checks are authenticated, owner-scoped and advisory: valid
values are debounced, old responses ignored, and checking/available/taken/error
states are announced accessibly. Existing and archived wedding addresses remain
occupied; no check reserves an address or replaces the atomic save collision
check. Manual URLs are never overwritten by the availability check.
The address editor sits beside the displayed private-preview URL.
Private edit buttons are placed beside their actual names, date, story,
palette, dress guidance and offering content instead of in a section toolbar;
the cover control overlays the image edge and currency sits at the fund summary.
Responsive wrapping keeps these owner-only controls keyboard accessible.

Preview enhancement is idempotent and runs again when asynchronous extras
arrive. Late travel/guestbook sections receive edit controls, new guest forms
are disabled synchronously, and banners, delegated handlers and controls are
not duplicated. Browser coverage deliberately delays extras beyond the main
renderer-ready event.

The shared guest DOM groups arrival information first (story/theme/programme,
pre-wedding activities and travel), then RSVP/pass, giving/registry/music/thanks,
sponsors immediately followed by sponsor packages, VIP/seating, and
guestbook/sharing. Async extras join that same order, section numbering follows
the DOM, and existing anchors, controls and focused form state are retained.
