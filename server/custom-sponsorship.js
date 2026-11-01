import { supabaseRequest } from "./supabase.js";
import { ensurePublicationFx, MAX_FX_AGE_MS } from "./publication-fx.js";

// Owner-approved floor for a sponsor-entered amount when a wedding has no packages.
export const CUSTOM_SPONSOR_FLOOR = Object.freeze({ currency: "KES", amountMinor: 500000 });

export class CustomSponsorFxUnavailable extends Error {}

// Converts the KES floor with a stored, timestamped USD-based snapshot and rounds
// up to a whole currency unit. Mirrors public.custom_sponsor_minimum_minor().
export function convertedFloorMinor(currency, rates) {
  if (currency === CUSTOM_SPONSOR_FLOOR.currency) return CUSTOM_SPONSOR_FLOOR.amountMinor;
  const target = Number(rates?.[currency]);
  const origin = Number(rates?.[CUSTOM_SPONSOR_FLOOR.currency]);
  if (!(target > 0) || !(origin > 0)) throw new CustomSponsorFxUnavailable("No rate for this currency.");
  const units = CUSTOM_SPONSOR_FLOOR.amountMinor / 100 * target / origin;
  return Math.ceil(Number(units.toFixed(6))) * 100;
}

export async function customSponsorMinimum(currency, now = Date.now()) {
  if (currency === CUSTOM_SPONSOR_FLOOR.currency) {
    return { minimumMinor: CUSTOM_SPONSOR_FLOOR.amountMinor, fxSnapshotId: null, fxPublishedAt: null, fxSource: null };
  }
  try {
    await ensurePublicationFx(CUSTOM_SPONSOR_FLOOR.currency);
    await ensurePublicationFx(currency);
  } catch (error) {
    throw new CustomSponsorFxUnavailable(error.message);
  }
  const latest = (await supabaseRequest("/rest/v1/publication_fx_snapshots?select=id,source,published_at,rates&order=published_at.desc&limit=1", { service: true }))?.[0];
  const published = Date.parse(latest?.published_at);
  if (!latest || !Number.isFinite(published) || now - published > MAX_FX_AGE_MS || published > now + 300000) {
    throw new CustomSponsorFxUnavailable("Exchange rate is stale or unavailable.");
  }
  return {
    minimumMinor: convertedFloorMinor(currency, latest.rates),
    fxSnapshotId: latest.id, fxPublishedAt: latest.published_at, fxSource: latest.source
  };
}

export async function sponsorPackageCount(weddingId) {
  const tiers = await supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${encodeURIComponent(weddingId)}&select=id&limit=1`, { service: true });
  return tiers?.length || 0;
}
