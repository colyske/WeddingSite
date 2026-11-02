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

## State and accounting contract

| Transition | Required authority/evidence | Accounting effect |
|---|---|---|
| New request | Leader, unique idempotency key, exact amount/fee/currency, accepted recipient revision and statement entitlements | Atomic reservation |
| requested -> approved | Leader other than requester; rechecked funds, recipient and KYC | Reservation retained |
| approved -> executing | Sender other than approver; unique durable claim key; funds/recipient rechecked | Reservation retained; claim committed **before** operator visits portal |
| executing -> uncertain | Claimed sender | Reservation retained indefinitely; never blindly resend |
| executing/uncertain -> reported | Claimed sender, unique scoped receipt, exact amount/fee/currency/date and statement evidence | Reservation retained; **not paid** |
| reported -> paid | Leader other than requester/sender; receipt evidence independently checked, exact evidence match | Final spent commitment, never recredited |
| requested/approved -> cancelled | Leader; no claim may exist | Reservation released |
| executing/uncertain -> resolution_proposed -> not_transferred | Checked no-transfer evidence; resolution checker distinct from sender, requester and proposer | Release only after independent no-transfer decision |

A no-transfer proposal may still receive a late transfer receipt before resolution.
After final no-transfer resolution, contradictory later evidence needs a separately
designed exception process; do not mutate history or create a blind resend.

Claims have no expiry. Claim replay returns the same recorded claim, not permission to
transfer again. Duplicate receipt errors retain the current reservation. A mismatch in
amount, currency, fee or date is rejected and must be investigated while funds remain
held. There is no operator override that makes a mismatched transfer paid.

Custody envelopes are segregated by provider, opaque account ID and currency.
Only one opening statement envelope per account/currency is supported in this bounded
release: no top-ups, snapshot refreshes or statement replacement. Its capacity is never
recredited on a paid payout. Statement credit lines and contributions allocate once,
globally across accounts; each entitlement must match the provider-verified, live,
fee-known, platform-wallet contribution net amount and statement timing. An elapsed
`funds_available_at` timer never proves settlement. Direct settlement, tests, unknown
fees and held referral estimates are not entitlement sources.

For safety, a wedding with **any existing expense, noncancelled legacy payout, refund,
dispute or adjustment ledger entry is ineligible**. This deliberately blocks rather
than guessing how to allocate deductions. Opening a custody envelope also blocks on
any unmapped historical expense, noncancelled legacy payout or payment adjustment
across the platform, since the historical rows lack reliable custody-account mapping.
This intentionally requires separate approved legacy allocation before live use.
New expense/legacy commitments cannot consume
a wedding with manual commitments, including amounts already paid. Manual reservations
and paid amounts are deducted once; uncertain/reported/resolution-proposed amounts
stay reserved. Refund/dispute writers and manual approval/execution serialize through
contribution-before-wedding row locking. All manual mutations additionally serialize
through a transaction advisory lock, then custody, sorted contributions, wedding and
request/KYC. This conservative implementation is not a general custody ledger rewrite.

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
4. Appoint maker, independent evidence reviewer/checker, sender and independent
   statement reconciler; define incident handling for receipt collisions, mismatches,
   uncertain outcomes, contradictory late evidence and independently proven no-transfer.
5. Separately approve and implement an Owner-controlled activation mechanism with its
   own reviewed migration, policy bindings and operational tests. Do not drop the OFF
   constraint or substitute the test gate in Production. Expanded statement replenishment
   or exception accounting is separate work.

## Validation and release boundary

`npm run check`, `npm run check:referrals`, and `npm test` include API and mocked-browser
coverage. CI additionally runs populated-predecessor full COMMIT/DDL rollback,
rollback-only SQL scenarios and two-connection reservations/replays/claims/receipt
collisions. Only named isolated local/CI Docker databases accept simulated fixtures;
they never connect to a remote database or call a provider. The concurrency runner
temporarily substitutes the gate in the isolated database and restores its exact
definition in `finally`; committed fixtures disappear when CI destroys that database.

Require full green CI at the PR's **exact head**, coordinator migration dry-run at that
same head and separate DB-first deployment approval. Do not merge or manually push a
Production migration from this task. Deployment approval and live-activation approval
are separate decisions; this release remains OFF after deployment.
