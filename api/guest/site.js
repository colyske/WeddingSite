// GET /api/guest/site/:weddingSlug
// Render guest-facing wedding site (published wedding data + RSVP/DJ bid forms)
// Response: { wedding, content, ledgerPage, diBids }

import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;

  const slug = req.url.split("/").pop()?.split("?")[0];
  if (!slug) {
    return sendJson(res, 400, { error: "Missing wedding slug." });
  }

  try {
    // Fetch wedding by slug (RLS ensures only published weddings are visible)
    const weddings = await supabaseRequest(
      `/rest/v1/weddings?slug=eq.${encodeURIComponent(slug)}&published_at=not.is.null&select=id,couple_names,wedding_date,public_location,currency,max_guest_capacity,palette,published_at`
    );

    const wedding = weddings?.[0];
    if (!wedding) {
      return sendJson(res, 404, { error: "Wedding not found or not yet published." });
    }

    // Fetch guest site content
    let content = {};
    try {
      const contents = await supabaseRequest(
        `/rest/v1/guest_site_content?wedding_id=eq.${encodeURIComponent(wedding.id)}&select=*`
      );
      content = contents?.[0] || {};
    } catch {
      // Public read might be restricted; that's okay
    }

    // Fetch paginated ledger (public contributions only)
    let ledgerPage = [];
    try {
      const ledger = await supabaseRequest(
        `/rest/v1/rpc/get_published_contributions_page?p_wedding_id=${encodeURIComponent(wedding.id)}&p_page=0&p_limit=20`
      );
      ledgerPage = ledger || [];
    } catch {
      // Ledger may not exist yet
    }

    // Fetch DJ bids ranked by total amount
    let djBids = [];
    try {
      const bids = await supabaseRequest(
        `/rest/v1/dj_song_bids?wedding_id=eq.${encodeURIComponent(wedding.id)}&order=rank_position.asc&select=id,song_title,artist_name,bid_amount_minor,rank_position`
      );
      djBids = bids || [];
    } catch {
      // Bids may not exist yet
    }

    return sendJson(res, 200, {
      wedding,
      content,
      ledgerPage,
      djBids
    });
  } catch (error) {
    console.error("guest site fetch failed", error.message);
    return sendJson(res, 500, { error: "Could not load wedding site." });
  }
}
