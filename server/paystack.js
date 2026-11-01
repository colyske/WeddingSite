import { createHash } from "node:crypto";
import { supabaseRequest } from "./supabase.js";
import jsonBigint from "json-bigint";

// Paystack transaction IDs are unsigned 64-bit values, not JS-safe numbers.
export const parsePaystackJson = jsonBigint({ storeAsString: true, strict: true }).parse;

const digest = value => createHash("sha256").update(value).digest("hex");
const rpc = (name, body, token) => supabaseRequest(`/rest/v1/rpc/${name}`, {
  ...(token ? { token } : { service: true }), method: "POST", body
});
const codePattern = /^ACCT_[A-Za-z0-9]+$/;

export function paystackSettlementMode(context) {
  if (context?.kind !== "guest") throw new Error("A guest settlement context is required.");
  if (["standard","split"].includes(context.settlement_mode)) return context.settlement_mode;
  throw new Error("Paystack settlement mode is missing or unsupported.");
}

// Configuration is independent of admission switches: revocation must not strand payments.
export function paystackEnvironment() {
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const key = process.env.PAYSTACK_SECRET_KEY;
  return ["test", "live"].includes(mode) && key?.startsWith(`sk_${mode}_`) ? mode : null;
}

export function paystackMerchant() {
  const id = process.env.PAYSTACK_MERCHANT_ID;
  return /^[1-9]\d{0,15}$/.test(id || "") && Number.isSafeInteger(Number(id)) ? id : null;
}

export function paystackCredentialFingerprint() {
  return paystackEnvironment() && paystackMerchant()
    ? digest(`${paystackEnvironment()}:${paystackMerchant()}:${process.env.PAYSTACK_SECRET_KEY}`) : null;
}

export function paystackAdmissionEnabled(kind = "guest") {
  return paystackEnvironment() === "live" && Boolean(paystackCredentialFingerprint()) &&
    process.env.PAYSTACK_LIVE_MERCHANT_CONFIRMED === paystackMerchant() &&
    process.env.PAYSTACK_LIVE_COLLECTION_ENABLED === "true" &&
    process.env.PAYSTACK_RECONCILIATION_ENABLED === "true" &&
    (kind !== "publication" || process.env.PAYSTACK_LIVE_PUBLICATION_ENABLED === "true");
}

export function contextDigest(context) {
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
  return digest(JSON.stringify(canonical(context)));
}

export async function paystackApproval(kind = "guest", currency = null, market = null) {
  if (!paystackAdmissionEnabled(kind)) return null;
  const row = (await supabaseRequest("/rest/v1/paystack_live_policy?singleton=eq.true&select=*", { service: true }))?.[0];
  if (!row?.approved || row.merchant_id !== paystackMerchant() ||
      row.credential_fingerprint !== paystackCredentialFingerprint() ||
      (kind === "publication" && !row.publication_enabled) ||
      (kind === "guest" && !(row.settlement_mode === "standard" ? row.standard_enabled :
        row.settlement_mode === "split" && row.split_enabled && row.split_contract_ready &&
          process.env.PAYSTACK_LIVE_SPLIT_ENABLED === "true")) ||
      (currency && !row.capabilities?.some(pair => pair.currency === currency && (!market || pair.market === market)))) return null;
  return row;
}

export async function paystackDestination(weddingId, currency) {
  return (await supabaseRequest(`/rest/v1/paystack_destinations?wedding_id=eq.${weddingId}&currency=eq.${currency}&select=*`, { service: true }))?.[0] || null;
}

export async function fetchPaystack(path) {
  if (!paystackEnvironment()) throw new Error("Paystack credentials and mode do not match.");
  const response = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    cache: "no-store", signal: AbortSignal.timeout(8000)
  });
  const body = parsePaystackJson(await response.text());
  if (!response.ok || body.status !== true) throw new Error("Paystack read-only verification failed.");
  return body;
}

// Bank/account fields are used only for a one-way change detector, never returned or stored.
export async function verifiedSubaccount(code, currency) {
  if (!codePattern.test(code || "") || !paystackMerchant()) throw new Error("A valid Paystack merchant and destination are required.");
  const { data } = await fetchPaystack(`/subaccount/${encodeURIComponent(code)}`);
  if (data?.subaccount_code !== code || data.domain !== paystackEnvironment() ||
      String(data.integration) !== paystackMerchant() || data.currency !== currency ||
      data.active !== true || data.is_verified !== true || data.product !== "collection" ||
      !data.account_number || !data.settlement_bank || !data.updatedAt ||
      !Number.isSafeInteger(Number(data.id)) || Number(data.id) < 1) {
    throw new Error("Paystack destination is unsupported, inactive, unverified, or belongs to another merchant/mode/currency.");
  }
  return {
    subaccount_code: code, subaccount_id: String(data.id),
    destination_fingerprint: digest(JSON.stringify([data.account_number, data.settlement_bank, data.account_name, data.updatedAt])),
    merchant_id: paystackMerchant(), environment: paystackEnvironment(), currency,
    credential_fingerprint: paystackCredentialFingerprint()
  };
}

export async function livePaystackContext(weddingId, amountMinor, currency, market) {
  const approval = await paystackApproval("guest", currency, market);
  if (!approval) throw new Error("The selected live Paystack settlement mode is held.");
  if (approval.settlement_mode === "split") {
    const destination = await paystackDestination(weddingId, currency);
    if (!destination?.verified_at || !destination.consent_at) throw new Error("Complete Paystack payout onboarding and destination consent before accepting direct-settlement payments.");
    const verified = await verifiedSubaccount(destination.subaccount_code, currency);
    if (verified.destination_fingerprint !== destination.destination_fingerprint ||
        verified.credential_fingerprint !== destination.credential_fingerprint) {
      throw new Error("Paystack payout destination changed. Owner re-verification and couple consent are required.");
    }
  }
  const context = await rpc("paystack_contribution_quote", {
    p_wedding_id: weddingId, p_amount_minor: amountMinor, p_currency: currency, p_market: market
  });
  if (context.policy_revision !== approval.revision || context.settlement_mode !== approval.settlement_mode) {
    throw new Error("Paystack mode changed while preparing checkout. Reload; no fallback was applied.");
  }
  return context;
}

export function paystackSplit(context, reference) {
  if (paystackSettlementMode(context) !== "split" || context.settlement_route !== "paystack_direct" ||
      !["account","subaccount"].includes(context.fee_bearer) || !codePattern.test(context.subaccount_code || "")) {
    throw new Error("An admitted direct-settlement context is required for a split payload.");
  }
  return {
    type: "flat", bearer_type: context.fee_bearer,
    ...(context.fee_bearer === "subaccount" ? { bearer_subaccount: context.subaccount_code } : {}),
    reference,
    subaccounts: [{ subaccount: context.subaccount_code, share: context.amount_minor - context.platform_fee_minor }]
  };
}

export async function validatePaystackInitialization(context) {
  const approval = await paystackApproval(context.kind, context.currency, context.market);
  const policy = (await supabaseRequest("/rest/v1/platform_policies?id=eq.true&select=enabled_payment_providers", { service: true }))?.[0];
  if (!approval || approval.revision !== context.policy_revision || !policy?.enabled_payment_providers?.includes("paystack") ||
      context.credential_fingerprint !== paystackCredentialFingerprint() || context.merchant_id !== paystackMerchant() ||
      (context.kind === "guest" && approval.settlement_mode !== paystackSettlementMode(context))) {
    throw new Error("Paystack approval or controls changed before initialization; payment remains held.");
  }
  if (context.kind === "guest" && paystackSettlementMode(context) === "split") {
    const destination = await paystackDestination(context.wedding_id, context.currency);
    if (!destination?.consent_at || destination.revision !== context.destination_revision) {
      throw new Error("Paystack destination changed before initialization; payment remains held.");
    }
  }
}

export function verifyPaystackContext(transaction, context, signedSplit = null) {
  if (!["guest","publication"].includes(context?.kind)) throw new Error("Unsupported Paystack payment context.");
  if (context.environment !== paystackEnvironment() || context.merchant_id !== paystackMerchant() ||
      context.credential_fingerprint !== paystackCredentialFingerprint() ||
      transaction.domain !== context.environment || transaction.currency !== context.currency ||
      transaction.amount !== context.amount_minor ||
      (transaction.integration != null && String(transaction.integration) !== context.merchant_id) ||
      transaction.metadata?.ws_context !== contextDigest(context)) {
    throw new Error("Paystack payment does not match its immutable merchant, mode, amount, currency or quote.");
  }
  const standard = context.kind === "guest" && paystackSettlementMode(context) === "standard";
  if (context.kind === "publication" || standard) {
    if (!Number.isSafeInteger(transaction.fees) || transaction.fees < 0 || transaction.fees > context.amount_minor) {
      throw new Error("Platform-collected provider fee evidence is missing or invalid.");
    }
    const absentOrEmpty = value => value == null ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    if (![transaction.subaccount,transaction.split,transaction.fees_split,signedSplit].every(absentOrEmpty)) {
      throw new Error("Platform-collected payment must not contain a split or subaccount.");
    }
    if (standard) {
      const couple = context.amount_minor - context.platform_fee_minor - transaction.fees;
      if (!Number.isSafeInteger(couple) || couple < 0 || context.fee_bearer !== "couple_wallet" ||
          context.settlement_route !== "platform_wallet") throw new Error("Standard Paystack fee allocation is invalid.");
      return { couple_minor: couple, platform_minor: context.platform_fee_minor, provider_fee_minor: transaction.fees };
    }
    return null;
  }
  if (paystackSettlementMode(context) !== "split" || context.settlement_route !== "paystack_direct" ||
      !["account","subaccount"].includes(context.fee_bearer)) throw new Error("Split Paystack routing context is invalid.");
  // Paystack documents formula/shares in signed charge.success. Verification may
  // omit these; missing evidence stays pending, never inferred from metadata.
  const split = transaction.split?.shares ? transaction.split : signedSplit;
  const formula = split?.formula;
  const shares = split?.shares;
  const expectedGross = context.amount_minor - context.platform_fee_minor;
  const sub = shares?.subaccounts?.[0];
  const fee = transaction.fees;
  const expectedCouple = expectedGross - (context.fee_bearer === "subaccount" ? fee : 0);
  const expectedPlatform = context.platform_fee_minor - (context.fee_bearer === "account" ? fee : 0);
  if (formula?.type !== "flat" || String(formula.integration) !== context.merchant_id ||
      formula.subaccounts?.length !== 1 || formula.subaccounts[0].subaccount_code !== context.subaccount_code ||
      formula.subaccounts[0].share !== expectedGross || shares?.subaccounts?.length !== 1 ||
      sub.subaccount_code !== context.subaccount_code || String(sub.id) !== context.subaccount_id ||
      !Number.isSafeInteger(fee) || fee < 0 || expectedCouple < 0 || expectedPlatform < 0 ||
      sub.amount !== expectedCouple || shares.integration !== expectedPlatform || shares.paystack !== fee ||
      sub.amount + shares.integration + shares.paystack !== context.amount_minor) {
    throw new Error("Paystack split allocation evidence is missing or mismatched; reconciliation is required.");
  }
  return { couple_minor: expectedCouple, platform_minor: expectedPlatform, provider_fee_minor: fee };
}

export async function recordPaystackPayment(payment, contributionId) {
  return rpc("record_verified_paystack_payment", {
    p_contribution_id: contributionId, p_event_id: payment.eventId, p_reference: payment.reference,
    p_amount_minor: payment.amountMinor, p_currency: payment.currency,
    p_fee_minor: payment.providerFeeMinor, p_paid_at: payment.providerPaidAt,
    p_payment_reference: payment.providerPaymentReference, p_allocation: payment.allocation
  });
}

export async function paystackReadiness() {
  const configured = paystackEnvironment();
  let policy = null, providerPolicy = null, approvalUnavailable = false, providerPolicyUnavailable = false;
  try {
    policy = (await supabaseRequest("/rest/v1/paystack_live_policy?singleton=eq.true&select=*", { service: true }))?.[0];
    approvalUnavailable = !policy;
  } catch {
    approvalUnavailable = true;
    console.error("Paystack live approval status could not be read; Paystack is held.");
  }
  try {
    providerPolicy = (await supabaseRequest("/rest/v1/platform_policies?id=eq.true&select=enabled_payment_providers", { service:true }))?.[0];
    providerPolicyUnavailable = !providerPolicy;
  } catch {
    providerPolicyUnavailable = true;
    console.error("Paystack provider controls could not be read; new Paystack collection is held.");
  }
  const approval = configured === "live" && policy?.approved && policy.merchant_id === paystackMerchant() &&
    policy.credential_fingerprint === paystackCredentialFingerprint() ? policy : null;
  const splitReady = Boolean(approval?.split_enabled && approval?.split_contract_ready &&
    process.env.PAYSTACK_LIVE_SPLIT_ENABLED === "true");
  const modeReady = approval?.settlement_mode === "standard" ? approval.standard_enabled : splitReady;
  const providerAllowed = providerPolicy?.enabled_payment_providers?.includes("paystack") === true;
  const reasons = [];
  if (configured !== "live") reasons.push("Matching live Paystack mode/credentials are not configured.");
  if (process.env.PAYSTACK_LIVE_MERCHANT_CONFIRMED !== paystackMerchant() || !paystackMerchant()) reasons.push("Merchant identity is not explicitly confirmed.");
  if (approvalUnavailable) reasons.push("Paystack approval status is unavailable; Paystack is held independently of other providers.");
  else if (!approval) reasons.push("Owner merchant/capability approval is not current.");
  if (!modeReady) reasons.push("The selected guest settlement scope is not approved or ready.");
  if (!providerAllowed) reasons.push(providerPolicyUnavailable ? "Provider controls are unavailable." : "Leadership has not enabled Paystack in the provider allowlist.");
  if (process.env.PAYSTACK_LIVE_COLLECTION_ENABLED !== "true") reasons.push("The live collection switch is OFF.");
  if (process.env.PAYSTACK_RECONCILIATION_ENABLED !== "true") reasons.push("Independent reconciliation is OFF.");
  return {
    environment: configured || "unconfigured", merchantConfigured: Boolean(paystackMerchant()),
    merchantConfirmationMatches: Boolean(paystackMerchant()) && process.env.PAYSTACK_LIVE_MERCHANT_CONFIRMED === paystackMerchant(),
    collectionKillSwitchOn: process.env.PAYSTACK_LIVE_COLLECTION_ENABLED === "true",
    publicationKillSwitchOn: process.env.PAYSTACK_LIVE_PUBLICATION_ENABLED === "true",
    reconciliationEnabled: process.env.PAYSTACK_RECONCILIATION_ENABLED === "true",
    approved: Boolean(approval), approvalUnavailable, splitApproved: Boolean(approval?.split_enabled),
    standardApproved: Boolean(approval?.standard_enabled), settlementMode: policy?.settlement_mode || "standard",
    policyRevision: policy?.revision || null, splitReady,
    splitHoldingReason: splitReady ? "" : "Split allocation/beneficiary statement contract remains unverified; split settlement is unavailable.",
    publicationApproved: Boolean(approval?.publication_enabled),
    reason: reasons.join(" "), providerAllowed, providerPolicyUnavailable,
    newCollection: paystackAdmissionEnabled() && modeReady && providerAllowed ? "gates_open" : "held",
    capabilities: approval?.capabilities || [], feeBearer: approval?.fee_bearer || null,
    settlement: policy?.settlement_mode === "split" ? "Paystack direct; never WeddingSite withdrawable balance" :
      "Platform-collected; existing wallet holds, KYC and payout kill switch apply"
  };
}

export async function reconcilePaystackSettlement(contributionId, settlementId, actorId) {
  if (paystackEnvironment() !== "live" || process.env.PAYSTACK_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Live Paystack reconciliation is held.");
  }
  const row = (await supabaseRequest(`/rest/v1/contributions?id=eq.${contributionId}&select=id,paystack_context,provider_reference,payment_status`, { service: true }))?.[0];
  const context = row?.paystack_context;
  if (!context || paystackSettlementMode(context) !== "split" || row.payment_status !== "paid" || context.environment !== paystackEnvironment() ||
      context.credential_fingerprint !== paystackCredentialFingerprint() || context.merchant_id !== paystackMerchant()) {
    throw new Error("Settlement has no verified payment in this merchant/mode.");
  }
  let settlement = null;
  for (let page = 1; page <= 20; page++) {
    const list = await fetchPaystack(`/settlement?subaccount=${context.subaccount_id}&perPage=100&page=${page}`);
    if (!Array.isArray(list.data) || !Number.isSafeInteger(list.meta?.pageCount)) throw new Error("Settlement pagination is unverified.");
    settlement = list.data.find(item => String(item.id) === settlementId);
    if (settlement || page >= list.meta.pageCount) break;
    if (page === 20) throw new Error("Settlement search exceeds the bounded page limit; narrow the provider statement first.");
  }
  if (!settlement || settlement.domain !== context.environment || String(settlement.integration) !== context.merchant_id ||
      settlement.currency !== context.currency || !["success","pending","processing","failed"].includes(settlement.status)) {
    throw new Error("Provider settlement does not match the bound merchant, destination, mode or currency.");
  }
  let found = false, total = 0;
  for (let page = 1; page <= 20; page++) {
    const result = await fetchPaystack(`/settlement/${settlementId}/transactions?perPage=100&page=${page}`);
    if (!Array.isArray(result.data) || !Number.isSafeInteger(result.meta?.pageCount)) throw new Error("Settlement transaction pagination is unverified.");
    for (const transaction of result.data) {
      if (transaction.domain !== context.environment || transaction.currency !== context.currency || transaction.status !== "success") {
        throw new Error("Settlement contains mismatched transaction evidence.");
      }
      const sub = transaction.split?.shares?.subaccounts?.find(item => item.subaccount_code === context.subaccount_code);
      if (!Number.isSafeInteger(sub?.amount) || sub.amount < 0 || String(sub.id) !== context.subaccount_id) {
        throw new Error("Settlement does not expose verified per-destination allocations; statement review is required.");
      }
      total += sub.amount;
      if (!Number.isSafeInteger(total)) throw new Error("Settlement total exceeds supported precision.");
      if (transaction.reference === row.provider_reference) {
        verifyPaystackContext(transaction, context);
        found = true;
      }
    }
    if (page >= result.meta.pageCount) break;
    if (page === 20) throw new Error("Settlement transactions exceed the bounded page limit.");
  }
  if (!found || settlement.total_amount !== total || settlement.effective_amount !== total ||
      (settlement.deductions !== null && settlement.deductions !== undefined)) {
    throw new Error("Settlement totals or deductions require review; no settled status was recorded.");
  }
  const evidence = (await supabaseRequest(`/rest/v1/paystack_payment_evidence?contribution_id=eq.${contributionId}&select=couple_minor`, { service: true }))?.[0];
  return rpc("record_paystack_settlement", {
    p_contribution_id: contributionId, p_settlement_id: settlementId, p_status: settlement.status,
    p_couple_minor: evidence?.couple_minor, p_currency: context.currency, p_actor_id: actorId
  });
}
