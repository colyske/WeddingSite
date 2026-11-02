import { supabaseRequest } from "./supabase.js";
import { isShowcase, showcase } from "./showcase.js";
import "../inspiration-fixtures.js";

export async function publicWeddingStyle(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9-]{3,80}$/.test(slug)) return null;
  // Select only reusable platform colours, never personal content or activity.
  const rows = isShowcase(slug) ? [showcase] : await supabaseRequest(
    `/rest/v1/weddings?slug=eq.${encodeURIComponent(slug)}&published_at=not.is.null&archived_at=is.null&lifecycle_admin_restricted=eq.false&select=palette&limit=1`,
    { service: true });
  if (!rows?.length) return null;
  return globalThis.WSInspiration.publicDesign(rows[0].palette);
}
