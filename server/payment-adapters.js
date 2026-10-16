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
  const expectedPrefix = mode === "test" ? "sk_test_" : mode === "live" ? "sk_live_" : "";
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
  return { provider: "stripe", eventId: String(event.id), contributionId, amountMinor, currency, reference: String(checkout.id || "") };
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
    reference: String(transaction.reference)
  };
}
