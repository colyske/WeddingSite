import { supabaseRequest } from "./supabase.js";
import {
  paystackEnvironment, paystackApproval, paystackDestination
} from "./paystack.js";
import {
  availableProviderMarkets, enabledPaymentProviders, liveDarajaEnabled, liveDarajaApproved
} from "../api/checkout.js";
import "../currencies.js";

const currenciesFromConfig = () => [...new Set([
  ...String(process.env.STRIPE_SUPPORTED_CURRENCIES || "").split(","),
  ...String(process.env.PAYSTACK_SUPPORTED_CURRENCIES || "").split(","),
  "KES"
].map(currency => currency.trim().toUpperCase()).filter(Boolean))]
  .filter(currency => globalThis.WSCurrencies.supportsAccounting(currency));

const methodLabels = Object.freeze({ daraja: "M-Pesa", stripe: "Card", paystack: "Card" });
const regionName = market => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(market) || market; }
  catch { return market; }
};
const currencyName = currency => {
  try { return new Intl.DisplayNames(["en"], { type: "currency" }).of(currency) || currency; }
  catch { return currency; }
};

export async function collectionCapabilities({ weddingId = null, record = false } = {}) {
  const policy = (await supabaseRequest(
    "/rest/v1/platform_policies?id=eq.true&select=enabled_payment_providers", { service: true }
  ))?.[0];
  const enabled = enabledPaymentProviders(policy);
  if (process.env.WEDDINGSITE_PAYMENT_MODE !== "live") {
    if (record && weddingId) await supabaseRequest("/rest/v1/rpc/replace_wedding_collection_capabilities", {
      service: true, method: "POST", body: { p_wedding_id: weddingId, p_routes: [] }
    });
    return [];
  }
  const candidates = currenciesFromConfig().flatMap(currency =>
    availableProviderMarkets(currency)
      .filter(route => enabled.includes(route.id))
      .map(route => ({ ...route, currency })));
  const darajaApproved = liveDarajaEnabled() ? await liveDarajaApproved() : false;
  const paystackApprovals = new Map();
  for (const route of candidates) {
    if (route.id !== "paystack" || paystackEnvironment() !== "live") continue;
    const key = `${route.currency}:${route.market}`;
    if (!paystackApprovals.has(key)) {
      paystackApprovals.set(key, await paystackApproval("guest", route.currency, route.market));
    }
  }
  const methodsByCurrency = new Map();
  const readyRoutes = [];
  for (const route of candidates) {
    if (route.id === "daraja" && !darajaApproved) continue;
    if (route.id === "paystack" && paystackEnvironment() === "live") {
      const approval = paystackApprovals.get(`${route.currency}:${route.market}`);
      if (!approval) continue;
      if (approval.settlement_mode === "split") {
        if (!weddingId) continue;
        const destination = await paystackDestination(weddingId, route.currency);
        if (!destination?.verified_at || !destination?.consent_at) continue;
      }
      if (!approval.capabilities?.some(pair => pair.market === route.market && pair.currency === route.currency)) continue;
    }
    readyRoutes.push({ provider: route.id, currency: route.currency, market: route.market });
    if (!methodsByCurrency.has(route.currency)) methodsByCurrency.set(route.currency, new Map());
    const methods = methodsByCurrency.get(route.currency);
    if (!methods.has(methodLabels[route.id])) methods.set(methodLabels[route.id], new Set());
    methods.get(methodLabels[route.id]).add(regionName(route.market));
  }
  const result = [...methodsByCurrency].map(([code, methods]) => ({
    code,
    name: currencyName(code),
    methods: [...methods].map(([name, markets]) => ({
      name, markets: [...markets].sort((a, b) => a.localeCompare(b))
    }))
  })).sort((a, b) => a.code.localeCompare(b.code));
  if (record && weddingId) await supabaseRequest("/rest/v1/rpc/replace_wedding_collection_capabilities", {
    service: true, method: "POST", body: { p_wedding_id: weddingId, p_routes: readyRoutes }
  });
  return result;
}
