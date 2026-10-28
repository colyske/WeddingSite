import { createHmac, timingSafeEqual } from "node:crypto";

const providerHealthCache = new Map();
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

export async function checkProviderHealth(provider) {
  const now = Date.now();
  const cached = providerHealthCache.get(provider);
  if (cached && cached.expiresAt > now) return cached.healthy;

  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const key = provider === "stripe" ? process.env.STRIPE_SECRET_KEY : process.env.PAYSTACK_SECRET_KEY;
  const expectedPrefix = mode === "test" ? "sk_test_" : "";
  if (!key || !expectedPrefix || !key.startsWith(expectedPrefix)) return false;

  const endpoint = provider === "stripe"
    ? "https://api.stripe.com/v1/account"
    : "https://api.paystack.co/integration";
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    const healthy = response.ok && (provider === "stripe" ? Boolean(body.id) : body.status === true);
    providerHealthCache.set(provider, { healthy, expiresAt: now + 30_000 });
    return healthy;
  } catch {
    providerHealthCache.set(provider, { healthy: false, expiresAt: now + 10_000 });
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

export async function verifyProviderPayment(provider, reference, contributionId) {
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const key = provider === "stripe" ? process.env.STRIPE_SECRET_KEY
    : provider === "paystack" ? process.env.PAYSTACK_SECRET_KEY : "";
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
      throw new Error("Provider checkout does not match the WeddingSite payment.");
    }
    if (checkout.payment_status !== "paid") return { verified: false };
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
    throw new Error("Provider transaction does not match the WeddingSite payment.");
  }
  if (transaction.status !== "success") return { verified: false };
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
