import { randomUUID } from "node:crypto";
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { checkProviderHealth, initiateDarajaStkPush, isSecurePublicOrigin, verifyProviderPayment } from "../server/payment-adapters.js";
import { normalizePhone } from "../server/phone.js";
import { isPastWedding } from "../server/wedding-time.js";
import { platformOrigins, weddingOriginSlug } from "../server/site-hosts.js";

const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const isText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;

const setOf = value => new Set(String(value || "").split(",").map(item => item.trim().toUpperCase()).filter(Boolean));

function configuredAdapters(currency, market) {
  const options = [];
  const mode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const stripeModeMatches = mode === "test" && process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_");
  const paystackModeMatches = mode === "test" && process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_");
  const darajaSandboxReady = mode === "test" && process.env.DARAJA_ENVIRONMENT === "sandbox" &&
    Boolean(process.env.DARAJA_CONSUMER_KEY) && Boolean(process.env.DARAJA_CONSUMER_SECRET) &&
    Boolean(process.env.DARAJA_SHORTCODE) && Boolean(process.env.DARAJA_PASSKEY) &&
    isSecurePublicOrigin(process.env.WEDDINGSITE_PUBLIC_ORIGIN);
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
    },
    {
      id: "daraja", name: "M-Pesa · Safaricom Daraja (Sandbox)",
      ready: Boolean(darajaSandboxReady),
      currencies: new Set(["KES"]),
      markets: new Set(["KE"])
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

// Provider availability is derived from platform configuration (test-mode credentials plus
// each provider's configured markets/currencies). Organizers never choose a processor.
export function availableProviderMarkets(currency) {
  const markets = new Set([
    ...setOf(process.env.STRIPE_SUPPORTED_MARKETS), ...setOf(process.env.PAYSTACK_SUPPORTED_MARKETS), "KE"
  ]);
  return [...markets].flatMap(market => configuredAdapters(currency, market).map(item => ({ ...item, market })));
}

// Only provider TEST/sandbox mode is supported; live mode is never accepted. The
// WEDDINGSITE_LIVE_PAYMENTS_ENABLED flag is not required or consulted for test checkout.
export function testPaymentsEnabled() {
  return process.env.WEDDINGSITE_PAYMENT_MODE === "test";
}

// Returns to the exact origin that started checkout: pending-payment state is kept in that origin's sessionStorage.
export function paymentReturnUrl(returnOrigin, slug, key, id) {
  const onWeddingHost = Boolean(weddingOriginSlug(returnOrigin));
  const url = new URL(onWeddingHost ? "/" : "/guest.html", returnOrigin);
  if (!onWeddingHost) url.searchParams.set("slug", slug);
  url.searchParams.set(key, id);
  return url.toString();
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

async function createStripeCheckout({ id, weddingId, slug, streamName, amountMinor, currency, returnOrigin, idempotencyKey, email }) {
  const form = new URLSearchParams({
    mode: "payment",
    customer_creation: "always",
    "line_items[0][price_data][currency]": currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(amountMinor),
    "line_items[0][price_data][product_data][name]": `Wedding contribution · ${streamName}`,
    "line_items[0][quantity]": "1",
    client_reference_id: id,
    "metadata[contribution_id]": id,
    "metadata[wedding_id]": weddingId,
    success_url: paymentReturnUrl(returnOrigin, slug, "paymentReturn", id),
    cancel_url: paymentReturnUrl(returnOrigin, slug, "paymentCancel", id)
  });
  if (isText(email, 254)) form.set("customer_email", email.trim().toLowerCase());
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

async function createPaystackCheckout({ id, weddingId, slug, streamName, amountMinor, currency, returnOrigin, idempotencyKey, email }) {
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      amount: amountMinor,
      currency,
      reference: idempotencyKey,
      callback_url: paymentReturnUrl(returnOrigin, slug, "paymentReturn", id),
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
  const currency = String(req.query.currency || "").toUpperCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(weddingId) ||
      !/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { providers: [], paymentAvailable: false, message: "Select a valid wedding, market, and currency." });
  }
  const unmetChecks = [
    !testPaymentsEnabled() && "WEDDINGSITE_PAYMENT_MODE=test",
    !process.env.TURNSTILE_SECRET_KEY && "TURNSTILE_SECRET_KEY",
    !(process.env.TURNSTILE_SITE_KEY || process.env.TURNSTILE_PUBLIC_KEY) && "TURNSTILE_SITE_KEY|TURNSTILE_PUBLIC_KEY",
    !isSecurePublicOrigin(process.env.WEDDINGSITE_PUBLIC_ORIGIN) && "WEDDINGSITE_PUBLIC_ORIGIN"
  ].filter(Boolean);
  if (unmetChecks.length) {
    // Names of unmet setting checks only; never values.
    return sendJson(res, 200, { providers: [], paymentAvailable: false, unmetChecks, message: "Payments are not available yet. No payment gateway is enabled." });
  }
  try {
    const weddings = await supabaseRequest(`/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&published_at=not.is.null&archived_at=is.null&select=id,currency`, { service: true });
    if (!weddings?.length || weddings[0].currency !== currency) {
      return sendJson(res, 200, { providers: [], paymentAvailable: false, message: "Payments are not available for this wedding or currency." });
    }
    const candidates = availableProviderMarkets(currency);
    const eligible = [...new Set(candidates.map(item => item.id))];
    const health = await Promise.all(eligible.map(async provider =>
      [provider, await checkProviderHealth(provider)]
    ));
    const healthy = new Set(health.filter(([, ready]) => ready).map(([provider]) => provider));
    const providers = candidates.filter(item => healthy.has(item.id));
    return sendJson(res, 200, {
      providers,
      paymentAvailable: providers.length > 0,
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || process.env.TURNSTILE_PUBLIC_KEY || "",
      message: providers.length ? "" : "Payments are not available for this wedding and market yet, or a provider health check failed.",
      providerChecks: health.map(([provider, healthy]) => ({ provider, healthy }))
    });
  } catch (error) {
    console.error("payment availability check failed", error.message);
    return sendJson(res, 503, { providers: [], paymentAvailable: false, message: "Payment availability could not be verified." });
  }
}

async function handleCheckout(req, res) {
  if (!methodOnly(req, res, "POST")) return;
  if (!testPaymentsEnabled()) {
    return sendJson(res, 503, { error: "Payments are currently unavailable. Paid actions cannot be completed until a test provider is enabled." });
  }
  const origin = process.env.WEDDINGSITE_PUBLIC_ORIGIN?.replace(/\/+$/, "");
  if (!isSecurePublicOrigin(origin)) return sendJson(res, 503, { error: "The public site origin must be a valid HTTPS origin (localhost is allowed for testing)." });
  const requestOrigin = String(req.headers.origin || "");
  const originSlug = weddingOriginSlug(requestOrigin);
  if (requestOrigin !== origin && !platformOrigins().includes(requestOrigin) && !originSlug) {
    return sendJson(res, 403, { error: "Checkout must be started from the wedding site or the Join Our Wedding platform." });
  }
  const expectedHostname = new URL(requestOrigin).hostname;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const weddingId = String(body.weddingId || "");
  const purchaseAction = String(body.purchaseAction || "");
  const market = String(body.market || "").toUpperCase();
  const currency = String(body.currency || "").toUpperCase();
  const idempotencyKey = String(body.idempotencyKey || "");
  const visibility = body.visibility || "hidden";
  if (!isUuid(weddingId) || !/^[A-Z0-9_-]{2,12}$/.test(market) || !/^[A-Z]{3}$/.test(currency) ||
      !isUuid(idempotencyKey) ||       !["stripe", "paystack", "daraja"].includes(body.provider) ||
      !["rsvp", "song_bid", "vip", "sponsor", "fundraiser", "registry", "sponsor_featured_bid"].includes(purchaseAction) ||
      !["name", "anonymous", "hidden"].includes(visibility) ||
      (visibility !== "hidden" && body.publicConsent !== true) ||
      (visibility === "hidden" && body.publicConsent === true) ||
      (body.provider === "paystack" && (!isText(body.email || body.guestEmail, 254) || String(body.email || body.guestEmail).length > 254))) {
    return sendJson(res, 400, { error: "Invalid paid-action details or missing privacy consent." });
  }
  try {
    if (!await verifyChallenge(body.captchaToken, req, expectedHostname)) {
      return sendJson(res, 400, { error: "Complete the anti-abuse verification before checkout." });
    }
    const available = configuredAdapters(currency, market).some(item => item.id === body.provider);
    if (!available) return sendJson(res, 409, { error: "That payment option is not configured for this currency and market." });
    if (!await checkProviderHealth(body.provider)) return sendJson(res, 503, { error: "The selected payment provider is not healthy. No checkout was created." });
    const [weddings, policies] = await Promise.all([
      supabaseRequest(`/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&published_at=not.is.null&archived_at=is.null&select=id,slug,currency,wedding_date,time_zone,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options`, { service: true }),
      supabaseRequest("/rest/v1/platform_policies?id=eq.true&select=contribution_fee_basis_points,contribution_fixed_fee_minor,contribution_fixed_fee_currency,max_contribution_minor", { service: true })
    ]);
    const wedding = weddings?.[0];
    const policy = policies?.[0];
    if (!wedding || !policy || wedding.currency !== currency) {
      return sendJson(res, 409, { error: "Payments are not available for this wedding or currency." });
    }
    if (originSlug && originSlug !== wedding.slug) {
      return sendJson(res, 403, { error: "Checkout must be started from this wedding's own site." });
    }
    const prior = (await supabaseRequest(
      `/rest/v1/contributions?checkout_idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,payment_status&limit=1`,
      { service: true }
    ))?.[0];
    if (prior) return sendJson(res, 409, {
      error: "This checkout request was already started. Check its payment status before trying again.",
      paymentId: prior.id,
      paymentStatus: prior.payment_status
    });
    if (isPastWedding(wedding.wedding_date, wedding.time_zone)) {
      return sendJson(res, 410, { error: "This wedding has passed. Paid guest actions are closed." });
    }

    let amountMinor = 0;
    let streamName = "";
    let streamId = null;
    let milestoneId = null;
    let registryItemId = null;
    let purchaseData = {};
    let lines = [];
    const requestedAmount = Number(body.amountMinor);
    if (purchaseAction === "rsvp") {
      const phone = normalizePhone(body.guestPhone);
      const guestName = isText(body.guestName, 100) ? body.guestName.trim() : "";
      const plusOnes = Number(body.plusOnes || 0);
      if (!phone || !guestName || !Number.isInteger(plusOnes) || plusOnes < 0 || plusOnes > 10) {
        return sendJson(res, 400, { error: "Enter a valid guest name, phone number, and extra guest count." });
      }
      if (body.attending !== true) return sendJson(res, 400, { error: "A paid RSVP checkout is only for attending guests." });
      if (Number(wedding.rsvp_fee_minor) > 0) lines.push({ category: "rsvp", label: "RSVP fee", amount_minor: Number(wedding.rsvp_fee_minor) });
      if (plusOnes > 0 && Number(wedding.extra_guest_fee_minor) > 0) {
        lines.push({ category: "extra_guest", label: `Extra guests (${plusOnes} x fee)`, amount_minor: plusOnes * Number(wedding.extra_guest_fee_minor) });
      }
      const diet = String(body.dietaryPreference || "").trim();
      const premiumOptions = Array.isArray(wedding.premium_diet_options) ? wedding.premium_diet_options : [];
      if (diet && premiumOptions.some(option => String(option).toLowerCase() === diet.toLowerCase()) && Number(wedding.premium_diet_fee_minor) > 0) {
        lines.push({ category: "premium_diet", label: `Premium dietary choice: ${diet}`, amount_minor: Number(wedding.premium_diet_fee_minor) });
      }
      amountMinor = lines.reduce((sum, line) => sum + line.amount_minor, 0);
      streamName = "RSVP fees";
      purchaseData = {
        guestName, guestPhone: phone,
        guestEmail: String(body.guestEmail || "").trim().toLowerCase(),
        partyNames: String(body.partyNames || "").trim().slice(0, 400),
        plusOnes, dietaryRequested: Boolean(diet || body.dietaryNotes),
        dietaryNotes: [diet, String(body.dietaryNotes || "").trim()].filter(Boolean).join(": ").slice(0, 240)
      };
    } else if (purchaseAction === "fundraiser") {
      if (!isUuid(body.streamId) || !Number.isSafeInteger(body.amountMinor) || requestedAmount < 1) {
        return sendJson(res, 400, { error: "Choose an active fundraising campaign and a valid amount." });
      }
      const streams = await supabaseRequest(`/rest/v1/fundraising_streams?id=eq.${encodeURIComponent(body.streamId)}&wedding_id=eq.${encodeURIComponent(weddingId)}&enabled=eq.true&select=id,name,currency`, { service: true });
      const stream = streams?.[0];
      if (!stream || stream.currency !== currency) return sendJson(res, 409, { error: "This fundraising campaign is no longer available." });
      streamId = stream.id;
      streamName = stream.name;
      amountMinor = requestedAmount;
      if (body.milestoneId) {
        if (!isUuid(body.milestoneId)) return sendJson(res, 400, { error: "Invalid campaign milestone." });
        const milestones = await supabaseRequest(`/rest/v1/fundraising_milestones?id=eq.${encodeURIComponent(body.milestoneId)}&stream_id=eq.${encodeURIComponent(stream.id)}&select=id`, { service: true });
        if (!milestones?.length) return sendJson(res, 409, { error: "This milestone is no longer available." });
        milestoneId = milestones[0].id;
      }
      purchaseData = { streamName: stream.name };
    } else if (purchaseAction === "registry") {
      if (!isUuid(body.registryItemId) || !Number.isSafeInteger(body.amountMinor) || requestedAmount < 1) {
        return sendJson(res, 400, { error: "Choose a registry item and enter a valid amount." });
      }
      const items = await supabaseRequest(`/rest/v1/registry_items?id=eq.${encodeURIComponent(body.registryItemId)}&wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,name,target_amount_minor`, { service: true });
      if (!items?.[0]) return sendJson(res, 409, { error: "This registry item is no longer available." });
      registryItemId = items[0].id;
      streamName = `Registry: ${items[0].name}`;
      amountMinor = requestedAmount;
      purchaseData = { itemName: items[0].name };
    } else if (purchaseAction === "vip") {
      if (!isUuid(body.refId)) return sendJson(res, 400, { error: "Choose a valid VIP seat offer." });
      const offers = await supabaseRequest(`/rest/v1/vip_offers?id=eq.${encodeURIComponent(body.refId)}&wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,title,price_minor,seats_total,seats_sold`, { service: true });
      const offer = offers?.[0];
      if (!offer || Number(offer.seats_sold) >= Number(offer.seats_total)) return sendJson(res, 409, { error: "VIP seats are no longer available." });
      amountMinor = Number(offer.price_minor);
      streamName = `VIP: ${offer.title}`;
      purchaseData = { refId: offer.id, guestName: String(body.guestName || "").trim().slice(0, 100), guestEmail: String(body.email || body.guestEmail || "").trim().slice(0, 200) };
      if (!purchaseData.guestName) return sendJson(res, 400, { error: "Enter your name for the VIP reservation." });
    } else if (purchaseAction === "sponsor") {
      if (!isUuid(body.refId)) return sendJson(res, 400, { error: "Choose a sponsor package." });
      const tiers = await supabaseRequest(`/rest/v1/sponsor_tiers?id=eq.${encodeURIComponent(body.refId)}&wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,name,min_amount_minor`, { service: true });
      const tier = tiers?.[0];
      if (!tier) return sendJson(res, 409, { error: "This sponsor package is no longer available." });
      amountMinor = Number(tier.min_amount_minor);
      streamName = `Sponsor: ${tier.name}`;
      purchaseData = {
        refId: tier.id, companyName: String(body.companyName || body.guestName || "").trim().slice(0, 100),
        email: String(body.email || "").trim().slice(0, 200), phone: String(body.phone || "").trim().slice(0, 30),
        website: String(body.website || "").trim().slice(0, 300),
        location: String(body.location || "").trim().slice(0, 160),
        offer: String(body.offer || "").trim().slice(0, 360), publicContact: body.publicContact === true
      };
      if (!purchaseData.companyName) return sendJson(res, 400, { error: "Enter the sponsor's organization name." });
    } else if (purchaseAction === "sponsor_featured_bid") {
      const auction = await supabaseRequest("/rest/v1/rpc/get_public_sponsor_auction", {
        service: true, method: "POST", body: { p_slug: wedding.slug }
      });
      if (!auction?.enabled || auction.status !== "open") {
        return sendJson(res, 409, { error: "Featured sponsor bidding is not currently open." });
      }
      if (!Number.isSafeInteger(body.amountMinor) || requestedAmount < Number(auction.next_bid_minor)) {
        return sendJson(res, 409, { error: `The next eligible paid bid is ${Number(auction.next_bid_minor) / 100} ${currency}.` });
      }
      amountMinor = requestedAmount;
      streamName = "Featured sponsor bid";
      purchaseData = {
        minimumBidAtCheckout: Number(auction.next_bid_minor),
        companyName: String(body.companyName || body.guestName || "").trim().slice(0, 100),
        email: String(body.email || "").trim().slice(0, 200), phone: String(body.phone || "").trim().slice(0, 30),
        website: String(body.website || "").trim().slice(0, 300),
        location: String(body.location || "").trim().slice(0, 160),
        offer: String(body.offer || "").trim().slice(0, 360), publicContact: body.publicContact === true
      };
      if (!purchaseData.companyName) return sendJson(res, 400, { error: "Enter the sponsor's organization name." });
    } else if (purchaseAction === "song_bid") {
      const songTitle = String(body.songTitle || "").trim().slice(0, 160);
      const artist = String(body.artist || "").trim().slice(0, 100);
      if (!songTitle || !artist || !Number.isSafeInteger(body.amountMinor) || requestedAmount < 1) {
        return sendJson(res, 400, { error: "Choose a listed song and bid amount." });
      }
      const leaderboard = await supabaseRequest("/rest/v1/rpc/get_dj_leaderboard", {
        service: true, method: "POST", body: { p_wedding_id: weddingId }
      });
      const existing = (leaderboard || []).some(row =>
        String(row.song_title).toLowerCase() === songTitle.toLowerCase() &&
        String(row.artist_name).toLowerCase() === artist.toLowerCase()
      );
      if (!existing) return sendJson(res, 409, { error: "Choose an existing song from the paid leaderboard." });
      amountMinor = requestedAmount;
      streamName = `Song bid: ${songTitle}`;
      purchaseData = { songTitle, artist };
    }

    if (body.provider === "daraja") {
      const phone = normalizePhone(body.mpesaPhone);
      if (currency !== "KES" || market !== "KE" || amountMinor % 100 !== 0 ||
          !/^254[17]\d{8}$/.test(phone)) {
        return sendJson(res, 400, { error: "M-Pesa sandbox requires a valid Kenyan mobile number and a whole-KES amount." });
      }
    }

    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > Number(policy.max_contribution_minor)) {
      return sendJson(res, 400, { error: "The amount is outside the configured per-payment limit." });
    }
    const contributionId = randomUUID();
    const fixedFeeMinor = currency === policy.contribution_fixed_fee_currency ? Number(policy.contribution_fixed_fee_minor || 0) : 0;
    if (lines.length === 0) lines = [{ category: purchaseAction, label: streamName, amount_minor: amountMinor }];
    const entry = {
      id: contributionId,
      wedding_id: weddingId,
      stream_id: streamId,
      milestone_id: milestoneId,
      registry_item_id: registryItemId,
      stream_name: streamName,
      pledged_amount_minor: amountMinor,
      paid_amount_minor: 0,
      platform_fee_basis_points: policy.contribution_fee_basis_points,
      platform_fee_minor: 0,
      net_paid_minor: 0,
      platform_fixed_fee_minor: fixedFeeMinor,
      provider_fee_pending: true,
      currency,
      payment_status: "pending",
      purchase_action: purchaseAction,
      purchase_data: purchaseData,
      action_idempotency_key: idempotencyKey,
      display_name: visibility === "name" ? String(body.displayName || body.guestName || "").trim().slice(0, 100) : "Anonymous guest",
      visibility: "hidden",
      public_consent_at: null,
      provider_name: body.provider,
      checkout_idempotency_key: idempotencyKey
    };
    await supabaseRequest("/rest/v1/contributions", {
      service: true, method: "POST", body: entry, prefer: "return=minimal"
    });
    let checkout = null;
    try {
      await supabaseRequest("/rest/v1/contribution_line_items", {
        service: true, method: "POST", prefer: "return=minimal",
        body: lines.map(line => ({
          contribution_id: contributionId, category: line.category,
          label: line.label, amount_minor: line.amount_minor, currency
        }))
      });
      const arguments_ = {
        id: contributionId, weddingId, slug: wedding.slug, streamName, amountMinor,
        currency, returnOrigin: requestOrigin, idempotencyKey, email: body.email || body.guestEmail
      };
      checkout = body.provider === "stripe"
        ? await createStripeCheckout(arguments_)
        : body.provider === "paystack"
          ? await createPaystackCheckout({ ...arguments_, email: body.email || body.guestEmail })
          : await initiateDarajaStkPush({
            amountMinor,
            phoneNumber: normalizePhone(body.mpesaPhone),
            callbackUrl: `${origin}/api/webhooks?provider=daraja`,
            accountReference: `WS${contributionId.replaceAll("-", "").slice(0, 10)}`,
            description: streamName
          });
      const patch = {
        provider_reference: checkout.reference,
        visibility,
        public_consent_at: body.publicConsent === true ? new Date().toISOString() : null
      };
      await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(contributionId)}`, {
        service: true, method: "PATCH", body: patch, prefer: "return=minimal"
      });
    } catch (error) {
      if (checkout) {
        console.error("checkout exists but its reference could not be persisted", contributionId);
        return sendJson(res, 503, {
          error: "Checkout setup could not be confirmed safely. No paid action was recorded; contact the organizer before retrying."
        });
      }
      await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(contributionId)}`, {
        service: true, method: "DELETE", prefer: "return=minimal"
      }).catch(cleanupError => console.error("Failed to clean up incomplete checkout", cleanupError.message));
      throw error;
    }
    return sendJson(res, 201, body.provider === "daraja"
      ? {
        provider: body.provider,
        paymentStatus: "pending",
        paymentId: contributionId,
        message: "M-Pesa sandbox STK Push sent. Check the phone you entered and approve the prompt; the action remains pending until Safaricom confirms it."
      }
      : { provider: body.provider, checkoutUrl: checkout.url, paymentStatus: "pending", paymentId: contributionId });
  } catch (error) {
    console.error("hosted checkout initialization failed", error.message);
    return sendJson(res, error.status || 503, { error: "Checkout was not started. No funds were collected; try again later." });
  }
}

async function handleStatus(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const id = String(req.query.id || "");
  if (!isUuid(id)) return sendJson(res, 400, { error: "Invalid payment reference." });
  try {
    let rows = await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(id)}&select=id,payment_status,provider_name,provider_reference,pledged_amount_minor,currency,purchase_action,action_result,action_completed_at,provider_fee_pending`, { service: true });
    let row = rows?.[0];
    if (!row) return sendJson(res, 404, { error: "Payment reference not found." });
    const shouldVerify = row.payment_status === "pending" ||
      (row.provider_name !== "daraja" && row.provider_fee_pending);
    if (shouldVerify && row.provider_reference) {
      const payment = await verifyProviderPayment(
        row.provider_name, row.provider_reference, row.id, row.pledged_amount_minor, row.currency
      );
      if (payment.verified) {
        await supabaseRequest("/rest/v1/rpc/record_verified_payment", {
          service: true, method: "POST",
          body: {
            p_provider: payment.provider, p_provider_event_id: payment.eventId,
            p_contribution_id: row.id, p_amount_minor: payment.amountMinor,
            p_currency: payment.currency, p_provider_reference: payment.reference,
            p_provider_fee_minor: payment.providerFeeMinor,
            p_provider_paid_at: payment.providerPaidAt,
            p_provider_payment_reference: payment.providerPaymentReference
          }
        });
      } else if (payment.terminal && row.payment_status === "pending") {
        await supabaseRequest(
            `/rest/v1/contributions?id=eq.${encodeURIComponent(id)}&payment_status=eq.pending`,
            { service: true, method: "PATCH", body: { payment_status: "cancelled" }, prefer: "return=minimal" }
        );
      }
      if (payment.verified || payment.terminal) {
        rows = await supabaseRequest(`/rest/v1/contributions?id=eq.${encodeURIComponent(id)}&select=id,payment_status,purchase_action,action_result,action_completed_at,provider_fee_pending`, { service: true });
        row = rows?.[0] || row;
      }
    }
    return sendJson(res, 200, {
      paymentStatus: row.payment_status === "paid" ? "paid" :
        row.payment_status === "refunded" ? "refunded" :
          row.payment_status === "cancelled" ? "cancelled" : "pending",
      action: row.purchase_action || null,
      actionStatus: row.action_completed_at ? "completed" : row.payment_status === "paid" ? "review_required" : "pending",
      actionResult: row.action_completed_at ? row.action_result : null
    });
  } catch (error) {
    console.error("payment verification failed", error.message);
    return sendJson(res, error.status || 503, { error: "Payment confirmation could not be verified yet. Do not retry checkout; check this payment status again." });
  }
}

export default async function handler(req, res) {
  const action = String(req.query.action || "create").toLowerCase();
  if (action === "options") return handleOptions(req, res);
  if (action === "create") return handleCheckout(req, res);
  if (action === "status") return handleStatus(req, res);
  return sendJson(res, 400, { error: "Unknown action." });
}
