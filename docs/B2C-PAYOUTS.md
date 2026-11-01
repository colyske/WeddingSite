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
- Reservation plumbing persists one durable dispatch per payout and a unique
  idempotency key, intended to precede any future provider request. The current
  dispatch entrypoint rejects before reservation or provider work. An existing
  claim can never send again,
  regardless of whether the caller uses a new key. `submitting`, `accepted` and
  `uncertain` all retain the original payout reservation.
- Acceptance is **not** settlement. Journal plumbing holds timeout and
  inconclusive evidence as `uncertain`, never a blind retry. Provider transport,
  acceptance and QueueTimeOut parsing are not implemented.
  The authenticated scheduler marks missing final results uncertain after
  30 minutes, including after the admission kill switch is turned off.
  This timeout is a hold/escalation rule, not an auto-approval threshold.
- Managed payout records cannot be manually marked sent or cancelled. A future
  verified Result integration or independently reviewed official statement is required.
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

### Current portal: public documentation unavailable on detail routes

The rendered [API discovery page](https://developer.safaricom.co.ke/apis) was
read successfully. Its actual links are
[BusinessToCustomer](https://developer.safaricom.co.ke/apis/BusinessToCustomer),
[TransactionStatus](https://developer.safaricom.co.ke/apis/TransactionStatus) and
[AccountBalance](https://developer.safaricom.co.ke/apis/AccountBalance).
The B2C detail page rendered only navigation/footer, with no specification.
Lowercase candidate URLs and legacy 404s are not contract evidence.

Research went beyond text-fetching the JavaScript shell. Public portal build
`0T7Cxv-BCd9_baYHXmnSO` exposes the read-only `GetApiDocumentation` /
`populateApi(apiName: ...)` query in
[this official JavaScript asset](https://developer.safaricom.co.ke/_next/static/chunks/3pgh6ay-_-343.js).
It includes markdown, documentation sections and `postmanCollectionLink` fields.
Public documentation-only queries to
`https://developer.safaricom.co.ke/api/graphql` for all three API names returned
`{"errors":[{"message":"Something went wrong. Please try again later."}]}`.
These were public content reads, not simulation, transaction, balance or
account API calls. No login was attempted. No current downloadable contract,
Postman collection or production certificate was obtained through these routes;
this is an access limitation, not proof those documents do not exist.

### Verified first-party historical SDK evidence

These pinned Safaricom repositories establish historical behavior, **not a
current account-specific production contract**:

| Official source | Verified evidence and limitation |
| --- | --- |
| [Node B2C endpoint, commit `678e3c33b20c1447c209eb88eded89f1bb751e11`](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/b2c.js) | Historical `/mpesa/b2c/v1/paymentrequest`; `InitiatorName`, `SecurityCredential`, `CommandID`, `Amount`, `PartyA`, `PartyB`, `Remarks`, `QueueTimeOutURL`, `ResultURL`, `Occasion`. Commands: `SalaryPayment`, `BusinessPayment`, `PromotionPayment`. Does not establish any particular shortcode's command entitlement or v3 contract. |
| [Node client at the same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/m-pesa.js) | Historical production base `https://api.safaricom.co.ke` and sandbox base `https://sandbox.safaricom.co.ke`. Neither host was called. |
| [Node credential helper at the same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/helpers/security.js) | RSA public-key encryption using `RSA_PKCS1_PADDING` (PKCS#1 v1.5), then Base64. This supports the historical algorithm, not current production certificate provenance or initiator authorization. |
| [Node sandbox certificate at the same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/keys/sandbox-cert.cer) | RSA 2048, subject `CN=apicrypt.safaricom.co.ke`, issuer `Safaricom Internal Issuing CA 02`, validity 2014-11-12 to 2016-11-11. Expired and unusable; never bundled or substituted for production. SHA-256: `a542c3c67b598a337a1cc741e5434c70de565081e5c853e05a51c843764766f0`. |
| [PHP callback handlers, commit `5effb808e79ba6b3d8631ef83c2b9b31fa450152`](https://github.com/safaricom/mpesa-php-sdk/blob/5effb808e79ba6b3d8631ef83c2b9b31fa450152/src/TransactionCallbacks.php) and [README](https://github.com/safaricom/mpesa-php-sdk/blob/5effb808e79ba6b3d8631ef83c2b9b31fa450152/readme.md) | Historical result fields and callback examples, but B2C/B2B-named handlers have inconsistent positional parameter mappings. No authoritative concrete QueueTimeOut body was established. Unsafe as the sole source of a canonical B2C parser. |
| [Node Transaction Status request at commit `678e3c33b20c1447c209eb88eded89f1bb751e11`](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/transaction-status.js) and the PHP callback handlers above | Historical request and positional response labels only; not a verified current keyed response schema or proof of an exact destination MSISDN. |
| [Node Account Balance request at the same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/account-balance.js) and the PHP callback handlers above | Historical request; callback SDK references `accountBalance` and `BOCompletedTime`. Not a verified current account-allocation or reconciliation contract. |

The PHP SDK references `ResultCode`, `ResultDesc`, `OriginatorConversationID`,
`ConversationID`, `TransactionID` and `ResultParameters.ResultParameter`.
Its Transaction Status positional labels include `ReceiptNo`, `ConversationID`,
`FinalisedTime`, `Amount`, `TransactionStatus`, `ReasonType`,
`TransactionReason`, `DebitPartyCharges`, `DebitAccountType`, `InitiatedTime`,
`OriginatorConversationID`, `CreditPartyName` and `DebitPartyName`.
Account Balance references `ResultType`, conversation/result/transaction fields
and the balance/time parameters above. These are exactly **SDK observations**,
not independently established current official response guarantees.
An `Amount` variable label is not sufficient to promise a current response
contains a trustworthy amount; party names do not prove the destination MSISDN.
Transaction Status is therefore neither implemented nor accepted as settlement
proof. An authoritative B2C Result/QueueTimeOut keyed schema is still missing.

**Implementation remains hard-blocked.** No API version has been selected;
historical v1 evidence does not verify v3, and does not prove v3 invalid.
The guessed v3 request, encryption implementation and callback parser were
removed. An environment assertion or operator-supplied parameter mapping cannot
certify missing code or official evidence. Required later: current request and
acceptance/correlation contract, exact result/timeout schema, current official
production certificate/provenance and account-specific initiator/CommandID
entitlement. There is no bundled certificate or active encryption code.

A future Result integration must establish official amount, exact destination
MSISDN and receipt evidence. Recipient-name text or registered-customer flags
are not exact-MSISDN evidence. If the verified contract lacks usable destination
evidence, callbacks must remain inconclusive and require independently reviewed
official statements. Neither nonzero result codes nor timeouts prove that no
money moved or no fee was charged.

## Configuration and activation prerequisites

All flags are default-deny; do not enable them as part of deployment of this code.
Configure secrets only in the approved deployment secret manager.

| Configuration | Required later evidence |
| --- | --- |
| `WEDDINGSITE_PAYMENT_MODE=live`, `DARAJA_ENVIRONMENT=production` | Explicit approved production context; no sandbox transfers supported. |
| `DARAJA_B2C_ENABLED` | Separate live payout kill switch; omitted/false now. |
| `DARAJA_B2C_API_VERSION` | Reserved, unused scaffolding configuration; version must be selected only after current official contract verification. No default. |
| `DARAJA_B2C_CONTRACT_VERIFIED`, `DARAJA_B2C_CAPABILITY_CONFIRMED` | Authorized independent confirmation; omitted/false now. |
| `DARAJA_B2C_SHORTCODE`, `DARAJA_B2C_SHORTCODE_CONFIRMED` | Exact match; B2C-capable, funded utility account. |
| `DARAJA_B2C_COMMAND_ID` | Officially approved command for that shortcode, matching Owner policy. |
| `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET` | Existing production app's authorized OAuth credentials; presence does not establish B2C capability. |
| `DARAJA_B2C_INITIATOR_NAME`, `DARAJA_B2C_INITIATOR_PASSWORD` | Authorized production initiator, separate from STK passkey; no secret requested in chat. |
| `DARAJA_B2C_CERTIFICATE_PEM`, `DARAJA_B2C_CERTIFICATE_SHA256` | Independently obtained official production certificate and confirmed fingerprint/algorithm. |
| `WEDDINGSITE_PUBLIC_ORIGIN` | Approved public HTTPS origin with both `/api/b2c?action=result` and `action=timeout` reachable. |
| `DARAJA_B2C_RESULT_MAPPING` | Reserved and unused; configuration cannot replace an implemented, independently verified callback schema. Leave absent. |
| `CRON_SECRET` | Existing authenticated Vercel scheduler secret; no secret value changes here. |
| `DARAJA_B2C_AUTO_APPROVAL_ENABLED` | Separate optional auto-approval gate; omitted/false now. |

Owner policy activation requires a fresh revision, explicit user approval
reference, official contract reference, shortcode/command binding, known payout
fee and verified utility-budget allocation with official statement reference.
The live collection approval record remains unchanged and cannot activate B2C.
The daily Vercel worker currently performs only stale-hold housekeeping and never
processes a payout. It cannot initiate provider work even if deployment flags and
Owner policy are changed.

Reservation plumbing stores a hash of an independent 256-bit callback capability,
intended for a future private callback URL. Event plumbing requires both provider
conversation IDs to match the persisted dispatch. The current callback route
authenticates the capability, audits rejection and never interprets provider
payloads or settles. There is no assumption of provider webhook
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
| `recipient-review` (POST) | Owner-only documented account-review evidence or revocation; not destination-ownership verification. |
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

Node regressions verify the hard-blocked dispatch/callback implementation and
housekeeping behavior; no Daraja host is contacted.
`tests/db/b2c.sql` runs in the isolated Supabase CI database and transaction-locally
overrides the destination gate/reservation wrapper solely to exercise journal
plumbing with synthetic fixtures, not to claim an executable provider integration.
It verifies policy authorization/revisions, ledger exclusions, reservation,
idempotence, account-review invalidation, callback binding, timeout holds,
independent reconciliation and retained failed-payout fees.
`tests/db/b2c-prerequisites.sql` exercises actual hard-deny prerequisites and
internal-RPC restrictions without clearing the destination gate.
All database fixtures and overrides are rolled back.
The same CI migration job runs the existing Paystack and KYC regressions.
