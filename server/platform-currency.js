import { supabaseRequest } from "./supabase.js";

// Owner-chosen platform default currency. Null means no explicit Owner choice (legacy behavior).
// It only preselects; callers must check it against current collection capabilities.
export async function readPlatformDefaultCurrency() {
  const row = (await supabaseRequest(
    "/rest/v1/platform_policies?id=eq.true&select=default_currency", { service: true }
  ))?.[0];
  const code = row?.default_currency;
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : null;
}

export function defaultCurrencyStatus(code, currencies) {
  if (!code) return { currency: null, configured: false, supported: false };
  return { currency: code, configured: true, supported: (currencies || []).some(item => item?.code === code) };
}

export async function platformDefaultCurrencyStatus(currencies) {
  try { return defaultCurrencyStatus(await readPlatformDefaultCurrency(), currencies); }
  catch (error) {
    console.error("Platform default currency unavailable:", error.message);
    return { currency: null, configured: null, supported: false, unavailable: true };
  }
}
