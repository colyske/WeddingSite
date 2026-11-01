# M-Pesa B2C payout automation (default OFF)

**Revision after coordinator review:** this is default-OFF scaffolding, not a
verified provider integration. The guessed v3 request, callback parser and
SecurityCredential encryption code have been removed. Dispatch cannot be enabled
by environment flags; both provider-contract implementation and verified
destination ownership are hard-blocked prerequisites. No merge or activation
is requested.

Join Our Wedding's B2C implementation is separate from STK collection approval.
The reported production app's B2C capability is **user-reported**, not a verified
credential, shortcode, initiator, command entitlement or funding configuration.
Nothing in this change enables dispatch, transfers funds between M-Pesa accounts,
changes credentials, or applies a migration to production.

## Shipped boundaries

- Additive migration `202611020001_b2c_payout_automation.sql`, after the Paystack
  migrations and `202611010010_custom_sponsorship.sql`.
- Existing `payout_records`, KYC, contributions, adjustment journal, expenses,
  staff approval and audit log remain authoritative. B2C adds a dispatch journal,
  callback events, recipient attestations and one Owner-controlled policy.
- Default policy requires four-eyes, disables dispatch and contains **no**
  auto-approval limits, payout-fee allowance or utility funding allocation.
  An Owner can later change approval mode with a revision-checked, audited policy
  and explicit `per_payout_minor`, `daily_minor` and nonempty `wedding_ids`.
  Automatic approval additionally requires its separate deployment gate.
  No limits or scope have been selected. Daily limits count reserved amount plus
  fee across all B2C dispatches that UTC day, including uncertain/failed attempts.
  Returning to four-eyes does not activate transfers.
- Only paid, provider-verified, live **Daraja/KES platform-wallet** funds with
  known provider fees and completed settlement holds are spendable by B2C.
  Test receipts, unknown-fee funds and **all Paystack funds**, including standard
  and direct/split receipts, are excluded. Existing direct-split exclusions are
  preserved. This gate does not authorize standard Paystack payouts.
- The global utility-budget row and wedding/payout locks serialize reservation.
  Existing requested/approved/sent payouts, outbound fee reserves, expenses and
  relevant refund/dispute journal entries/holds are deducted server-side.
  The configured known outbound fee is reserved in addition to the whole-KES
  transfer. Amount conversion rejects fractional KES; it never rounds.
- One durable dispatch per payout and a unique idempotency key are persisted
  **before OAuth or PaymentRequest**. An existing claim can never send again,
  regardless of whether the caller uses a new key. `submitting`, `accepted` and
  `uncertain` all retain the original payout reservation.
- Acceptance is **not** settlement. Transport failure, malformed acceptance,
  QueueTimeOut or inconclusive evidence becomes `uncertain`, never a blind retry.
  The authenticated scheduler marks missing final results uncertain after
  30 minutes, including after the admission kill switch is turned off.
  This timeout is a hold/escalation rule, not an auto-approval threshold.
- Managed payout records cannot be manually marked sent or cancelled. A bound,
  fully verified Result or independently reviewed official statement is required.
  Final outcomes are immutable. Duplicate callbacks are journal-idempotent;
  conflicting terminal evidence is separately audited for review.
- Failed dispatches do not optimistically credit the utility account budget.
  A failed principal also does not prove zero provider fee: the outbound fee
  remains held even after failure. No unsupported fee-release assumption is made.
  A new independently verified utility balance is necessary. Budget replacement
  is blocked while any dispatch is submitting, accepted or uncertain.
  The Owner records an official utility balance statement reference, timestamp
  and allocation; this is **not** an automatic Account Balance query.
  External account activity can invalidate that allocation: reserve funds for
  this dispatcher operationally and stop dispatch if account funding changes.

## Documented account-review evidence (not verified destination ownership)

The existing model's KYC is submission completeness and consent, **not**
independent identity verification. An STK receipt reference alone does not prove
its payer phone or that the payer is a couple partner.

The account-review workflow only documents the following evidence; it does not
verify partner identity or destination ownership:

1. Obtain the official M-Pesa statement through an authorized channel outside
   the application. Match the verified live inbound contribution's M-Pesa receipt
   against that statement; establish the actual sending MSISDN.
2. Record the claimed partner association separately; a payer MSISDN and KYC
   submission do not establish that association or partner identity.
3. Record only the secured evidence reference, contribution UUID and canonical
   `2541...`/`2547...` MSISDN using the Owner review action. Do not paste an ID
   document, statement contents or credentials into the application/chat.

The reviewer cannot review their own wedding. The RPC requires a verified live
Daraja inbound receipt and a matching partner KYC phone. It does **not** invent
an API-generated `verified` KYC status. Changes to the destination can be revoked;
dispatch rechecks an exact hash of the reviewed KYC snapshot as well as phone
matching and snapshots the reviewed recipient. KYC edits require renewed review.
A different **SuperAdmin user id** must confirm the protected Owner's documented
account review. A second role on the same user id does not count. Updates revoke
that confirmation. There is only one protected Owner, not two Owners.

**Dispatch is now hard-blocked even after both account reviews**:
`b2c_destination_ownership_verified` unconditionally returns false, and no
environment flag or policy field can change it. A suitable verified
destination-ownership process is an explicit unimplemented prerequisite.
It must bind actual control of the payout MSISDN to the authenticated partner
and reviewed identity/consent (for example, a separately implemented, rate-limited
OTP verification bound to that partner plus suitable identity review).
No OTP provider, independent identity service or official name/ID API is
configured or verified here. Such an implementation requires a separately
reviewed migration; statement evidence alone must never clear this gate.

Migration `202611020002_b2c_review_prerequisites.sql` adds this hard gate and
different-person controls. Reconciliation checks opposite Owner/SuperAdmin roles
and different user ids; a scheduled dispatch requires a SuperAdmin reviewer.
Outcomes remain uncertain when evidence is insufficient.

## Official-document evidence and limitations

Checked on 2026-11-01:

| Official source | What was actually retrievable |
| --- | --- |
| https://developer.safaricom.co.ke/ | Safaricom describes Daraja 3.0 as its web/mobile M-Pesa API platform. |
| https://developer.safaricom.co.ke/apis | API discovery shell; no detailed contract. |
| https://developer.safaricom.co.ke/apis/b2c | JS-rendered shell only; no PaymentRequest or callback specification. |
| https://developer.safaricom.co.ke/apis/transaction-status | Shell only; no response-field specification. |
| https://developer.safaricom.co.ke/apis/account-balance | Shell only; no account-balance specification. |
| Legacy `/APIs/BusinessToCustomer`, `/APIs/BusinessToCustomerPayment`, `/APIs/TransactionStatus` | HTTP 404; not contract evidence. |

**No detailed official B2C/Transaction Status/Account Balance contract was
independently verified from these pages.** In particular, there is no verified
evidence here that a Transaction Status response confirms recipient or amount.
No such query is implemented or accepted as settlement proof.
The exact official fields of those responses cannot responsibly be asserted.

The previous commit contained the following **unverified candidate v3** request,
now removed rather than presenting guessed schemas as an implementation:
`POST https://api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest`, with
`OriginatorConversationID`, `InitiatorName`, `SecurityCredential`, `CommandID`,
`Amount`, `PartyA`, `PartyB`, `Remarks`, `QueueTimeOutURL`, `ResultURL`, `Occasion`.
Candidate acceptance uses `ResponseCode`, `ConversationID`,
`OriginatorConversationID`. Candidate Result/QueueTimeOut envelopes use
`Result.ConversationID`, `Result.OriginatorConversationID`, `ResultCode` and
`ResultParameters.ResultParameter`. These are implementation assumptions,
**not claims of officially verified response fields**.

Before any integration implementation or activation, an authorized operator must inspect the actual official
account documentation and record its reference in the Owner policy, confirm this
entire candidate contract (including v3 originator echo) and the allowed
`BusinessPayment` / `SalaryPayment` / `PromotionPayment` command for the
shortcode. v1 and sandbox dispatch are deliberately unsupported/fail-closed;
their credential/correlation differences have not been verified.

There is no bundled certificate. The removed candidate credential encryption was RSA
PKCS#1 v1.5 of the initiator password with the supplied X.509 public key, encoded
as Base64. Runtime checks RSA type, certificate dates and the independently
confirmed SHA-256 fingerprint. The operator must verify the **correct official
production certificate, algorithm and initiator entitlement**; a sandbox
certificate must never be substituted. A matching fingerprint establishes
configuration consistency, **not provenance**.

The removed Result parser required configured parameter names, but configuration
cannot substitute for officially verified evidence. A future implemented
Result settlement would require explicitly verified official parameter names
for amount, exact recipient MSISDN and receipt. There is **no default mapping**.
Recipient public-name text or a registered-customer flag is not accepted as
an exact MSISDN. If the actual B2C contract supplies no independently usable
exact-recipient field, leave mapping absent: callbacks are correlated and audited
but remain uncertain, and official statement reconciliation is mandatory.
Nonzero ResultCode is also held for statement review, because failure payloads
may omit recipient/amount. Never guess missing evidence.

## Configuration and activation prerequisites

All flags are default-deny; do not enable them as part of deployment of this code.
Configure secrets only in the approved deployment secret manager.

| Configuration | Required later evidence |
| --- | --- |
| `WEDDINGSITE_PAYMENT_MODE=live`, `DARAJA_ENVIRONMENT=production` | Explicit approved production context; no sandbox transfers supported. |
| `DARAJA_B2C_ENABLED` | Separate live payout kill switch; omitted/false now. |
| `DARAJA_B2C_API_VERSION` | Must explicitly be `v3` after official contract verification. No default. |
| `DARAJA_B2C_CONTRACT_VERIFIED`, `DARAJA_B2C_CAPABILITY_CONFIRMED` | Authorized independent confirmation; omitted/false now. |
| `DARAJA_B2C_SHORTCODE`, `DARAJA_B2C_SHORTCODE_CONFIRMED` | Exact match; B2C-capable, funded utility account. |
| `DARAJA_B2C_COMMAND_ID` | Officially approved command for that shortcode, matching Owner policy. |
| `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET` | Existing production app's authorized OAuth credentials; presence does not establish B2C capability. |
| `DARAJA_B2C_INITIATOR_NAME`, `DARAJA_B2C_INITIATOR_PASSWORD` | Authorized production initiator, separate from STK passkey; no secret requested in chat. |
| `DARAJA_B2C_CERTIFICATE_PEM`, `DARAJA_B2C_CERTIFICATE_SHA256` | Independently obtained official production certificate and confirmed fingerprint/algorithm. |
| `WEDDINGSITE_PUBLIC_ORIGIN` | Approved public HTTPS origin with both `/api/b2c?action=result` and `action=timeout` reachable. |
| `DARAJA_B2C_RESULT_MAPPING` | JSON containing `amountParameter`, `recipientParameter`, `transactionParameter`, **only** when those official parameters prove the required evidence. Otherwise absent. |
| `CRON_SECRET` | Existing authenticated Vercel scheduler secret; no secret value changes here. |
| `DARAJA_B2C_AUTO_APPROVAL_ENABLED` | Separate optional auto-approval gate; omitted/false now. |

Owner policy activation requires a fresh revision, explicit user approval
reference, official contract reference, shortcode/command binding, known payout
fee and verified utility-budget allocation with official statement reference.
The live collection approval record remains unchanged and cannot activate B2C.
The daily Vercel worker currently performs only stale-hold housekeeping and never
processes a payout. It cannot initiate provider work even if deployment flags and
Owner policy are changed.

Every dispatch has an independent 256-bit callback capability, stored only as
a hash and carried in the private callback URL. Both provider conversation IDs
must match the persisted dispatch. There is no assumption of provider webhook
signatures. Keep callback query strings out of access logs and third-party
analytics; HTTPS and the capability are the callback authentication mechanism.
A callback racing acceptance persistence fails closed; later statement
reconciliation resolves it if provider redelivery does not occur.

## API and Owner dashboard

The Owner dashboard's **M-Pesa B2C** tab shows no-call readiness, approval policy,
recipient evidence review, dispatch states, emergency admission stop and
independent official-statement reconciliation. Approval editing cannot enable
dispatch. Existing payout approvals remain in the normal payouts workflow.
SuperAdmins have a B2C tab for redacted controls, status, approved dispatch and
reconciliation, but cannot view/change the full Owner policy or record recipient
attestations. An Owner-initiated dispatch can be reconciled by a different
SuperAdmin; the initiator cannot self-resolve an uncertain payout.

`/api/b2c` actions:

| Action | Authorization and effect |
| --- | --- |
| `readiness`, `policy` (GET) | Owner-only, no provider probes; policy and boolean deployment checks. |
| `policy-save` (POST) | Owner-only, explicit confirmation, current integer revision and audit reason. |
| `recipient-review` (POST) | Owner-only independent statement attestation or revocation. |
| `status` (GET) | Owner/SuperAdmin; capabilities and recipient phones redacted. |
| `controls` (GET) | Owner/SuperAdmin; only dispatch/approval booleans and revision, no full Owner policy. |
| `dispatch` (POST) | Hard-blocked: verified contract and destination ownership implementation missing. No provider or reservation call. |
| `worker` (GET) | Exact scheduler bearer secret; stale-hold housekeeping only, no dispatch. |
| `result`, `timeout` (POST) | Capability authentication and rejected-contract audit only; unverified callback schema not interpreted or settled. |
| `account-review-confirm` (POST) | A different SuperAdmin confirms the protected Owner's exact account-evidence reference; not destination verification. |
| `reconcile` (POST) | Owner/SuperAdmin independent official-statement review, not the dispatch initiator. Inconclusive review retains funds. |

Successful statement reconciliation must supply the bound amount/MSISDN and
an official transaction/statement reference. There is no free-form "mark sent"
or "retry" override. This workflow records evidence; it never invokes a reversal,
Transaction Status, Account Balance or account-funding transfer API.

## Pending user decisions

1. How funds move from the collection account to the B2C utility account, account
   permissions and exclusive/allocated dispatcher funding. No transfer method
   was selected or implemented.
2. Whether optional auto-approval should ever be activated, and its exact wedding
   scope, per-payout and daily limits. No scope/limits were selected.
3. Explicit approval of production activation after official-contract,
   recipient-verification, fee, credential, certificate and callback checks.

## Regression verification

Node regressions use synthetic injected transport only; no Daraja host is
contacted. `tests/db/b2c.sql` runs in the isolated local Supabase CI database,
uses rollback-only synthetic fixtures and verifies default gates, policy
authorization/revisions, ledger exclusions, reservation, idempotence, recipient
prerequisites, callback binding, timeout holds and independent reconciliation.
The same CI migration job runs the existing Paystack and KYC regressions.
