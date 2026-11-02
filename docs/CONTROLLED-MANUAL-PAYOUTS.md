# Controlled manual external payouts (default OFF)

This is a bounded **unactivated control plane**, not launch-ready withdrawals or an
authorized funded rail. Migration `202611110001` does not enable any payment or payout
provider, initiate transfers, contact an external service, copy B2C branch code, or
modify historical finance records. Automatic transfers retain their existing hard-OFF
gate. The new manual policy is separately constrained OFF; this release has **no
activation RPC**. Deploying code or recording an Owner policy document is not activation.

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
| reported -> paid | Separate immutable statement-debit reconciliation binding account, reference, amount, fee, currency, date and unique statement line; independent reconciler or explicit protected Owner solo | Final spent commitment, never recredited |
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
batch's credit capacity. Opening capacity and old contributions cannot be recredited.
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
Paid sources mapped to statement debit capacity reduce wedding entitlement once, without
subtracting bank available funds twice. Manual paid debits remain account commitments
until their exact independently reconciled statement line is included once. In-flight,
uncertain, reported and resolution-proposed amounts always remain reserved, even when
a newer statement arrives. Positive adjustments do not create new collected entitlement.

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
5. Separately approve and implement an Owner-controlled activation mechanism with its
   own reviewed migration, policy bindings and operational tests. Do not drop the OFF
   constraint or substitute the test gate in Production. New exception-resolution
   procedures beyond the evidenced no-transfer path require separate review.

## Validation and release boundary

`npm run check`, `npm run check:referrals`, and `npm test` include API and mocked-browser
coverage. CI additionally runs populated-predecessor full COMMIT/DDL rollback,
rollback-only SQL scenarios and two-connection reservations/replays/claims/receipt
collisions, protected-Owner solo and two-person role/revocation boundaries. Only named isolated local/CI Docker databases accept simulated fixtures;
they never connect to a remote database or call a provider. The concurrency runner
temporarily substitutes the gate in the isolated database and restores its exact
definition in `finally`; committed fixtures disappear when CI destroys that database.

Require full green CI at the PR's **exact head**, coordinator migration dry-run at that
same head and separate DB-first deployment approval. Do not merge or manually push a
Production migration from this task. Deployment approval and live-activation approval
are separate decisions; this release remains OFF after deployment.
