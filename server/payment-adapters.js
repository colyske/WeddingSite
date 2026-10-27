import { createHmac, timingSafeEqual } from "node:crypto";

const providerHealthCache = new Map();

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
    providerFeeMinor: Number.isSafeInteger(Number(transaction.fees)) && Number(transaction.fees) >= 0 ? Number(transaction.fees) : null
  };
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
    providerFeeMinor: Number.isSafeInteger(Number(transaction.fees)) && Number(transaction.fees) >= 0 ? Number(transaction.fees) : null
  };
}
