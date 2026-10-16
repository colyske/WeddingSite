import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { checkProviderHealth, isSecurePublicOrigin } from "../../server/payment-adapters.js";

const enabled = () => process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED === "true" &&
  Boolean(process.env.TURNSTILE_SECRET_KEY) && isSecurePublicOrigin(process.env.WEDDINGSITE_PUBLIC_ORIGIN);
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

export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const weddingId = String(req.query.weddingId || "");
  const market = String(req.query.market || "").toUpperCase();
  const currency = String(req.query.currency || "").toUpperCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(weddingId) ||
      !/^[A-Z0-9_-]{2,12}$/.test(market) || !/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { providers: [], paymentAvailable: false, message: "Select a valid wedding, market, and currency." });
  }
  if (!enabled()) {
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
