import { randomUUID } from "node:crypto";
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { checkProviderHealth, isSecurePublicOrigin } from "../server/payment-adapters.js";

const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;

const setOf = value => new Set(String(value || "").split(",").map(item => item.trim().toUpperCase()).filter(Boolean));

function configuredAdapters(currency, market) {
  const options = [];
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const stripeModeMatches = mode === "test" ? process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
    : mode === "live" ? process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") : false;
  const paystackModeMatches = mode === "test" ? process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_")
    : mode === "live" ? process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_live_") : false;
  const rules = [
    {
      id: "stripe", name: "Stripe Checkout",
      ready: Boolean(stripeModeMatches && process.env.STRIPE_WEBHOOK_SECRET),
      currencies: setOf(process.env.STRIPE_SUPPORTED_CURRENCIES),
      markets: setOf(process.env.STRIPE_SUPPORTED_MARKETS)
    },
    {
      id: "paystack", name: "Paystack",
      ready: Boolean(paystackModeMatches),
      currencies: setOf(process.env.PAYSTACK_SUPPORTED_CURRENCIES),
      markets: setOf(process.env.PAYSTACK_SUPPORTED_MARKETS)
    }
  ];
  for (const item of rules) {
    if (item.ready && item.currencies.has(currency) && item.markets.has(market)) options.push({ id: item.id, name: item.name });
  }
  return options;
}

export function paymentAdaptersFor(currency, market) {
  return configuredAdapters(currency, market);
}

async function verifyChallenge(token, req, expectedHostname) {
  if (!process.env.TURNSTILE_SECRET_KEY || !token) return false;
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
  if (req.headers["x-forwarded-for"]) body.set("remoteip", String(req.headers["x-forwarded-for"]).split(",")[0].trim());
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, cache: "no-store" });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && result.hostname === expectedHostname;
}

async function createStripeCheckout({ id, weddingId, streamName, amountMinor, currency, origin, idempotencyKey }) {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(amountMinor),
    "line_items[0][price_data][product_data][name]": `Wedding contribution · ${streamName}`,
    "line_items[0][quantity]": "1",
    client_reference_id: id,
    "metadata[contribution_id]": id,
    "metadata[wedding_id]": weddingId,
    success_url: `${origin}/client-site.html?payment=returned`,
    cancel_url: `${origin}/client-site.html?payment=cancelled`
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey
    },
    body: form,
    cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok || !result.url || !result.id) throw new Error("Stripe could not create the hosted checkout session.");
  return { url: result.url, reference: result.id };
}

async function createPaystackCheckout({ id, weddingId, streamName, amountMinor, currency, origin, idempotencyKey, email }) {
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      amount: amountMinor,
      currency,
      reference: idempotencyKey,
      callback_url: `${origin}/client-site.html?payment=returned`,
      metadata: { contribution_id: id, wedding_id: weddingId, stream: streamName }
    }),
    cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok || result.status !== true || !result.data?.authorization_url || !result.data?.reference) {
    throw new Error("Paystack could not initialize the hosted checkout.");
  }
  return { url: result.data.authorization_url, reference: result.data.reference };
}

async function handleOptions(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const weddingId = String(req.query.weddingId || "");
  const market = String(req.query.market || "").toUpperCase();
  const currency = String(req.query.currency || "").toUpperCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(weddingId) ||
      !/^[A-Z0-9_-]{2,12}$/.test(market) || !/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { providers: [], paymentAvailable: false, message: "Select a valid wedding, market, and currency." });
  }
  if (process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED !== "true" ||
      !Boolean(process.env.TURNSTILE_SECRET_KEY) || !isSecurePublicOrigin(process.env.WEDDINGSITE_PUBLIC_ORIGIN)) {
    return sendJson(res, 200, { providers: [], paymentAvailable: false, message: "Payments are not available yet. No payment gateway is enabled." });
  }
  try {
    const [weddings, configs] = await Promise.all([
      supabaseRequest(`/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&published_at=not.is.null&select=id,currency` , { service: true }),
      supabaseRequest(`/rest/v1/payment_provider_configs?wedding_id=eq.${encodeURIComponent(weddingId)}&enabled=eq.true&select=provider,market_codes,currencies`, { service: true })
    ]);
    if (!weddings?.length || weddings[0].currency !== currency) {
      return sendJson(res, 200, { providers: [], paymentAvailable: false, message: "Payments are not available for this wedding or currency." });
    }
    const configured = new Set(configuredAdapters(currency, market).map(item => item.id));
    const eligible = (configs || []).filter(item =>
      configured.has(item.provider) && item.market_codes.includes(market) && item.currencies.includes(currency)
    );
    const health = await Promise.all(eligible.map(async item =>
      [item.provider, await checkProviderHealth(item.provider)]
    ));
    const healthy = new Set(health.filter(([, ready]) => ready).map(([provider]) => provider));
    const providers = eligible.filter(item => healthy.has(item.provider))
      .map(item => ({ id: item.provider, name: item.provider === "stripe" ? "Stripe Checkout" : "Paystack" }));
    return sendJson(res, 200, {
      providers,
      paymentAvailable: providers.length > 0,
      message: providers.length ? "" : "Payments are not available for this wedding and market yet, or a provider health check failed."
    });
  } catch (error) {
    console.error("payment availability check failed", error.message);
    return sendJson(res, 503, { providers: [], paymentAvailable: false, message: "Payment availability could not be verified." });
  }
}

async function handleCheckout(req, res) {
  if (!methodOnly(req, res, "POST")) return;
  if (process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED !== "true") {
    return sendJson(res, 503, { error: "Live payments are disabled. The guest demo remains pledge-only." });
  }
  const origin = process.env.WEDDINGSITE_PUBLIC_ORIGIN?.replace(/\/+$/, "");
  if (!isSecurePublicOrigin(origin)) return sendJson(res, 503, { error: "The public site origin must be a valid HTTPS origin (localhost is allowed for testing)." });
  if (req.headers.origin !== origin) return sendJson(res, 403, { error: "Checkout must be started from the configured WeddingSite origin." });
  const expectedHostname = new URL(origin).hostname;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const weddingId = String(body.weddingId || "");
  const market = String(body.market || "").toUpperCase();
  const currency = String(body.currency || "").toUpperCase();
  const amountMinor = Number(body.amountMinor);
  const idempotencyKey = String(body.idempotencyKey || "");
  if (!isUuid(weddingId) || !/^[A-Z0-9_-]{2,12}$/.test(market) || !/^[A-Z]{3}$/.test(currency) ||
      !Number.isSafeInteger(body.amountMinor) || amountMinor < 1 || !isUuid(idempotencyKey) ||
      !["stripe", "paystack"].includes(body.provider) ||
      !isUuid(body.streamId) || !["name", "anonymous", "hidden"].includes(body.visibility) ||
      (body.visibility === "name" && (!isText(body.displayName, 100) || body.publicConsent !== true)) ||
      (body.visibility === "anonymous" && body.publicConsent !== true) ||
      (body.visibility === "hidden" && body.publicConsent === true) ||
      (body.provider === "paystack" && (typeof body.email !== "string" || body.email.length > 254))) {
    return sendJson(res, 400, { error: "Invalid contribution details or missing privacy consent." });
  }
  try {
    if (!await verifyChallenge(body.captchaToken, req, expectedHostname)) {
      return sendJson(res, 400, { error: "Complete the anti-abuse verification before checkout." });
    }
    const available = configuredAdapters(currency, market).some(item => item.id === body.provider);
    if (!available) return sendJson(res, 409, { error: "That payment option is not configured for this currency and market." });
    if (!await checkProviderHealth(body.provider)) return sendJson(res, 503, { error: "The selected payment provider is not healthy. No checkout was created." });
    const [weddings, configs, streams, policies] = await Promise.all([
      supabaseRequest(`/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&published_at=not.is.null&select=id,currency`, { service: true }),
      supabaseRequest(`/rest/v1/payment_provider_configs?wedding_id=eq.${encodeURIComponent(weddingId)}&provider=eq.${encodeURIComponent(body.provider)}&enabled=eq.true&select=provider,market_codes,currencies`, { service: true }),
      supabaseRequest(`/rest/v1/fundraising_streams?id=eq.${encodeURIComponent(body.streamId)}&wedding_id=eq.${encodeURIComponent(weddingId)}&enabled=eq.true&select=id,name,currency`, { service: true }),
      supabaseRequest("/rest/v1/platform_policies?id=eq.true&select=contribution_fee_basis_points,max_contribution_minor", { service: true })
    ]);
    const config = configs?.[0];
    const stream = streams?.[0];
    const policy = policies?.[0];
    if (!weddings?.[0] || !config || !stream || !policy || weddings[0].currency !== currency ||
        stream.currency !== currency || !config.market_codes.includes(market) || !config.currencies.includes(currency)) {
      return sendJson(res, 409, { error: "This wedding does not have a verified, enabled gateway for the selected market and currency." });
    }
    if (amountMinor > Number(policy.max_contribution_minor)) {
      return sendJson(res, 400, { error: "The selected contribution exceeds the configured per-contribution limit." });
    }
    const contributionId = randomUUID();
    const entry = {
      id: contributionId,
      wedding_id: weddingId,
      stream_name: stream.name,
      pledged_amount_minor: amountMinor,
      paid_amount_minor: 0,
      platform_fee_basis_points: policy.contribution_fee_basis_points,
      platform_fee_minor: 0,
      net_paid_minor: 0,
      currency,
      payment_status: "pledged",
      display_name: body.visibility === "name" ? body.displayName.trim() : "Anonymous guest",
      visibility: "hidden",
      public_consent_at: null,
      provider_name: body.provider,
      checkout_idempotency_key: idempotencyKey
    };
    await supabaseRequest("/rest/v1/contributions", {
      service: true, method: "POST", body: entry, prefer: "return=minimal"
    });
    let checkout;
    try {
      const arguments_ = { id: contributionId, weddingId, streamName: stream.name, amountMinor, currency, origin, idempotencyKey };
      checkout = body.provider === "stripe"
        ? await createStripeCheckout(arguments_)
        : await createPaystackCheckout({ ...arguments_, email: body.email });
      const patch = {
        provider_reference: checkout.reference,
        visibility: body.visibility,
        public_consent_at: body.publicConsent === true ? new Date().toISOString() : null
      };
      await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(contributionId)}`, {
        service: true, method: "PATCH", body: patch, prefer: "return=minimal"
      });
    } catch (error) {
      await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(contributionId)}`, {
        service: true, method: "DELETE", prefer: "return=minimal"
      }).catch(cleanupError => console.error("Failed to remove unstarted pledge", cleanupError.message));
      throw error;
    }
    return sendJson(res, 201, { provider: body.provider, checkoutUrl: checkout.url, paymentStatus: "pledged" });
  } catch (error) {
    console.error("hosted checkout initialization failed", error.message);
    return sendJson(res, error.status || 503, { error: "Checkout was not started. No funds were collected; try again later." });
  }
}

export default async function handler(req, res) {
  const action = String(req.query.action || "create").toLowerCase();
  if (action === "options") return handleOptions(req, res);
  if (action === "create") return handleCheckout(req, res);
  return sendJson(res, 400, { error: "Unknown action." });
}
