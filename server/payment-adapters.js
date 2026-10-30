import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const providerHealthCache = new Map();
let darajaAccessToken = "";
let darajaAccessTokenExpiresAt = 0;
let darajaAccessTokenKey = "";
const DARAJA_SANDBOX = "https://sandbox.safaricom.co.ke";
const DARAJA_PRODUCTION = "https://api.safaricom.co.ke";
const isoFromSeconds = value => {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function isSecurePublicOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch {
    return false;
  }
}

// Live collection stays off unless every explicit switch below is set; the live
// shortcode must be re-confirmed by value so a swapped credential set fails closed.
// Reconciliation environment: where credentials point. Independent of the admission kill
// switch so already-admitted live payments can still be confirmed after a kill/revoke.
export function darajaConfiguredEnvironment() {
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const environment = process.env.DARAJA_ENVIRONMENT;
  if (mode === "test" && environment === "sandbox") return "sandbox";
  if (mode === "live" && environment === "production" &&
      Boolean(process.env.DARAJA_SHORTCODE) &&
      process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED === process.env.DARAJA_SHORTCODE) return "production";
  return null;
}

// Admission environment: new payments need the explicit kill switch on as well.
export function darajaEnvironment() {
  const configured = darajaConfiguredEnvironment();
  if (configured === "production" && process.env.DARAJA_LIVE_COLLECTION_ENABLED !== "true") return null;
  return configured;
}

const darajaBaseUrl = () => darajaConfiguredEnvironment() === "production" ? DARAJA_PRODUCTION : DARAJA_SANDBOX;

function darajaCredentialsReady() {
  return darajaConfiguredEnvironment() !== null &&
    Boolean(process.env.DARAJA_CONSUMER_KEY) &&
    Boolean(process.env.DARAJA_CONSUMER_SECRET) &&
    /^\d{5,7}$/.test(String(process.env.DARAJA_SHORTCODE || "")) &&
    Boolean(process.env.DARAJA_PASSKEY) &&
    isSecurePublicOrigin(process.env.WEDDINGSITE_PUBLIC_ORIGIN);
}

export function darajaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}`;
}

export function darajaPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function getDarajaAccessToken() {
  if (!darajaCredentialsReady()) throw new Error("Daraja sandbox credentials are not fully configured.");
  const cacheKey = createHash("sha256")
    .update(`${darajaConfiguredEnvironment()}:${process.env.DARAJA_SHORTCODE}:${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`)
    .digest("hex");
  if (darajaAccessTokenKey === cacheKey && darajaAccessToken &&
      darajaAccessTokenExpiresAt > Date.now() + 30_000) return darajaAccessToken;
  const authorization = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");
  const response = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${authorization}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  const expiresIn = Number(result.expires_in);
  if (!response.ok || typeof result.access_token !== "string" ||
      !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Daraja sandbox could not issue an access token.");
  }
  darajaAccessToken = result.access_token;
  darajaAccessTokenKey = cacheKey;
  darajaAccessTokenExpiresAt = Date.now() + expiresIn * 1000;
  return darajaAccessToken;
}

export async function initiateDarajaStkPush({
  amountMinor, phoneNumber, callbackUrl, accountReference, description
}) {
  const amount = Number(amountMinor) / 100;
  const shortcode = process.env.DARAJA_SHORTCODE;
  if (darajaEnvironment() === null || !darajaCredentialsReady() || !Number.isSafeInteger(amount) || amount < 1 ||
      !/^254[17]\d{8}$/.test(String(phoneNumber || "")) ||
      !/^[A-Za-z0-9_-]{1,12}$/.test(String(accountReference || ""))) {
    throw new Error("Daraja sandbox checkout details are invalid.");
  }
  const callback = new URL(callbackUrl);
  if (!isSecurePublicOrigin(callback.origin) ||
      callback.origin !== process.env.WEDDINGSITE_PUBLIC_ORIGIN ||
      callback.protocol !== "https:" ||
      callback.pathname !== "/api/webhooks" ||
      callback.searchParams.get("provider") !== "daraja") {
    throw new Error("Daraja callback URL is not the configured secure Join Our Wedding endpoint.");
  }
  const timestamp = darajaTimestamp();
  const token = await getDarajaAccessToken();
  // After the request leaves, any failure to read a definite answer is "uncertain": the
  // customer may already hold a prompt, so callers must not retry or erase the admission.
  const uncertain = message => Object.assign(new Error(message), { uncertain: true });
  let response;
  let result;
  try {
    response = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: darajaPassword(shortcode, process.env.DARAJA_PASSKEY, timestamp),
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: shortcode,
      PhoneNumber: phoneNumber,
      CallBackURL: callback.toString(),
      AccountReference: accountReference,
      TransactionDesc: String(description || "Wedding payment").slice(0, 20)
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000)
    });
    result = await response.json();
  } catch {
    throw uncertain("Daraja STK Push outcome is uncertain.");
  }
  if (response.status >= 500) throw uncertain("Daraja STK Push outcome is uncertain.");
  // Only an explicit non-zero ResponseCode is a definite decline; absence of evidence is uncertain.
  const code = result && typeof result === "object" ? result.ResponseCode : undefined;
  if (code !== undefined && code !== null && String(code) !== "0") {
    throw Object.assign(new Error("Daraja did not accept the STK Push request."), { rejected: true });
  }
  if (!response.ok && (code === undefined || code === null)) throw uncertain("Daraja STK Push outcome is uncertain.");
  if (String(code) !== "0") throw uncertain("Daraja STK Push outcome is uncertain.");
  if (typeof result.CheckoutRequestID !== "string" || !result.CheckoutRequestID ||
      typeof result.MerchantRequestID !== "string" || !result.MerchantRequestID) {
    throw uncertain("Daraja STK Push outcome is uncertain.");
  }
  return {
    reference: result.CheckoutRequestID,
    merchantRequestId: result.MerchantRequestID
  };
}

export async function checkProviderHealth(provider) {
  const now = Date.now();
  const cacheKey = provider === "daraja"
    ? `daraja:${createHash("sha256").update([
      process.env.WEDDINGSITE_PAYMENT_MODE, process.env.DARAJA_ENVIRONMENT,
      process.env.DARAJA_CONSUMER_KEY, process.env.DARAJA_CONSUMER_SECRET,
      process.env.DARAJA_SHORTCODE, process.env.DARAJA_PASSKEY,
      process.env.DARAJA_LIVE_COLLECTION_ENABLED, process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED,
      process.env.WEDDINGSITE_PUBLIC_ORIGIN
    ].join(":")).digest("hex")}`
    : provider;
  const cached = providerHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.healthy;

  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  if (provider === "daraja") {
    if (!darajaCredentialsReady()) return false;
    try {
      await getDarajaAccessToken();
      providerHealthCache.set(cacheKey, { healthy: true, expiresAt: now + 30_000 });
      return true;
    } catch {
      providerHealthCache.set(cacheKey, { healthy: false, expiresAt: now + 10_000 });
      return false;
    }
  }
  const key = provider === "stripe" ? process.env.STRIPE_SECRET_KEY : process.env.PAYSTACK_SECRET_KEY;
  const expectedPrefix = mode === "test" ? "sk_test_" : "";
  if (!key || !expectedPrefix || !key.startsWith(expectedPrefix)) return false;

  const endpoint = provider === "stripe"
    ? "https://api.stripe.com/v1/account"
    : "https://api.paystack.co/integration/payment_session_timeout";
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    const healthy = response.ok && (provider === "stripe" ? Boolean(body.id) : body.status === true);
    providerHealthCache.set(cacheKey, { healthy, expiresAt: now + 30_000 });
    return healthy;
  } catch {
    providerHealthCache.set(cacheKey, { healthy: false, expiresAt: now + 10_000 });
    return false;
  }
}

function signatureValues(header, key) {
  return String(header || "").split(",")
    .map(part => part.trim().split("=", 2))
    .filter(([name, value]) => name === key && value)
    .map(([, value]) => value);
}

function safeEqualHex(actualHex, expectedBuffer) {
  if (!/^[a-f0-9]+$/i.test(actualHex || "")) return false;
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function verifyStripeSignature(raw, header, secret, nowSeconds = Date.now() / 1000) {
  const timestamp = signatureValues(header, "t")[0];
  const time = Number(timestamp);
  if (!Number.isInteger(time) || Math.abs(nowSeconds - time) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest();
  return signatureValues(header, "v1").some(value => safeEqualHex(value, expected));
}

export function verifyPaystackSignature(raw, signature, secret) {
  if (!/^[a-f0-9]{128}$/i.test(String(signature || ""))) return false;
  const expected = createHmac("sha512", secret).update(raw).digest();
  return safeEqualHex(signature, expected);
}

export function normalizeStripePayment(event) {
  if (event?.type !== "checkout.session.completed" || event.data?.object?.payment_status !== "paid" ||
      event.data?.object?.mode !== "payment") return null;
  const checkout = event.data.object;
  const amountMinor = Number(checkout.amount_total);
  const contributionId = checkout.client_reference_id || checkout.metadata?.contribution_id;
  const currency = String(checkout.currency || "").toUpperCase();
  if (!event.id || !contributionId || !Number.isSafeInteger(amountMinor) || amountMinor < 1 || !/^[A-Z]{3}$/.test(currency)) return null;
  const fee = checkout.payment_intent?.latest_charge?.balance_transaction?.fee;
  return {
    provider: "stripe", eventId: String(event.id), contributionId, amountMinor, currency,
    reference: String(checkout.id || ""),
    providerPaymentReference: typeof checkout.payment_intent === "string" ? checkout.payment_intent
      : checkout.payment_intent?.id || null,
    providerPaidAt: isoFromSeconds(event.created),
    providerFeeMinor: Number.isSafeInteger(Number(fee)) && Number(fee) >= 0 ? Number(fee) : null
  };
}

export function normalizePaystackPayment(event) {
  if (event?.event !== "charge.success" || event.data?.status !== "success") return null;
  const transaction = event.data;
  const amountMinor = Number(transaction.amount);
  const contributionId = transaction.metadata?.contribution_id;
  const currency = String(transaction.currency || "").toUpperCase();
  if (!transaction.reference || !contributionId || !Number.isSafeInteger(amountMinor) || amountMinor < 1 || !/^[A-Z]{3}$/.test(currency)) return null;
  return {
    provider: "paystack",
    eventId: String(transaction.id || transaction.reference),
    contributionId,
    amountMinor,
    currency,
    reference: String(transaction.reference),
    providerPaymentReference: String(transaction.id || transaction.reference),
    providerPaidAt: typeof transaction.paid_at === "string" && Number.isFinite(Date.parse(transaction.paid_at))
      ? new Date(transaction.paid_at).toISOString() : null,
    providerFeeMinor: Number.isSafeInteger(Number(transaction.fees)) && Number(transaction.fees) >= 0 ? Number(transaction.fees) : null
  };
}

const isoFromDate = value => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

function providerAdjustment(provider, eventId, eventType, adjustment, paymentReference, state, occurredAt) {
  const amountMinor = Number(adjustment?.amount);
  const currency = String(adjustment?.currency || "").toUpperCase();
  const adjustmentId = adjustment?.id || adjustment?.refund_reference || adjustment?.dispute_reference;
  if (!eventId || !eventType || !Number.isSafeInteger(amountMinor) || amountMinor < 1 ||
      !/^[A-Z]{3}$/.test(currency) || !adjustmentId) return null;
  return {
    provider, eventId: String(eventId), eventType: String(eventType),
    adjustmentId: String(adjustmentId), paymentReference: paymentReference ? String(paymentReference) : null,
    amountMinor, currency, state, occurredAt
  };
}

export function normalizeStripeAdjustment(event) {
  const obj = event?.data?.object;
  if (!obj || !event.id) return null;
  if (["refund.created", "refund.updated", "charge.refund.updated", "charge.refunded"].includes(event.type)) {
    const chargeRefunds = event.type === "charge.refunded" ? obj.refunds?.data : null;
    const refund = Array.isArray(chargeRefunds) && chargeRefunds.length === 1 ? chargeRefunds[0] : obj;
    const refundAmount = event.type === "charge.refunded" && refund === obj ? obj.amount_refunded : refund.amount;
    const state = ({
      succeeded: "refund_processed",
      pending: "refund_pending",
      failed: "refund_failed",
      canceled: "refund_failed"
    })[refund.status] || "review";
    const normalized = { ...refund, amount: refundAmount, currency: refund.currency || obj.currency };
    const reference = typeof obj.payment_intent === "string" ? obj.payment_intent
      : obj.payment_intent?.id || (typeof (refund.charge || obj.charge || obj.id) === "string"
        ? refund.charge || obj.charge || obj.id : (refund.charge || obj.charge)?.id);
    const safeState = event.type === "charge.refunded" && (!Array.isArray(chargeRefunds) || chargeRefunds.length !== 1)
      ? "review" : state;
    return providerAdjustment("stripe", event.id, event.type, normalized, reference, safeState, isoFromSeconds(event.created));
  }
  if (event.type?.startsWith("charge.dispute.")) {
    const state = ({
      "charge.dispute.created": "dispute_open",
      "charge.dispute.funds_withdrawn": "dispute_withdrawn",
      "charge.dispute.funds_reinstated": "dispute_reinstated",
      "charge.dispute.closed": obj.status === "lost" ? "dispute_lost" :
        ["won", "warning_closed"].includes(obj.status) ? "dispute_won" : "review"
    })[event.type] || "review";
    const reference = typeof obj.payment_intent === "string" ? obj.payment_intent
      : obj.payment_intent?.id || (typeof obj.charge === "string" ? obj.charge : obj.charge?.id);
    return providerAdjustment("stripe", event.id, event.type, obj, reference, state, isoFromSeconds(event.created));
  }
  return null;
}

export function normalizePaystackAdjustment(event, eventDigest) {
  const data = event?.data;
  if (!data) return null;
  const eventType = String(event.event || "");
  const occurredAt = isoFromDate(data.createdAt || data.created_at || event.createdAt || event.created_at);
  const adjustment = data.refund || data;
  if (eventType.startsWith("refund.")) {
    const mappedState = ({
      "refund.pending": "refund_pending",
      "refund.processing": "refund_pending",
      "refund.processed": "refund_processed",
      "refund.failed": "refund_failed",
      "refund.needs-attention": "review"
    })[eventType] || "review";
    const stableId = adjustment.refund_reference || adjustment.id;
    const state = stableId ? mappedState : "review";
    const id = stableId || eventDigest;
    return providerAdjustment(
      "paystack", eventDigest, eventType, { ...adjustment, id },
      adjustment.transaction_reference || adjustment.transaction?.reference, state, occurredAt
    );
  }
  if (eventType.startsWith("charge.dispute.")) {
    const status = String(data.status || data.resolution || "").toLowerCase();
    const mappedState = eventType.endsWith(".create") || eventType.endsWith(".remind") ? "dispute_open"
      : eventType.endsWith(".resolve") && ["won", "merchant_won", "reversed"].includes(status) ? "dispute_reinstated"
        : eventType.endsWith(".resolve") && ["lost", "merchant_lost", "accepted"].includes(status) ? "dispute_lost"
          : "review";
    const stableId = data.dispute_reference || data.id;
    const state = stableId ? mappedState : "review";
    const id = stableId || eventDigest;
    const paymentReference = data.transaction_reference || data.transaction?.reference;
    return providerAdjustment(
      "paystack", eventDigest, eventType, { ...data, id, amount: data.amount || data.transaction?.amount,
        currency: data.currency || data.transaction?.currency },
      paymentReference, state, occurredAt
    );
  }
  return null;
}

export async function verifyProviderPayment(provider, reference, contributionId, expectedAmountMinor, expectedCurrency, bound = null) {
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const key = provider === "stripe" ? process.env.STRIPE_SECRET_KEY
    : provider === "paystack" ? process.env.PAYSTACK_SECRET_KEY : "";
  if (provider === "daraja") {
    if (!darajaCredentialsReady() || !reference || !contributionId ||
        !Number.isSafeInteger(Number(expectedAmountMinor)) || Number(expectedAmountMinor) < 100 ||
        Number(expectedAmountMinor) % 100 !== 0 || String(expectedCurrency).toUpperCase() !== "KES") {
      throw new Error("Daraja payment verification is not configured.");
    }
    // A payment is only ever queried in the environment and merchant it was created in.
    const live = bound?.environment === "live";
    if (darajaConfiguredEnvironment() !== (live ? "production" : "sandbox")) {
      throw new Error("Daraja payment belongs to a different environment; it was not queried.");
    }
    if (live && (!bound.merchantRequestId || String(bound.shortcode || "") !== String(process.env.DARAJA_SHORTCODE))) {
      throw new Error("Live Daraja payment is missing its bound merchant context; it was not queried.");
    }
    const shortcode = process.env.DARAJA_SHORTCODE;
    const timestamp = darajaTimestamp();
    const token = await getDarajaAccessToken();
    const response = await fetch(`${darajaBaseUrl()}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: darajaPassword(shortcode, process.env.DARAJA_PASSKEY, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: reference
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json();
    if (!response.ok || String(result.CheckoutRequestID || "") !== String(reference) ||
        (live && String(result.MerchantRequestID || "") !== String(bound.merchantRequestId))) {
      throw new Error("Daraja could not verify this STK Push request.");
    }
    if (String(result.ResponseCode) !== "0" || result.ResultCode === undefined || result.ResultCode === null) {
      return { verified: false };
    }
    if (String(result.ResultCode) !== "0") {
      const code = String(result.ResultCode);
      return { verified: false, terminal: true, resultCode: /^\d{1,6}$/.test(code) ? code : null };
    }
    return {
      verified: true,
      provider: "daraja",
      eventId: `stk-query:${reference}`,
      amountMinor: Number(expectedAmountMinor),
      currency: "KES",
      reference: String(reference),
      providerPaymentReference: String(reference),
      providerPaidAt: null,
      providerFeeMinor: null
    };
  }
  if (mode !== "test" || !key?.startsWith("sk_test_") || !reference || !contributionId) {
    throw new Error("A test-mode payment provider is not configured.");
  }
  const endpoint = provider === "stripe"
    ? `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}?expand%5B%5D=payment_intent.latest_charge.balance_transaction`
    : provider === "paystack"
      ? `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`
      : null;
  if (!endpoint) throw new Error("Unsupported payment provider.");
  const response = await fetch(endpoint, {
    headers: { Authorization: "Bearer " + key },
    cache: "no-store",
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error("The payment provider could not verify this checkout.");

  if (provider === "stripe") {
    const checkout = result;
    if (checkout.metadata?.contribution_id !== contributionId || checkout.client_reference_id !== contributionId) {
      throw new Error("Provider checkout does not match the Join Our Wedding payment.");
    }
    if (checkout.payment_status !== "paid") return { verified: false, ...(checkout.status === "expired" ? { terminal: true } : {}) };
    const amountMinor = Number(checkout.amount_total);
    const currency = String(checkout.currency || "").toUpperCase();
    const fee = checkout.payment_intent?.latest_charge?.balance_transaction?.fee;
    if (!Number.isSafeInteger(amountMinor) || !/^[A-Z]{3}$/.test(currency)) throw new Error("Provider returned invalid payment details.");
    return {
      verified: true, provider, eventId: `verified:${checkout.id}`,
      amountMinor, currency, reference: String(checkout.id),
      providerPaymentReference: typeof checkout.payment_intent === "string" ? checkout.payment_intent
        : checkout.payment_intent?.id || null,
      providerPaidAt: isoFromSeconds(checkout.payment_intent?.latest_charge?.created),
      providerFeeMinor: Number.isSafeInteger(Number(fee)) && Number(fee) >= 0 ? Number(fee) : null
    };
  }

  const transaction = result.data;
  if (result.status !== true || transaction?.metadata?.contribution_id !== contributionId ||
      String(transaction.reference) !== String(reference)) {
    throw new Error("Provider transaction does not match the Join Our Wedding payment.");
  }
  if (transaction.status !== "success") return { verified: false, ...(["failed", "reversed"].includes(transaction.status) ? { terminal: true } : {}) };
  const amountMinor = Number(transaction.amount);
  const currency = String(transaction.currency || "").toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || !/^[A-Z]{3}$/.test(currency)) throw new Error("Provider returned invalid payment details.");
  return {
    verified: true, provider, eventId: `verified:${transaction.id || transaction.reference}`,
    amountMinor, currency, reference: String(transaction.reference),
    providerPaymentReference: String(transaction.id || transaction.reference),
    providerPaidAt: typeof transaction.paid_at === "string" && Number.isFinite(Date.parse(transaction.paid_at))
      ? new Date(transaction.paid_at).toISOString() : null,
    providerFeeMinor: Number.isSafeInteger(Number(transaction.fees)) && Number(transaction.fees) >= 0 ? Number(transaction.fees) : null
  };
}
