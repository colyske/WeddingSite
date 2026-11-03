# Controlled manual external payouts (default OFF)

This is a bounded **unactivated control plane**, not launch-ready withdrawals or an
authorized funded rail. Migration `202611110001` does not enable any payment or payout
provider, initiate transfers, contact an external service, copy B2C branch code, or
modify historical finance records. Automatic transfers retain their existing hard-OFF
gate. The original manual policy remains constrained OFF as historical baseline.
Migration `202611130001`, ordered after shared B2C `202611120001`, adds a separate
append-only operating-policy chain and guarded protected-Owner activation/readiness.
Its only deployment row is OFF, with no scope, fees, limits or evidence defaults.
Deploying this capability is **not operational availability or activation authorization**.

## Shared Paybill: current manual setup (no global bank balance)

`202611160001` adds an **explicit new manual-only shared-account scope**. A Paybill
used by other systems is not a dedicated WeddingSite bank account. WeddingSite
does not ask for its global available balance, opening/closing statement or
other-system transactions, and cannot reserve or guarantee merchant liquidity.
The authorized operator checks liquidity in the official portal outside this site.
The existing canonical account registry still prevents aliases of the same real
account. No historical scope is converted, no old protection is removed, and no
policy is enabled by deployment. Existing statement-mode/B2C records keep their
original contracts described later in this document.
Insert guards also prevent old intake RPCs from mapping statement obligations or
B2C funding bindings into shared scopes; this cannot reclassify history out of
the legacy accounting model.

**Start here:** Back office → **Payouts → Start here: prepare manual payouts**.

1. **Add real evidence.** Keep the actual document in your approved access-controlled
   store. Choose the original file in the local fingerprint tool (up to 20 MiB).
   The browser computes SHA-256 from the actual bytes; no file, filename or bank/
   recipient detail is uploaded or logged. **Assign a new evidence-register
   reference**, then **Download reference card for the secure register**. Save
   that card beside the original in your external store, confirm you did so,
   select the evidence purpose, and explicitly record the evidence. For an
   existing registered document, reuse its real opaque reference/fingerprint
   rather than inventing another identity. The reference is a locator in your
   own register, not a provider ID or proof that a document exists.
2. **Check evidence.** Choose the saved record by kind/time/reference suffix.
   The reviewer must actually inspect the original through the external store.
   Checking is a separate confirmed action: no automatic attestation. Normal
   processing requires an independent eligible leader. A protected Owner must
   explicitly select audited Owner-solo self-check when applicable.
3. **Register merchant account.** This records an already authorized real account;
   it does not open/fund an account or collect account numbers. The technical
   record ID is generated internally. Select checked account evidence. Use the
   opaque entry from the canonical account register. **Assign a new register
   reference** only after confirming the real account has no existing entry;
   save it externally. Never create an alias to evade account/receipt uniqueness.
4. **Prepare shared account attribution.** Select the registered account,
   explicitly enter its currency, and select checked evidence describing
   WeddingSite attribution and authorized use (the historical evidence kind is
   internally named `custody`, but this is **not a bank balance assertion**).
   No available/opening/closing amounts or full account statement are entered.
5. **Prepare verified recipient.** Select the wedding, actual provider/currency
   and checked recipient evidence, with private KYC/consent already complete.
   This creates an immutable revision selected by its wedding/date/provider/
   revision description. Actual recipient/bank details stay in the secure
   external procedure and existing private KYC, not unsupported new fields.
6. **Record actual contribution settlement.** Choose the shared scope and an
   existing live, provider-verified, fee-known WeddingSite contribution. Its exact
   net is shown in KES; actual checked transaction-specific settlement proof and
   settlement date are required. A timer or payment status alone is not proof.
   The same contribution cannot credit legacy/shared/automatic scopes twice.
   Other-system receipts are not accepted as contributions or funds.
7. **Protected Owner manual policy.** Select the prepared scope, exact recipients
   and checked policy/fee/rail/evidence-procedure records. Enter your reviewed
   per-transfer total, UTC-day exposure cap, fee and explicit supported `wedding`
   payer. KES fields accept shillings/cents: KES 12.34 → exactly 1234 integer minor
   units, never floating rounding or FX. No value is assumed. Global statement
   freshness is not a prerequisite for shared scopes. **Save reviewed draft
   (OFF)** prepares only; **Enable reviewed manual admission** remains a separate
   authorized action and fails closed on blockers.
8. A couple review intent remains nonfinancial. **Prepare staff review** selects
   the real prepared scope/recipient internally; confirmed `created` reserves
   **internal WeddingSite exposure**, not bank funds. Admission subtracts all
   known WeddingSite refunds/disputes/holds, prior expenses/payouts, and both
   rails' open/paid commitments for that wedding, with current contribution
   eligibility rechecked at approval and claim. Uncertain exposure never expires.
9. After independent approval (or explicit protected-Owner solo), **Prepare
   execution claim** commits one durable claim. The operator checks liquidity
   and transfers once outside the site only with separate payment authorization.
   On uncertainty, record it; never blindly retry or cancel-unreserve.
10. Record the sender's actual receipt as before. On a shared-scope reported
    payout use **Prepare exact transfer verification → Verify the exact completed
    transfer**. A separate checked transaction-specific debit document
    from the official account portal must identify that payout's source account,
    actual verified recipient, unique reference, principal, fee, currency and
    booked date. A full account statement/global balance is not needed. An
    independent eligible reconciler confirms the exact match using separate
    reconciliation evidence; explicit Owner-solo retains the same Owner and
    explicit self-checks. Only atomic exact verification appends `paid`.
    Duplicate/contradictory receipts still commit the existing account hold
    across both channels and retain exposure.

Selections carry IDs internally; raw IDs are retained for audit rather than
requiring hand-copying between forms. Check labels describe recorded checks, not
automatic provider verification; current roles/KYC/funds are always revalidated
by the database. Missing/truncated/stale records do not become silently valid.
The external evidence store, canonical register and human validation procedure
remain genuine Owner prerequisites. If the real account already has a legacy
statement-mode scope, do not alias it: continuing or migrating that historical
scope requires a separately reviewed plan; this migration does not convert it.

## Guarded operating policy and deactivation

The Payouts tab exposes preparation, exact outcome accounting and (protected Owner
only) policy readiness/revisions. `manual_payout_readiness()` returns explicit blockers;
it does not certify external documents, account entitlement or funds for a wedding.
Only `owner_set_manual_payout_policy(revision,changes,confirmed)` may append a reviewed
policy revision, using compare-and-swap under the shared financial advisory lock.
Other staff, direct table writes, stale revisions and unconfirmed changes are denied.
The deployment baseline, legacy withdrawal gate and automatic B2C policy are untouched.

For legacy statement-mode scopes, activation needs an explicit existing canonical custody account/provider/currency,
an allowlist of exact current recipient revisions, per-transfer **principal plus fee**
and aggregate UTC-day caps, fixed fee amount, fee payer and statement maximum age.
The supported fee payer is explicitly `wedding`: the existing shared ledger reserves
and deducts that fee from wedding entitlement. An alternative payer/funding source is
not implemented or inferred. The principal cap must fit the current platform minimum
and maximum; the existing platform hold and refund/dispute rules still apply. Checked
Owner policy evidence separately identifies the review, fee agreement, existing funded
rail entitlement and secure evidence-custody procedures. No new values are prefilled.

UTC-day exposure includes **both channels**, every older open commitment, and paid
requests requested, claimed, transferred or reconciled during the day. Policy revision
or channel changes cannot reset this cap. All new requests bind their immutable policy
revision; changing the policy invalidates unclaimed approvals even when values match.
Cancel an unclaimed stale request and create a newly reviewed request; never rewrite it.
Current Owner/reviewer roles, statement freshness, recipient/KYC/consent, incident holds,
fees, limits and existing statement-backed eligibility are rechecked at financial write.

Saving a draft appends an OFF revision. Activation is an explicit separately confirmed
Owner operation and fails closed on any prerequisite blocker. Disabling appends an OFF
revision even if old evidence has expired: it blocks new requests, approvals and claims,
but **never** releases reservations, deletes claims or prevents evidence preparation,
cancellation before claim, receipt reporting, uncertainty/no-transfer decisions or exact
statement reconciliation for existing executions. A claim survives every policy change.
No automatic transfer or provider call is made by these controls.

## Legacy statement-mode procedure and couple review requests

Migration `202611150001` follows released `202611140001`. It adds append-only
**nonfinancial review intents**, not another financial reservation or activation
path. It creates no payout, operational policy, seed, role or funded balance.

1. In the wedding editor, **Payouts & Withdrawals → Request a payout for staff
   review → Submit payout request for review** accepts an integer amount in the
   wedding's minor units and explicit review-only confirmation. No bank details,
   documents or notes are accepted. It works with admission OFF, reserves nothing,
   and permits one pending intent per wedding. History distinguishes awaiting
   review, staff-created payout and declined. This is not a payment promise.
2. Owner/SuperAdmin opens **Back office → Payouts → Controlled manual external
   payouts → Operator workspace (read-only references)**. The queue's **Prepare
   staff review** opens **Manual-only: review-intent** with the intent ID and a
   generated UUID. Choose `declined` and confirm to close the review without
   reservation (also available OFF). Choose `created`, explicitly supply custody,
   recipient revision and fee, then confirm **Record manual review-intent** to
   atomically create the actual staff payout/reservation. Wedding, principal and
   currency come from the immutable couple intent, not editable staff fields.
   Creation uses the existing gate, policy, entitlement and recipient checks;
   a blocked creation leaves the intent pending. Owner solo must be explicitly
   selected here if required; otherwise normal independent review applies.
3. Before any financial creation, use **Manual-only: evidence**, **check**,
   **account**, **custody**, **recipient**, **settlement**, **source** and
   **statement** as applicable to record the real verified setup below.
   Workspace tables retain opaque references/check actors for follow-up. Lists
   are explicitly bounded; retain older IDs in the secure operations register.
   Records and private recipient details are not public.
4. Protected Owner alone uses **Save reviewed draft (OFF)** with real reviewed
   scope, limits, fees and evidence. After separate activation authorization and
   zero readiness blockers, **Enable reviewed manual admission** can enable the
   manual gate **from this UI**. Do not do so merely because code is released.
   **Disable manual admission** stops new financial requests/approvals/claims,
   never releases existing reservations or enables automatic B2C.
5. On the created request, **Prepare approval** fills
   **Manual-only: transition → approved**. Confirm **Record manual transition**.
   Normal mode needs a different approver; explicit solo mode needs the same
   protected Owner. **Prepare execution claim → executing** records a durable
   claim before the sender may leave the site. Inspect the persisted claim/sender
   and state; a timeout or conflict is never permission to transfer or resend.
6. Only the authorized operator, **outside this application**, may transfer once
   in the official authorized portal. The site has no transfer button/call.
   On uncertainty, **Prepare uncertain** retains funds indefinitely.
7. Record genuine receipt evidence using **evidence** and the required **check**,
   then **Prepare receipt report → Record manual receipt**, supplying the actual
   unique reference, principal, fee, currency and timestamp. This is `reported`,
   **not paid**. A mismatch/duplicate creates a shared account hold, not success.
8. Append the real checked statement with **Prepare next statement**; use
   **Prepare statement debit → Record manual debit** for its observed exact line.
   Then **Prepare reconciliation → Record manual reconcile** binds the registered
   line and separate checked reconciliation evidence. Normal mode requires a
   reconciler other than the sender; explicit solo requires the same Owner.
   Only successful atomic statement-debit reconciliation changes status to `paid`.

Prefill buttons never submit. They clear stale form fields/confirmation and retain
the same generated UUID for retries of the same prepared request/claim within the
open page, including failed submissions. Buttons are disabled while submitting.
After a browser restart, inspect persisted queue/payout/claim history before another
financial attempt. Couple retries keep their key and amount after an ambiguous error;
refresh history before creating anything else. Legacy withdrawal/Mark sent stays off.

**Owner inputs, in order (none should be sent as secrets in chat):** choose the
real funded canonical account/provider/currency and prove authorized portal/rail
entitlement; designate an access-controlled external evidence repository, canonical
account register and recipient-validation/retention procedure; complete existing
private wedding KYC/consent and immutable verified recipient revision; supply actual
statement chain/settlements plus historical commitments/refunds/holds; decide explicit
per-transfer and daily caps, fee (including an explicitly reviewed zero), supported
`wedding` fee payer, statement freshness, exact allowed recipients and normal vs
explicit Owner-solo mode. Enter opaque evidence UUIDs/digests in **Manual-only:
evidence**, and the reviewed operating settings in **Protected Owner manual policy**.
The application does not host/upload these external documents or invent secure
storage. Until these non-secret decisions and external verification are complete,
financial admission remains blocked; enabling it still requires separate permission.

## Authority and evidence

Only Owner/SuperAdmin can mutate operational records, including via direct RPC.
Regular Admin, wedding helpers and clients cannot. Only the protected Owner can record
policy-review evidence; no other actor can change policy authority. There are no assumed
limits, fee schedule, funded-account entitlement or verification defaults.

Evidence stores an opaque external repository UUID, SHA-256 digest, kind, author and
timestamp. An independent leader records an immutable check. Recipient revisions bind
the evidence, provider/currency and a hash of the current private KYC/consent record. New revisions and KYC
changes invalidate old requests at approval/execution. No recipient names, account
numbers, KYC documents, free-text notes or public document URLs are accepted by the new
API. Operational history is leadership-only; couples receive their own amounts and
states, without private evidence/actors. Recipient identity is shown only as an opaque
revision (no full or partially revealing account details).

**Manual evidence acceptance is a human attestation, not automatic provider
verification.** The application does not fetch or verify the external document's
contents or digest. Secure custody, ownership/recipient validation and evidence retention
procedures are prerequisites, not capabilities fabricated by these records. Existing
`details_encrypted` naming is not proof of encryption/key management; this implementation
does not reuse it to collect plaintext secrets.

**User-approved manual exception:** the protected Owner may explicitly opt into solo
manual processing. `owner_solo=true` is an immutable request choice (included in
idempotency comparison), and every transition records its actual actor and solo flag.
Only that same protected Owner may process such a request. Owner self-checks of evidence
also require an explicit solo flag and are audited. Normal two-person requests cannot
use self-checked evidence without a separate independent check. Solo mode never bypasses
recipient/KYC/consent checks, custody, amounts, receipts, reconciliation or uncertainty
holds. Other SuperAdmins require **two distinct authorized actors**: requester may be
sender, and the independent approver may be reconciler. Regular Admin remains excluded.
Revoked requester/approver/evidence-reviewer authority blocks new approval/execution.

## State and accounting contract

| Transition | Required authority/evidence | Accounting effect |
|---|---|---|
| New request | Leader, unique idempotency key, exact amount/fee/currency, accepted recipient revision and statement entitlements | Atomic reservation |
| requested -> approved | Leader other than requester; rechecked funds, recipient and KYC | Reservation retained |
| approved -> executing | Sender other than approver; unique durable claim key; funds/recipient rechecked | Reservation retained; claim committed **before** operator visits portal |
| executing -> uncertain | Claimed sender | Reservation retained indefinitely; never blindly resend |
| executing/uncertain -> reported | Claimed sender, unique scoped receipt, exact amount/fee/currency/date and statement evidence | Reservation retained; **not paid** |
| reported -> paid | Exact independently checked transaction-debit verification for a shared manual scope, or the original registered statement-debit reconciliation for a legacy scope; independent reconciler or explicit protected Owner solo | Final spent commitment, never recredited |
| requested/approved -> cancelled | Leader; no claim may exist | Reservation released |
| executing/uncertain -> resolution_proposed -> not_transferred | Checked no-transfer evidence; distinct resolution checker or explicitly opted-in protected Owner solo | Release only after evidenced no-transfer decision |

The explicit protected-Owner solo exception also applies to the review/execution
independence conditions in this table; every evidence and accounting condition remains.

A no-transfer proposal may still receive a late transfer receipt before resolution.
After final no-transfer resolution, contradictory later evidence needs a separately
designed exception process; do not mutate history or create a blind resend.

`manual_payout_transition(...,'paid',...)` is always rejected. The dedicated
`manual_payout_reconcile` RPC requires distinct receipt and reconciliation evidence
kinds and appends the immutable debit reconciliation before the terminal event.
Receipt attestation alone never declares payment.

For legacy statement-mode requests, the batch must already exist for the request's custody account and currency, with
accepted statement evidence. First register the observed debit using
`manual_payout_register_statement_debit(batch,line,reference,actual,fee,currency,at,evidence)`.
This records immutable `manual_payout_statement_debit_entries`, checks the batch's
period watermark, reserves its unique canonical line and debit capacity, and requires
checked statement evidence separate from the sender's receipt. The reconciler must
match that existing entry's exact reference, amount, fee, currency and booked date.
Missing, unrelated, duplicate, over-capacity or mismatched entries cannot make paid.
The reconciliation row, its `statement_entry_id`, allocated `statement_debits` row
and paid event commit together; a database trigger also rejects a paid event without
the bound allocation. The former post-paid `include_debit` path is retired.

The channel-neutral revoked
`manual_payout_finalize_reconciliation_internal(id,channel,provider,account,statement,
line,reference,actual,fee,currency,at,evidence,allow_owner_solo DEFAULT false)`
performs the same current-role, independence, evidence, account, period, line and
capacity checks and atomic writes for both channels. Automatic wrappers must pass
`automatic_b2c,false` and retain their own policy/eligibility checks; they must not
insert their own paid events. Its non-execution intake counterpart is
`manual_payout_register_statement_debit_internal(batch,line,reference,actual,fee,
currency,at,evidence,allow_owner_solo DEFAULT false)`. Neither helper is executable
by authenticated/service roles directly.

Claims have no expiry. Claim replay is rejected with a conflict; inspect the original
recorded claim and external outcome rather than treating a retry as transfer permission.
Duplicate receipts and mismatches in amount, currency, fee or date atomically preserve
the reported actual fields/evidence in an append-only **custody-account incident**,
not a successful receipt. The report RPC returns `false`; the API explicitly returns
HTTP 409 with `held: true`, after the safety record commits. Do not raise an exception
after writing an incident: that would roll its account freeze back.
Uncertain/resolution-proposed outcomes additionally block other reservations
or executions on that custody account until an exact receipt or evidenced no-transfer
resolution is recorded. There is no override that makes a mismatched transfer paid.

Late contradictory evidence after `not_transferred` (or any other terminal outcome)
never rewrites its history or silently becomes spendable: `manual_payout_account_holds`
freezes the entire custody account across **both** channels. The revoked internal
`manual_payout_hold_account(id,evidence,channel,authority_actor,reference DEFAULT NULL,
actual DEFAULT NULL,fee DEFAULT NULL,currency DEFAULT NULL,at DEFAULT NULL,
journal DEFAULT NULL,journal_sha256 DEFAULT NULL) -> uuid` takes advisory `71110001`
and the shared row locks. Manual observations bind real receipt evidence. Automatic
observations may instead bind an opaque durable journal UUID and SHA-256 digest,
never a fabricated manual-evidence repository reference or human verification.
The trusted automatic wrapper must first verify immutable journal-to-dispatch/claim
correlation. Its configured policy authority and current role are recorded honestly;
a safety-only service observation can freeze even after that authority is revoked.
No authenticated/service-role caller can invoke the helper directly. There is no
incident-release RPC in this release, including for protected Owner solo mode.
Resolving an actual contradictory transfer requires a separately reviewed incident
procedure, not deleting records, resending, or changing the old terminal decision.

Custody accounts are segregated by provider, canonical registry ID and currency.
One opening statement is followed by a linear append-only chain: unique predecessor,
monotonic statement watermark, explicit opening/credit/debit/closing/held arithmetic,
unique statement reference and digest. Additional entitlements allocate only a new
batch's credit capacity. Opening gross entitlement capacity includes closing bank
funds (including held funds) plus explicitly mapped, evidenced pre-opening paid
debits; map that history before recording its original gross settlement sources.
This does not add bank capital: spending remains capped by closing minus held funds,
and mapped paid history is deducted from the wedding's gross entitlement exactly once.
Releasing a bank hold in a later statement needs no duplicate contribution credit.
Opening capacity and old contributions cannot be recredited.
Statement credit lines and contributions allocate once,
globally across accounts; each entitlement must match the provider-verified, live,
fee-known, platform-wallet contribution net amount and statement timing. An elapsed
`funds_available_at` timer never proves settlement and remains an additional hold.
Wedding currency and existing configured platform payout minimum/maximum are rechecked
at request, approval and execution. Direct settlement, tests, unknown
fees and held referral estimates are not entitlement sources.

Append-only source allocations bind exact current legacy payout, committed expense or
refund/dispute/hold snapshots to account/currency and evidence. Unknown or stale mappings
hold the affected amounts; they do not veto all history or silently make funds available.
Source revisions cannot move a commitment to another account. Once a paid legacy
expense/payout is mapped, its wedding, amount, currency, status and paid date cannot
be edited to erase the obligation; nonfinancial revisions require fresh evidence.
Historical statement line capacity stays consumed across later source revisions.
Paid sources mapped to statement debit capacity reduce wedding entitlement once, without
subtracting bank available funds twice. A paid manual debit is already included in
its exact independently reconciled statement at the atomic paid transition. In-flight,
uncertain, reported and resolution-proposed amounts always remain reserved, even when
a newer statement arrives. A negative adjustment followed by its positive dispute
reversal restores only the prior deduction, bounded by the original verified source;
an unbacked positive adjustment never creates new collected entitlement.

All manual writers take advisory lock `71110001`, revalidate and share-lock current
actor authority after waiting, then lock custody, relied-on reviewer profiles, sorted
contributions, wedding and request/KYC. Actor/reviewer role locks persist through COMMIT.
Existing financial writers use a nonblocking advisory guard because they may already
hold contribution/wedding rows: contention explicitly fails for retry rather than
waiting in reverse order. No adjustment event is silently discarded.

Opaque account UUIDs are **not proof that two aliases denote different real accounts**.
The account registry records a unique external canonical registry reference and checked
evidence before any custody envelope. This is a restricted attestation model, not an
automatic lookup of account ownership. Activation still requires an approved external
registry authority and verification procedure that assigns one canonical record to each
real account. Aliasing a real account through fabricated external records is not approved.
Canonical statement lines are uniquely assigned across contribution, historical-source
and manual-debit allocations; a conflicting reuse is rejected without editing history.

An automatic adapter must take the same `71110001` advisory lock before reservation
or claim and preserve custody -> sorted contributions -> wedding -> request/KYC order,
use the same eligibility checks and claim primary key, and retain every ambiguous
execution. Its independent gate/policy and cross-rail concurrency proof are owned by
the separately reviewed adapter, not authorized by this manual migration.

The legacy status RPC permits leadership cancellation only. Legacy approvals and
bare `Mark sent` are retired; a protected internal historical function is not callable
by authenticated/service roles. Existing historical `sent` records are not relabeled as
independently reconciled manual payments.

## Separate operational decisions before any activation

1. Identify the **existing** funded account/channel, authorized official portal and
   operators; verify account-specific entitlement and settlement/currency scope. An
   existing approved setup may suffice; a new Safaricom approval is not universally
   required. Code readiness or a successful initiation response is not proof.
2. Approve secure external evidence custody, access/reveal controls, retention,
   immutable document revisions, consent/recipient ownership checks and the KYC review
   procedure. Approve any necessary storage/encryption dependency separately.
3. Set actual per-transfer/aggregate limits, fee payer/amounts, statement freshness and
   settled-custody accounting rules, refunds/disputes/holds and existing-commitment
   allocations. None are guessed in this release.
4. Appoint the two-person staff workflow or explicitly select protected-Owner solo
   manual requests, with evidence review and statement reconciliation; define incident handling for receipt collisions, mismatches,
   uncertain outcomes, contradictory late evidence and independently proven no-transfer.
5. Separately authorize the protected Owner's operational activation of the reviewed
   policy using the new capability only after release and actual prerequisites are
   satisfied. Do not drop the historical OFF constraint or substitute a test gate.
   No external monitoring or notification delivery is proven by this capability.
   New exception-resolution
   procedures beyond the evidenced no-transfer path require separate review.

## Validation and release boundary

`npm run check`, `npm run check:referrals`, and `npm test` include API and mocked-browser
coverage. CI additionally runs populated-predecessor full COMMIT/DDL rollback,
rollback-only SQL scenarios and two-connection reservations/replays/claims/receipt
collisions, protected-Owner solo and two-person role/revocation boundaries. Only named isolated local/CI Docker databases accept simulated fixtures;
they never connect to a remote database or call a provider. The concurrency runner
temporarily substitutes the gate in the isolated database and restores its exact
definition in `finally`; those released-predecessor compatibility tests are retained.
The new readiness suite instead exercises the **real** default-OFF policy RPC, including
activation, two-person and explicit Owner-solo complete nonzero-fee reconciliation,
stale policy/role/statement denials, aggregate reservations, single claims, concurrent
Owner revisions, waiting-role revocation and outcomes after deactivation. Its populated
upgrade test verifies rollback/full COMMIT, unchanged finance rows and B2C definitions.
Fixtures exist only in the isolated database, destroyed by CI.

Require full green CI at the PR's **exact head**, coordinator migration dry-run at that
same head and separate DB-first deployment approval. Do not merge or manually push a
Production migration from this task. Deployment approval and live-activation approval
are separate decisions; this release remains OFF after deployment.
