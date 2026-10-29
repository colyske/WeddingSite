import { supabaseRequest } from "./supabase.js";

export const FX_SOURCE = "https://open.er-api.com/v6/latest/USD";
export const MAX_FX_AGE_MS = 36 * 3600000;
const fresh = (row, now) => row && Date.parse(row.published_at) <= now + 300000 &&
  Date.parse(row.published_at) >= now - MAX_FX_AGE_MS;

export function validatedFx(payload, now = Date.now()) {
  const published = Date.parse(payload?.time_last_update_utc);
  if (payload?.result !== "success" || payload.base_code !== "USD" || !Number.isFinite(published) ||
      published > now + 300000 || now - published > MAX_FX_AGE_MS || payload.rates?.USD !== 1) {
    throw new Error("Publication FX rate is unavailable, invalid or older than 36 hours.");
  }
  const rates = Object.fromEntries(Object.entries(payload.rates).filter(([code, value]) =>
    /^[A-Z]{3}$/.test(code) && typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12));
  return { source: FX_SOURCE, published_at: new Date(published).toISOString(), rates };
}

export async function ensurePublicationFx(currency) {
  if (currency === "USD") return;
  const rows = await supabaseRequest("/rest/v1/publication_fx_snapshots?select=*&order=published_at.desc&limit=1", { service: true });
  const latest = rows?.[0];
  const now = Date.now();
  if (fresh(latest, now) && now - Date.parse(latest.published_at) < 24 * 3600000 &&
      Number(latest.rates?.[currency]) > 0) return;
  try {
    const response = await fetch(FX_SOURCE, { cache: "no-store", signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error(`Publication FX source returned HTTP ${response.status}.`);
    const snapshot = validatedFx(await response.json(), now);
    if (!snapshot.rates[currency]) throw new Error("The FX source does not quote this wedding currency.");
    await supabaseRequest("/rest/v1/publication_fx_snapshots?on_conflict=published_at", {
      service: true, method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: snapshot
    });
  } catch (error) {
    if (fresh(latest, now) && Number(latest.rates?.[currency]) > 0) {
      console.warn("Publication FX refresh unavailable; retaining timestamped rate within 36 hours:", error.message);
      return;
    }
    console.error("Publication FX unavailable:", error.message);
    throw new Error("A fresh publication-fee exchange rate is unavailable. No payment can start; try loading the quote later.");
  }
}

export function publicationMethodQuote(quote, provider) {
  const unit = provider === "daraja" ? 100 : 1;
  return { ...quote, fee_minor: Math.ceil(Number(quote.fee_minor) / unit) * unit, payment_unit_minor: unit };
}

export async function publicationQuote(weddingId, token, currency) {
  const load = () => supabaseRequest("/rest/v1/rpc/publication_quote", {
    token, method: "POST", body: { p_wedding_id: weddingId }
  });
  let quote;
  try { quote = await load(); }
  catch (error) {
    if (!error.message.includes("FX_UNAVAILABLE")) throw error;
    await ensurePublicationFx(currency);
    return load();
  }
  if (Number(quote.usd_amount_minor) > 0 && currency !== "USD") {
    await ensurePublicationFx(currency);
    quote = await load();
  }
  return quote;
}
