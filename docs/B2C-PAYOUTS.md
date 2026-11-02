# Guarded automated M-Pesa payouts

**Code and isolated/mock validation only; live dispatch is OFF.** The merchant's
B2C-enabled Daraja application is user-reported capability, not a balance,
credential or entitlement check. No transfer, account-funding instruction,
provider test charge, production migration or flag activation is authorized by
this implementation.

## One ledger, two execution channels

Automation depends on the controlled-payout foundation (`202611110001+`).
`202611120001_b2c_shared_dispatch.sql` extends its existing custody, recipient
revisions, requests, append-only states, execution claims and receipts.
The obsolete, never-released `202611020001/2` B2C migrations are removed rather
than introducing a second wallet or reservation system.

Both execution paths share advisory lock `71110001` and the foundation's
custody -> sorted contributions -> wedding -> request/KYC locking.
A request's primary-key execution claim belongs to **one** channel:
`manual_external` or `automatic_b2c`. It never expires or becomes resendable.
Paid, executing, reported and uncertain obligations remain charged to the
shared accounting calculation. A different HTTP key cannot send a claimed
request again.

The requesting couple or an authorized leader may cancel only an unclaimed
requested/approved B2C request, including while admission is OFF. Cancellation
locks the same request/account path as dispatch; claimed or uncertain transfers
cannot be cancelled. Client keys survive lost responses. A deliberate distinct
request key is offered only after the previous request is confirmed terminal.

Owner policy defaults to OFF, two-person approval, empty custody/recipient
allowlists and **no monetary or freshness limits**. An Owner can explicitly
configure audited, revision-checked automated approval. No limits are invented.
In review mode, separate current Owner and SuperAdmin user IDs must approve
the current policy revision. Manual Owner-solo permission is not an automated
approval permission. Independent final reconciliation remains required in
either automated mode.

## Collected funds, not external capital

There is **no requirement for another source of capital**. Payouts may use
actual available collected custody attributable to the wedding, after provider
fees, existing spending/reservations and refund/dispute holds.

A website receipt or ledger balance does not prove that the merchant can
disburse that amount through the selected B2C shortcode. The accessible official
sources did not establish this merchant's collection/working/utility account
relationship, whether they are distinct balances, or a supported authorized
same-funds movement route. Account names are not guessed from SDK variable
names. No funding transfer endpoint is implemented.

The onboarding workflow therefore binds the same collected funds to
independently checked official **disbursable** custody evidence and the exact
shortcode. The Owner records the authorized funding/account relationship as
checked policy evidence. If that relationship, current balance, allocation or
fee is unknown, the runtime holds with `B2C_FUNDING_NEEDED`. A current documented
allocation must not be reused to credit money twice. New settlement/custody
evidence must use the shared foundation's accounting controls, not reset an
available-balance counter.

All B2C accounting intake calls the foundation's revoked `*_internal`
validators with `p_allow_owner_solo=false`, after current Owner authority is
locked and rechecked. The independent manual gate is never substituted or
enabled. Account registry, linear statement batches, canonical statement lines,
source snapshots, credit/debit capacity and paid-debit inclusion therefore use
the same rules in both channels. Freshness reads the latest accepted shared
statement snapshot, not the original opening envelope.

Only live, paid, provider-verified Daraja/KES `platform_wallet` contributions
with known actual provider fees and official settled allocations qualify.
Test receipts, Paystack (standard and direct/split), unknown provider fees and
unresolved/mapped obligations are never silently counted as available.
Outward fees are explicit, reserved along with principal, and not assumed zero.

## Recipient control and identity are different checks

1. Staff checks identity, registered destination name, payout consent and
   association with the wedding against secured evidence. Only opaque evidence
   UUIDs and hashes enter this database. KYC completeness alone is not identity
   verification; an inbound payment/statement is not ownership verification.
2. A different leader checks that evidence. Create an immutable shared recipient
   revision bound to the exact current KYC snapshot, selected partner slot and
   exact independently reviewed destination MSISDN. The other partner's phone
   cannot silently substitute for that reviewed destination.
3. The authenticated wedding account verifies the exact submitted partner phone
   through Supabase Auth phone-change OTP. Supabase SMS must be configured by
   the operator; secure phone-change verification must remain enabled.
   The app limits new phone attempts per user; Supabase enforces verification
   and SMS rate controls. No staff receives or stores the OTP.
4. Bind the recipient revision to `auth.users.phone` and
   `phone_confirmed_at` server-side. The database, not the browser, establishes
   current confirmed control. This is **phone control, not name or legal
   identity verification**.
5. Requests/claims recheck the current user, phone confirmation, partner phone,
   consent, KYC hash, latest reviewed recipient revision, independently checked
   evidence and explicit Owner recipient allowlist. Changes require renewed
   review/binding; a new phone cannot silently inherit a payout destination.

The couple workflow is at `b2c-recipient.html`, linked from Account.
No undocumented Safaricom name/ID API is claimed or invoked. Human identity/name
review uses the merchant's approved evidence process; OTP does not replace it.

## Implemented provider profile and actual evidence

The adapter implements the **historical first-party B2C v1** request profile,
not an asserted current v3 contract. Current account-specific acceptance,
callback and certificate approval still require provider/merchant validation
before enabling the separate live gate. An environment flag is an operator
assertion, not independent proof of those facts.

| First-party pinned source | What it establishes |
| --- | --- |
| [Safaricom Node B2C, `678e3c33b20c1447c209eb88eded89f1bb751e11`](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/b2c.js) | `/mpesa/b2c/v1/paymentrequest`; `InitiatorName`, `SecurityCredential`, `CommandID`, `Amount`, `PartyA`, `PartyB`, `Remarks`, `QueueTimeOutURL`, `ResultURL`, `Occasion`; historical commands `BusinessPayment`, `SalaryPayment`, `PromotionPayment`. Not a particular account's command entitlement. |
| [Node credential helper, same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/helpers/security.js) | RSA PKCS#1 v1.5 public-key encryption, Base64 output. |
| [Node client, same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/m-pesa.js) | Historical production and sandbox API base URLs. Sandbox dispatch is not enabled here. |
| [PHP callback handlers, `5effb808e79ba6b3d8631ef83c2b9b31fa450152`](https://github.com/safaricom/mpesa-php-sdk/blob/5effb808e79ba6b3d8631ef83c2b9b31fa450152/src/TransactionCallbacks.php) | Common `Result` envelope references `ResultCode`, `ResultDesc`, `ConversationID`, `OriginatorConversationID`, `TransactionID`, parameter arrays. B2C/B2B positional labels are inconsistent; not a canonical parameter schema. |
| [Transaction Status request, Node commit above](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/transaction-status.js) | Historical request only. PHP positional labels include `Amount`, `CreditPartyName`, `DebitPartyName`, receipt/status/times; not a current guarantee of exact recipient MSISDN and amount. |
| [Account Balance request, same commit](https://github.com/safaricom/mpesa-node-library/blob/678e3c33b20c1447c209eb88eded89f1bb751e11/src/endpoints/account-balance.js) | Historical request. PHP labels `accountBalance`/`BOCompletedTime` do not establish this merchant's account allocation/funding contract. |

The public [Daraja API catalogue](https://developer.safaricom.co.ke/apis)
rendered successfully. Its actual
[B2C](https://developer.safaricom.co.ke/apis/BusinessToCustomer),
[Transaction Status](https://developer.safaricom.co.ke/apis/TransactionStatus)
and [Account Balance](https://developer.safaricom.co.ke/apis/AccountBalance)
detail routes did not yield detailed public content. Research also inspected
official portal build `0T7Cxv-BCd9_baYHXmnSO`, its `GetApiDocumentation` /
`populateApi` query and Postman-link fields, public GraphQL content reads,
`_next/data`, sitemap and official SDKs. The documentation query returned
`Something went wrong. Please try again later.` The historical archive service
was unavailable during the later research attempt.

Consequently, a current first-party synchronous-acceptance schema, canonical
Result parameter names, concrete QueueTimeOut body, current production
certificate distribution/provenance and same-funds funding route were not
retrieved. These gaps are not disguised as verified documentation.
No historical Rydit runtime proof or successful payout sample is required.

## Dispatch, callbacks and uncertainty

The server validates configuration/certificate, then acquires the shared durable
claim **before OAuth or PaymentRequest**. It uses exact whole KES (never
`int`/rounding), the request's verified destination, configured initiator and
approved shortcode/command. The Node adapter does not import a Django runtime.

A successful HTTP acceptance observation requires code zero plus both
conversation identifiers. This defensive response parser is supporting
integration knowledge, **not an independently verified current first-party
acceptance contract**. Missing/malformed/rejected acceptance is uncertain.
Even conclusively accepted requests are **not paid**.

Each dispatch has a random 256-bit private callback capability; only its
SHA-256 is stored. Keep callback query strings out of application/analytics
logs. Result observations require both provider IDs to match the persisted
acceptance before being classified as correlated. Bodies are size-limited,
hashed and reduced to non-secret identifiers; raw provider payloads, recipient
names, tokens and credentials are not logged or saved.

Early callbacks, unsupported envelopes, mismatches and timeouts are retained as
inconclusive observations without inventing fields. They can only hold money,
never settle or release it. Provider Result parameter position/name text is
not interpreted as identity. No callback parser claims a timeout proves failure.
Duplicate payloads share an event digest; late acceptance cannot clear
uncertainty. The scheduler marks stale executing claims uncertain after
30 minutes and never resends them. Housekeeping and reconciliation continue
after the admission kill switch is OFF.

Final payment requires an independent authenticated reviewer, checked receipt
evidence **and separate reconciliation-kind statement evidence**, bound to the
exact provider account, unique statement/debit line, transaction reference,
destination, amount, fee, currency, transfer time and debit booking time.
The shared immutable receipt and reconciliation are recorded before `paid`;
receipt evidence alone cannot settle. A conflicting correlated success reference
prevents finalization. Mismatched, conflicting, late-terminal or duplicate
statement/receipt evidence commits a shared account hold and returns an explicit
HTTP 409 held result; throwing after the insert must not roll that hold back.
Including that exact paid debit in a subsequent statement
batch uses the shared accounting primitive, never a balance reset.
Transaction Status is not used as recipient/amount proof, and no status query
or balance provider call is implemented. Inconclusive evidence keeps the hold.

An evidence-backed no-transfer proposal retains the hold. A different leader
(not the sender, requester or proposer) must confirm the same independently
checked evidence explicitly proving **no transfer and zero charge** before a
terminal no-transfer decision can release it. Unknown/nonzero fees, existing
receipts or correlated success observations block this path. The original claim
remains permanently nonresendable. Contradictory later evidence is an incident,
not permission to rewrite history or resend. Late provider observations after
terminal no-transfer, or correlated contradictory evidence after payment,
commit an append-only shared account hold using the real callback-journal UUID
and digest. No external evidence is fabricated. Both manual and automatic
eligibility reject that held custody; this release has no incident-release RPC.
Other unresolved uncertain/resolution-proposed requests also quarantine custody
from new reservations/execution until evidenced resolution.

## Deployment configuration names (values never in chat)

All dispatch flags remain false/unset. Configure secrets only in the approved
deployment secret manager, not policy JSON, source control or chat.

| Variable | Purpose |
| --- | --- |
| `WEDDINGSITE_PAYMENT_MODE`, `DARAJA_ENVIRONMENT` | Must explicitly be `live`, `production` for a later authorized deployment. |
| `DARAJA_B2C_ENABLED` | Separate payout kill switch, default false. |
| `DARAJA_B2C_AUTO_APPROVAL_ENABLED` | Optional automatic-approval deployment gate, default false; also requires explicit Owner policy. |
| `DARAJA_B2C_API_VERSION` | Supported implemented profile is `v1`; no v3 fallback. |
| `DARAJA_B2C_CONTRACT_VERIFIED`, `DARAJA_B2C_CAPABILITY_CONFIRMED` | Independent operator confirmations of current account contract and entitlement; default false. |
| `DARAJA_B2C_SHORTCODE`, `DARAJA_B2C_SHORTCODE_CONFIRMED`, `DARAJA_B2C_COMMAND_ID` | Exact approved shortcode/command, matching Owner policy and custody binding. |
| `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET` | Authorized application's OAuth secrets; presence is not entitlement. |
| `DARAJA_B2C_INITIATOR_NAME`, `DARAJA_B2C_INITIATOR_PASSWORD` | Authorized initiator; password is distinct from STK passkey. |
| `DARAJA_B2C_CERTIFICATE_PEM`, `DARAJA_B2C_CERTIFICATE_SHA256` | Current official production X.509 certificate and independently confirmed lowercase SHA-256 fingerprint without colons. RSA >=2048 bits and current validity are checked. No certificate discovery or sandbox fallback. |
| `WEDDINGSITE_PUBLIC_ORIGIN` | Approved HTTPS origin without trailing slash/path/query; callbacks `/api/b2c?action=result` and `action=timeout`. |
| `CRON_SECRET` | Exact scheduler bearer secret. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Existing Supabase configuration. SMS provider/secure phone-change settings are configured directly in Supabase Auth. |

The historical SDK sandbox certificate is expired (2014-11-12 to 2016-11-11),
unusable and never bundled. Certificate filename/fingerprint establishes neither
official provenance nor this merchant's entitlement; obtain the current
production artifact through the authorized channel.

## Operator surfaces

The Owner/SuperAdmin B2C tab includes status, evidence onboarding, independent
review, one-shot dispatch and independent final reconciliation. Owner policy
is readable/editable only by Owner. `/api/b2c` is rewritten into the existing
admin function; it retains its own callback/scheduler/client/staff
authentication. It adds no Vercel function beyond the existing plan limit.
Scheduler checks up to ten candidates, skipping prerequisite holds, and makes
at most one provider attempt each run to stay within its deadline.

Evidence intake (`intake` action, `kind`, `data`) accepts these exact shapes:

| Operation | Metadata |
| --- | --- |
| `evidence` | `{kind:"account"|"commitment"|"statement"|"recipient"|"custody"|"settlement"|"receipt"|"reconciliation"|"no_transfer"|"policy", reference:UUID, sha256:HEX}`; policy evidence submitted by Owner only. |
| `check` | `{evidence:UUID}`; must be a different leader. |
| `recipient` | `{wedding:UUID, evidence:UUID, msisdn:STRING, partner:1|2}`; checked exact partner identity/name/destination/consent evidence, current KYC. Couple then binds that exact confirmed phone separately. |
| `account` | `{account:UUID, registry:UUID, evidence:UUID}`; Owner-only canonical Daraja account registration with checked account-kind evidence. |
| `custody` | `{account:UUID, availableMinor:INTEGER, heldMinor:INTEGER, statementAt:ISO_TIMESTAMP, evidence:UUID, fundingEvidence:UUID, shortcode:STRING, disbursableCollectedFunds:true}`; Owner-only opening envelope of official collected custody that is actually disbursable; available and held are both explicit. |
| `statement` | `{custody:UUID, previous:UUID, statement:UUID, at:ISO_TIMESTAMP, opening:INTEGER, credit:INTEGER, debit:INTEGER, closing:INTEGER, held:INTEGER, evidence:UUID}`; append a checked statement-kind batch to the exact predecessor. |
| `settlement` | `{contribution:UUID, custody:UUID, settledMinor:INTEGER, line:UUID, evidence:UUID, batch:UUID|null, at:ISO_TIMESTAMP}`; Owner-only exact fee-known settled allocation and explicit settlement date; no duplicated statement line/contribution. |
| `source` | `{kind:"payout"|"expense"|"adjustment", source:UUID, custody:UUID, batch:UUID|null, evidence:UUID, line:UUID|null, at:ISO_TIMESTAMP|null}`; checked commitment-kind evidence maps the current historical obligation snapshot; reflected debits require exact batch/line/date. |
| `debit` | `{payout:UUID, batch:UUID, line:UUID, evidence:UUID}`; include the exact independently reconciled paid debit once using checked statement-kind evidence and the shared debit capacity. |
| `funding` | `{custody:UUID, shortcode:STRING, fundingEvidence:UUID}`; append a new independently checked funding/shortcode relationship without creating another balance or credit. |

UUID references identify approved secure-evidence storage, not public URLs.
Digest/reference entries are attestations, not automatic document verification.
Never put documents, names, account credentials or secrets into JSON forms.

## Validation and release boundary

Tests use synthetic data, injected transports and temporary synthetic
certificates only. Isolated SQL tests cover shared reservations, gates,
Owner-only audited policy, two-person default, explicit auto-approval,
destination control, fee/test/Paystack exclusion, idempotency, callback
correlation/duplicates, uncertainty and independent reconciliation.
The populated shared-accounting predecessor exercises a full migration COMMIT,
DDL rollback, preservation of existing financial/core rows and exclusion of
manual requests from automatic adoption. Actual manual/automatic request and
claim wrappers compete over the same account in separate connections.
No provider request is made by tests.

Passing these checks does not certify the live merchant account. Separately
authorize provider validation, production migration/release and eventual
activation only after verifying the current contract, production certificate,
initiator/command, disbursable same collected funds, recipient checks, exact fee
and operating limits. Routine two-person approval may be removed by explicit
Owner automation policy; none of those safeguards is optional.
