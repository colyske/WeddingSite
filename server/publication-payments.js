import { methodOnly, sendJson, supabaseRequest } from "./supabase.js";
import { platformOrigins } from "./site-hosts.js";
import { normalizePhone } from "./phone.js";
import { checkProviderHealth, initiateDarajaStkPush, verifyProviderPayment, isSecurePublicOrigin } from "./payment-adapters.js";
import { availableProviderMarkets, enabledPaymentProviders, createStripeCheckout, createPaystackCheckout, verifyChallenge } from "../api/checkout.js";
import { publicationQuote, publicationMethodQuote } from "./publication-fx.js";

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const rpc = (name, body, token) => supabaseRequest(`/rest/v1/rpc/${name}`, {
  ...(token ? { token } : { service: true }), method: "POST", body
});
const methodFor = provider => provider === "daraja" ? "mpesa" : "card";
const labelFor = method => method === "mpesa" ? "M-Pesa" : "Card";
const table = "/rest/v1/publication_checkouts";

export async function publicationMethods(currency) {
  const policy = (await supabaseRequest("/rest/v1/platform_policies?id=eq.true&select=enabled_payment_providers", { service: true }))?.[0];
  const enabled = enabledPaymentProviders(policy);
  const candidates = availableProviderMarkets(currency).filter(item => enabled.includes(item.id));
  const healthy = await Promise.all([...new Set(candidates.map(item => item.id))].map(async id => [id, await checkProviderHealth(id)]));
  // Use one configured route for each method; never accept a processor from the client.
  return candidates.filter(item => healthy.some(([id, ready]) => id === item.id && ready))
    .filter((item, index, all) => all.findIndex(other => methodFor(other.id) === methodFor(item.id)) === index);
}

function publicStatus(row) {
  return row ? {
    id: row.id, status: row.status, amountMinor: Number(row.amount_minor), currency: row.currency,
    usdAmountMinor: row.usd_amount_minor == null ? null : Number(row.usd_amount_minor),
    fxRate: row.fx_rate, fxPublishedAt: row.fx_published_at, fxSource: row.fx_source,
    method: methodFor(row.provider), resultCode: row.provider_result_code || null, testMode: true
  } : null;
}

export async function recordPublicationPayment(payment, checkoutId) {
  return rpc("record_verified_publication_payment", {
    p_checkout_id: checkoutId, p_provider: payment.provider, p_reference: payment.reference,
    p_amount_minor: payment.amountMinor, p_currency: payment.currency,
    p_event_id: payment.eventId, p_provider_fee_minor: payment.providerFeeMinor
  });
}

export async function reconcilePublication(row) {
  if (!row || row.status === "paid" || row.status === "failed" || !row.provider_reference) return row;
  const payment = await verifyProviderPayment(row.provider, row.provider_reference, row.id, row.amount_minor, row.currency);
  if (payment.verified) {
    await recordPublicationPayment(payment, row.id);
  } else if (payment.terminal) {
    await supabaseRequest(`${table}?id=eq.${row.id}&status=eq.pending`, {
      service: true, method: "PATCH", prefer: "return=minimal",
      body: { status: "failed", provider_result_code: payment.resultCode || null }
    });
  }
  return (await supabaseRequest(`${table}?id=eq.${row.id}&select=*`, { service: true }))?.[0] || row;
}

// Daraja callbacks remain unsigned hints: always query the exact stored reference.
export async function reconcilePublicationCallback(body) {
  const reference = String(body?.Body?.stkCallback?.CheckoutRequestID || "");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(reference)) throw new Error("Invalid publication callback reference.");
  const row = (await supabaseRequest(`${table}?provider=eq.daraja&provider_reference=eq.${encodeURIComponent(reference)}&select=*`, { service: true }))?.[0];
  if (!row) return false;
  const items = body?.Body?.stkCallback?.CallbackMetadata?.Item;
  const amount = Array.isArray(items) ? items.find(item => item?.Name === "Amount")?.Value : undefined;
  if (amount !== undefined && Math.round(Number(amount) * 100) !== Number(row.amount_minor)) {
    throw new Error("Publication callback amount does not match.");
  }
  return (await reconcilePublication(row)).status === "paid";
}

export async function handlePublicationPayment(req, res, session, action) {
  const creating = action === "publication-create";
  if (!methodOnly(req, res, creating ? "POST" : "GET")) return;
  const body = req.body || {};
  const weddingId = creating ? body.weddingId : req.query.weddingId;
  if (!uuid(weddingId)) return sendJson(res, 400, { error: "Select a valid wedding." });
  try {
    const wedding = (await supabaseRequest(
      `/rest/v1/weddings?id=eq.${weddingId}&client_owner_id=eq.${session.user.id}&select=id,currency,published_at,archived_at`,
      { token: session.token }
    ))?.[0];
    if (!wedding) return sendJson(res, 404, { error: "Wedding not found." });
    if (action === "publication-status") {
      if (!uuid(req.query.id)) return sendJson(res, 400, { error: "Invalid publication payment reference." });
      const row = (await supabaseRequest(`${table}?id=eq.${req.query.id}&wedding_id=eq.${weddingId}&client_id=eq.${session.user.id}&select=*`, { service: true }))?.[0];
      if (!row) return sendJson(res, 404, { error: "Publication payment not found." });
      return sendJson(res, 200, { checkout: publicStatus(await reconcilePublication(row)) });
    }
    const active = (await supabaseRequest(`${table}?wedding_id=eq.${weddingId}&client_id=eq.${session.user.id}&status=in.(pending,review)&select=*&limit=1`, { service: true }))?.[0];
    if (active) return sendJson(res, 200, { quote: null, checkout: publicStatus(active), methods: [], testMode: true,
      message: "An existing publication payment must be resolved before another can start." });
    const quote = await publicationQuote(weddingId, session.token, wedding.currency);
    if (!creating) {
      const configured = process.env.WEDDINGSITE_PAYMENT_MODE === "test" && Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
      const methods = configured && !wedding.published_at && !wedding.archived_at && Number(quote.fee_minor) > 0
        ? await publicationMethods(wedding.currency) : [];
      return sendJson(res, 200, {
        quote, checkout: null, testMode: true,
        methods: methods.map(item => ({ id: methodFor(item.id), label: labelFor(methodFor(item.id)),
          quote: publicationMethodQuote(quote, item.id) })),
        turnstileSiteKey: configured ? process.env.TURNSTILE_SITE_KEY : null
      });
    }
    const origin = String(req.headers.origin || "");
    if (!isSecurePublicOrigin(origin) || !platformOrigins().includes(origin)) {
      return sendJson(res, 403, { error: "Start publication checkout from the platform editor." });
    }
    if (process.env.WEDDINGSITE_PAYMENT_MODE !== "test") return sendJson(res, 503, { error: "Only test-mode publication checkout is supported." });
    if (!uuid(body.idempotencyKey) || body.confirmed !== true || !["card", "mpesa"].includes(body.method) ||
        !Number.isSafeInteger(body.expectedAmountMinor) || body.expectedAmountMinor < 1 ||
        body.expectedCurrency !== quote.currency) {
      return sendJson(res, 409, { error: "Confirm the current publication quote before paying; reload if it changed." });
    }
    const selected = (await publicationMethods(wedding.currency)).find(item => methodFor(item.id) === body.method);
    if (!selected) return sendJson(res, 409, { error: "That payment method is disabled or unavailable. Reload the current options." });
    const payableQuote = publicationMethodQuote(quote, selected.id);
    if (body.expectedAmountMinor !== Number(payableQuote.fee_minor) ||
        body.expectedUsdAmountMinor !== Number(quote.usd_amount_minor) ||
        (body.expectedFxId || null) !== (quote.fx_snapshot_id || null)) {
      return sendJson(res, 409, { error: "Publication quote changed. Reload the current fee and exchange rate before paying." });
    }
    const email = String(body.email || "").trim();
    const phone = normalizePhone(body.mpesaPhone);
    if ((selected.id === "paystack" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) ||
        (selected.id === "daraja" && (wedding.currency !== "KES" || body.expectedAmountMinor % 100 !== 0 || !/^254[17]\d{8}$/.test(phone)))) {
      return sendJson(res, 400, { error: "Enter the required payment contact details. M-Pesa requires a Kenyan number and a whole-KES quote." });
    }
    if (!await verifyChallenge(body.captchaToken, req, new URL(origin).hostname)) {
      return sendJson(res, 400, { error: "Complete the anti-abuse verification before checkout." });
    }
    const row = await rpc("begin_publication_checkout", {
      p_wedding_id: weddingId, p_idempotency_key: body.idempotencyKey, p_provider: selected.id,
      p_expected_amount: body.expectedAmountMinor, p_expected_currency: body.expectedCurrency,
      p_expected_usd_amount: body.expectedUsdAmountMinor, p_expected_fx_id: body.expectedFxId || null
    }, session.token);
    // Exactly one request may initiate a provider operation, even across tabs.
    const claimed = row.status === "pending" && !row.initialization_started_at
      ? await supabaseRequest(`${table}?id=eq.${row.id}&initialization_started_at=is.null&status=eq.pending`, {
        service: true, method: "PATCH", prefer: "return=representation", body: { initialization_started_at: new Date().toISOString() }
      }) : [];
    if (!claimed?.length) return sendJson(res, 200, { checkout: publicStatus(row), message: "An existing publication payment must be resolved before another can start." });
    let initiated;
    try {
      const returnUrl = new URL("/wedding.html", origin);
      returnUrl.searchParams.set("id", weddingId);
      returnUrl.searchParams.set("publicationReturn", row.id);
      const args = { id: row.id, weddingId, amountMinor: Number(row.amount_minor), currency: row.currency,
        streamName: "Wedding site publication (test)", idempotencyKey: row.idempotency_key,
        email, returnUrl: returnUrl.toString(), paymentKind: "publication" };
      initiated = row.provider === "stripe" ? await createStripeCheckout(args)
        : row.provider === "paystack" ? await createPaystackCheckout(args)
          : await initiateDarajaStkPush({
            amountMinor: Number(row.amount_minor), phoneNumber: phone,
            callbackUrl: `${process.env.WEDDINGSITE_PUBLIC_ORIGIN}/api/webhooks?provider=daraja&kind=publication`,
            accountReference: `PUB${row.id.replaceAll("-", "").slice(0, 9)}`, description: "Site publication test"
          });
      await supabaseRequest(`${table}?id=eq.${row.id}&provider_reference=is.null`, {
        service: true, method: "PATCH", prefer: "return=minimal", body: { provider_reference: initiated.reference }
      });
    } catch (error) {
      console.error("Publication checkout setup requires review", row.id, error.message);
      await supabaseRequest(`${table}?id=eq.${row.id}&status=eq.pending`, {
        service: true, method: "PATCH", prefer: "return=minimal",
        body: { status: "review", ...(initiated?.reference ? { provider_reference: initiated.reference } : {}) }
      });
      return sendJson(res, 503, { checkout: publicStatus({ ...row, status: "review" }),
        error: "Publication checkout setup could not be confirmed. Do not retry payment; check this reference or contact platform support." });
    }
    return sendJson(res, 201, { checkout: publicStatus(row), checkoutUrl: initiated.url || null });
  } catch (error) {
    console.error("Publication payment request failed", error.message);
    const conflict = /quote changed|disabled|draft|Complete the wedding/i.test(error.message);
    return sendJson(res, conflict ? 409 : 503, { error: conflict ? error.message :
      /FX|exchange rate/i.test(error.message) ? "A fresh publication-fee exchange rate is unavailable. No new payment can start." :
        "Publication payment could not be confirmed. Do not start another payment while a prior request is unresolved." });
  }
}
