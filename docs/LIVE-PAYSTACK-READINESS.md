# Paystack live collection readiness

Implementation only. Live Paystack defaults **OFF**. No Production changes,
provider subaccount creation, payments, refunds, transfers, emails or activation
were performed for this change. Fixture success is not merchant eligibility or
evidence of live operation. Daraja collection/reconciliation and its separate
hard-OFF payout gate remain independent.

**Standard collection is independent of split eligibility.** The default selected
mode is `standard`, but selection is not live activation: Owner standard approval,
deployment switches, merchant/currency configuration and leadership provider
controls must all pass. Split remains unavailable in this build, even to the Owner,
pending a verified supported beneficiary allocation/statement contract. There is
never a silent split-to-standard fallback.

Fresh main's Daraja incident repair `abce399` is integrated. Unapplied Paystack
migrations are `202611010002_paystack_live_collection.sql` and
`202611010003_paystack_publication_reconciliation.sql`, after the already-applied
`202611010001_daraja_processing_recovery.sql`. Daraja's non-terminal processing
codes, cancelled-payment recovery and exactly-once fulfillment remain intact.
Supabase Docker migration reset, schema lint and rollback SQL regressions are the
release reference; PGlite is supplementary, not a substitute.

## Official capabilities and account prerequisites

Sources reviewed 1 November 2026:

- [Kenya pricing and settlement](https://paystack.com/ke/pricing): local/international
  card collection, KES/USD presentation and settlement; USD settlement requires
  a Kenya-based USD-domiciled bank account. Advertised T+2 is not transaction
  settlement evidence. Do not use the marketing fee percentages as an accounting
  estimate; record the actual provider fees.
- [Single-subaccount splits](https://paystack.com/docs/payments/split-payments/):
  `subaccount`, `transaction_charge` and `bearer` can route a flat platform fee.
- [Dynamic multi-splits](https://paystack.com/docs/payments/multi-split-payments/):
  flat subunit shares, explicit fee bearer and signed `charge.success` split
  `formula`/`shares`. This implementation uses **one dynamic flat subaccount
  share**, with the platform receiving the remainder, to verify actual platform,
  couple and provider allocations when supported evidence is established.
  **It is gated unavailable, not required for standard collection.**
- [Subaccounts API](https://paystack.com/docs/api/subaccount/): authenticated
  fetch supplies integration/domain/currency, active and verification state.
  Creation examples return `is_verified: false`; creation is not verification.
- [Transaction API](https://paystack.com/docs/api/transaction/): server
  initialization and authenticated independent verification; transaction IDs
  are unsigned 64-bit. A lossless JSON parser retains these as strings.
- [Settlements API](https://paystack.com/docs/api/settlement/): subaccount-filtered
  statements and paginated constituent transactions.

Schema re-review: the multi-split guide documents the initialization fields and
signed webhook `formula`/`shares` structure used here, but its allocation example
is **percentage**, not flat, and does not establish this merchant's fee behavior.
The Settlements API transaction example has `split: {}`, `subaccount: {}` and
`fees_split: null`; it does **not** document populated per-destination
`split.shares` for settlement transactions. This implementation deliberately
rejects that empty evidence and cannot claim automatic split-settlement
reconciliation works for the account. Account-specific supported evidence must
be confirmed before **split** activation. Statement totals alone must never substitute
for a verified beneficiary allocation.

### Standard collection prerequisites

For standard Paystack, confirm the actual merchant integration ID, approved
business/collection use, enabled channels, charge limits, market/currency pairs
and platform merchant settlement bank/currency in the Paystack account. A merchant
being activated does not establish every currency/channel or split capability.
Use the provider's authenticated transaction verification schema: successful
status, exact reference, amount/currency, `domain`, immutable context metadata and
actual `fees`. Unsplit responses can have `split: {}`, `subaccount: {}` and
`fees_split: null`; populated or unknown-shaped split fields fail closed. No
couple subaccount, beneficiary consent or split statement evidence is required.
Standard collection does not require payout KYC, but existing KYC, holds and the
hard-OFF payout gate still govern withdrawals.

Provider charges are borne by the couple's platform wallet under the existing
non-split accounting model. Verified gross minus the immutable Owner platform fee
is the ledger net; actual provider fees are deducted separately. The immutable
Paystack allocation records couple = gross - platform fee - actual provider fee.
These are transaction records, not proof of bank settlement or available payouts.

### Additional split prerequisites (unavailable in this build)

These public documents **do not prove** that this merchant can use Kenyan
couple subaccounts/dynamic splits, accept every displayed currency or onboard
every beneficiary type. No blanket country restriction is inferred. Before
split can be implemented/enabled, the account owner must obtain account-specific Paystack confirmation
of:

1. The merchant integration ID, approved business/marketplace use, beneficiary
   eligibility, live Split Payments/dynamic flat splits, supported
   market/currency pairs, provider channels and minimum/maximum charge limits.
2. KES and/or USD split settlement eligibility **for each receiving subaccount**,
   its permitted bank/wallet destination and any extra beneficiary verification.
   Do not infer USD subaccount support from USD merchant collection.
3. The applicable merchant fee/settlement contract and who bears provider fees.
   Default bearer is **couple/subaccount** so the platform receives exactly its
   Owner-configured fee. Choosing **platform/account** reduces platform receipts
   by the provider fee. Negative allocations are rejected, never clamped.
4. Refund/chargeback liability and clawback behavior for already-settled split
   proceeds, reserve requirements and operational reconciliation access.
5. Real account responses containing usable verification and allocation evidence.
   If `is_verified`, merchant/domain/currency, split formula/shares or
   per-destination statement evidence is absent or different, this build holds
   the payment/settlement for review. **Do not relax checks based on fixtures.**
   Capture a redacted schema with separate approval and adjust/test the contract
   before activation if Paystack requires a different supported mechanism.

Subaccounts must already exist after a separately approved Paystack onboarding
operation. There is deliberately no provider subaccount creation/update,
transfer or refund endpoint here. The Owner verification form makes only an
authenticated **GET**; it never stores/returns bank details. A one-way destination
fingerprint detects external account changes and resets required re-verification.
The couple separately consents to the verified destination revision. Both
partners' required-details-and-consent KYC must be complete before direct
collection; this is **not independent ID verification**. Neither blocks publishing.

## Controls and immutable accounting

| Control | Effect |
| --- | --- |
| `WEDDINGSITE_PAYMENT_MODE` + matching `PAYSTACK_SECRET_KEY` prefix | `test` or `live`; mode/key mismatch fails closed |
| `PAYSTACK_MERCHANT_ID`, `PAYSTACK_LIVE_MERCHANT_CONFIRMED` | Bind the deployment to an explicitly confirmed integration ID |
| `PAYSTACK_LIVE_COLLECTION_ENABLED=false` | Master default-OFF new live Paystack guest/publication admissions |
| `PAYSTACK_LIVE_PUBLICATION_ENABLED=false` | Additional independent publication admission switch |
| `PAYSTACK_RECONCILIATION_ENABLED=false` | Independent verification/webhook/statement control; admission also requires it on |
| `PAYSTACK_LIVE_SPLIT_ENABLED=false` | Additional split-only deployment gate; standard does not require it |
| Owner Paystack policy | Default-OFF DB approval, capability pairs, standard/split/publication scopes, split fee bearer and revision |
| Owner settlement-mode control | Audited, revision-checked `standard` / `split`; no change to admitted rows or activation switches |
| `paystack_split_contract_unverified` DB constraint | Split readiness cannot be set true in this build; UI, API and SQL cannot enable it by toggling |
| Leadership payment-provider allowlist | Independent Paystack/Stripe/Daraja new-checkout switches; regular Admin cannot change finance settings |
| Verified destination + couple consent + KYC | Required only for direct guest settlement; not for standard collection or publication |

Revoking collection, Owner approval or the provider allowlist does not turn off
reconciliation. Keep reconciliation enabled for admitted live payments.
Credential fingerprints bind the exact key/merchant/mode: changing any of them
holds old payments instead of querying them with another merchant's key.
This build does not keep historical keys; securely plan reconciliation before
key rotation or changing the global payment mode. Never paste credentials into
chat, browser code, logs or SQL migrations.

Guest admission snapshots server-derived settlement mode/route, wedding, environment, merchant/key
fingerprint, split-only subaccount ID/code/revision/fingerprint, amount/currency, market,
fee bearer, platform policy/revision and USD fixed-fee FX. SQL locks policy and
destination controls and rejects stale quotes. Initialization rechecks approval,
provider controls and destination revision, and persists the known reference
**before** contacting Paystack. An uncertain initialization retains its pending
record and idempotency key; do not automatically reinitialize or delete it.
Owner policy/mode writes require the current policy revision in SQL as well as
the API. Toggle races before admission/initialization are held; a later toggle
never reroutes an admitted standard or split payment, callback, adjustment or
payout eligibility. Publication stays platform-only regardless of the guest mode.

Existing fees and historical rows are not converted or repriced. A nonzero fixed
live Paystack fee must be Owner-configured in **USD**; a legacy non-USD policy
holds admission until the Owner explicitly decides the new policy. SQL numeric
arithmetic rounds percentage fees to the nearest minor unit and rounds converted
fixed USD fees up, using an immutable rate no older than 36 hours. Chosen wedding
currency is retained. Unsupported monetary exponents are rejected by the existing
two-decimal accounting boundary.

Signed webhooks are independently checked through transaction verification
before fulfillment. Amount/currency/reference/context must match. Standard verifies
the authenticated unsplit charge and actual provider fee, without split evidence.
For split, merchant formula/shares must also match; platform + couple + provider shares must exactly
conserve the amount. A signed split may supply the documented allocation evidence
when transaction verification omits it; unsigned redirects cannot. Missing
allocation evidence on polling remains unresolved until the signed event or
provider verification supplies it. Duplicate events cannot double-credit songs,
RSVPs, VIPs, sponsorships, registry gifts or campaign contributions.

`paystack_direct` receipts and their refund/dispute journal entries are excluded
from **every WeddingSite withdrawal calculation and payout trigger**, even if a
different provider's payout gate is opened in future. Finance retains gross
fundraising history and reports direct allocations/provider settlement separately.
The couple UI explicitly shows zero withdrawable here; historical allocations
are not a current bank-balance statement.

Publication checkout is consistently supported in live mode **only for approved
Paystack**, platform-only and without subaccount/split parameters. Live Daraja
publication is not silently enabled by this change. Publication has its own
immutable USD/FX quote, reference and mode; test settlement stays `test_paid`,
live verified settlement is `paid`, and staff waivers remain preserved.

## Refunds, disputes and settlement reconciliation

Signed Paystack adjustments require independent original-transaction checks and
match immutable provider references. Guest adjustments retain the existing
Owner-snapshotted allocation/immutable ledger and review queues. Standard adjustments
affect only their existing platform-wallet ledger; split adjustments never debit
another wallet or create withdrawable direct funds. They do not initiate a refund.
Any actual split clawback/provider liability must be handled using Paystack's
approved contract and reviewed externally; an internal allocation is not proof
that Paystack moved funds.

Live publication adjustments have an immutable separate journal and hold new
publication actions until the **Owner** records entitlement review. The Owner
may require a new payment, explicitly waive, or retain paid entitlement only for
failed/restored adjustment evidence. Existing published sites are not
automatically unpublished. This deliberately avoids inventing refund/republishing
product behavior; reasons and decisions are audited.

Split-only leadership statement reconciliation uses provider GETs, bounded to 20 pages
of 100 records for both subaccount statements and transactions. It requires the
correct merchant/domain/currency/destination, the admitted transaction and exact
per-destination totals. Missing shares, deductions, mismatched totals or pagination
remain for review rather than creating success-shaped fallback evidence. The
documented empty statement example is rejected. Standard receipts use the
existing wallet hold/accounting model; this split statement action rejects them.
A verified `success` statement adds an immutable internal settlement event; it
never creates a WeddingSite payout. Review pending/review checkouts periodically
even when no callbacks arrive; use the existing payment status endpoint for the
exact admitted reference, never a fresh checkout.

## Safe activation sequence (requires separate approval)

1. Review/merge code and apply additive migrations `202611010002` and `202611010003` **only to the
   WeddingSite project `lvvtgxspwvmdhqyoyqyy`**, after separate deployment approval.
   Never use CareerBoost Supabase. CI's migrations job is local-only.
2. Resolve the **standard** account prerequisites above. Keep all Paystack switches false.
   Configure encrypted live credentials, confirmed merchant ID, supported
   lists, exact HTTPS callback `/api/webhooks?provider=paystack` and Turnstile
   hostnames. Preserve the active Daraja configuration and gates.
3. Keep Owner settlement mode `standard`. Approve account-confirmed capability
   pairs and the intended standard/publication scopes. Leave split approval and
   `PAYSTACK_LIVE_SPLIT_ENABLED` OFF. Standard needs no subaccount checks, creation
   or couple destination consent. Changing the Owner mode alone cannot activate
   live collection or payouts.
4. Approve reconciliation independently; review schema/evidence readiness and
   unresolved historical payments. Then separately approve Owner live scopes,
   provider allowlist and collection/publication environment switches.
5. Only with **another explicit financial-testing approval**, perform a bounded
   real checkout and inspect authenticated transaction evidence. Confirm exact allocations, one
   fulfillment, duplicate-event idempotency, platform-only publication, kill/revoke
   reconciliation, refund/dispute handling, immutable mode after toggles and payout holds.
   None of these real-provider operations were performed for this implementation.

Local verification: existing Node/browser suites plus
`tests/paystack-live.test.js`, `tests/paystack-live.browser.test.js` and rollback
`tests/db/paystack-live.sql` / `tests/db/paystack-standard.sql`. SQL scenarios replay all migrations and exercise
actual PostgreSQL constraints/RPC/RLS with synthetic evidence. The split regression
temporarily drops the unavailable-contract CHECK only inside its rolled-back
transaction to simulate a future verified contract; it first proves the real CHECK
blocks activation. This is not eligibility evidence or a deployable enablement.
No fixture claims live financial operation.
