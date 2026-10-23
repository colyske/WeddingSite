// POST /api/guest-actions (rsvp, dj-bid), GET /api/guest-site/:slug
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isGuestSite = url.pathname.startsWith("/api/guest-site/");
  const isguestActions = url.pathname === "/api/guest-actions";

  if (isGuestSite) {
    // GET /api/guest-site/:slug - fetch public wedding data for guest site
    if (!methodOnly(req, res, "GET")) return;

    const slug = url.pathname.replace("/api/guest-site/", "");
    if (!slug) return sendJson(res, 400, { error: "Missing wedding slug." });

    try {
      const weddings = await supabaseRequest(
        `/rest/v1/weddings?slug=eq.${encodeURIComponent(slug)}&published_at=not.is.null&select=id,couple_names,wedding_date,public_location,currency,max_guest_capacity,palette,published_at`
      );
      const wedding = weddings?.[0];
      if (!wedding) return sendJson(res, 404, { error: "Wedding not found or not published." });

      let content = {};
      let djBids = [];
      let ledger = [];
      try {
        const c = await supabaseRequest(
          `/rest/v1/guest_site_content?wedding_id=eq.${encodeURIComponent(wedding.id)}&select=story_approved,attire_approved,travel_approved`
        );
        content = c?.[0] || {};
      } catch {}
      try {
        const bids = await supabaseRequest(
          `/rest/v1/dj_song_bids?wedding_id=eq.${encodeURIComponent(wedding.id)}&order=rank_position.asc&select=id,song_title,artist_name,bid_amount_minor,rank_position&limit=50`
        );
        djBids = bids || [];
      } catch {}

      return sendJson(res, 200, { wedding, content, djBids, ledger });
    } catch (error) {
      console.error("guest site fetch failed", error.message);
      return sendJson(res, 500, { error: "Could not load wedding site." });
    }
  }

  if (isguestActions) {
    // POST /api/guest-actions?action=rsvp|dj-bid
    if (!methodOnly(req, res, "POST")) return;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = url.searchParams.get("action");
    const weddingId = body.weddingId;

    if (!action || !weddingId) {
      return sendJson(res, 400, { error: "action and weddingId are required." });
    }

    if (action === "rsvp") {
      const { guestName, emailAddress, dietaryNeeds, premiumDietaryOptedIn = false } = body;
      if (!guestName || !emailAddress) {
        return sendJson(res, 400, { error: "Guest name and email are required." });
      }

      try {
        const result = await supabaseRequest(`/rest/v1/rpc/accept_rsvp_with_capacity_check`, {
          method: "POST",
          body: {
            p_wedding_id: weddingId,
            p_guest_name: guestName.trim().slice(0, 100),
            p_guest_email: emailAddress.trim().toLowerCase().slice(0, 255),
            p_dietary_needs: dietaryNeeds ? dietaryNeeds.trim().slice(0, 500) : "",
            p_premium_dietary_opted_in: premiumDietaryOptedIn
          }
        });

        return sendJson(res, 201, { rsvpId: result.rsvp_id, status: "yes" });
      } catch (error) {
        console.error("rsvp failed", error.message);
        return sendJson(res, 400, { error: error.message || "Could not accept RSVP." });
      }
    }

    if (action === "dj-bid") {
      const { songTitle, artistName, bidAmountMinor, guestEmail } = body;
      if (!songTitle || bidAmountMinor == null || bidAmountMinor < 0) {
        return sendJson(res, 400, { error: "Song title and bid amount are required." });
      }

      try {
        const bids = await supabaseRequest(`/rest/v1/dj_song_bids`, {
          method: "POST",
          body: {
            wedding_id: weddingId,
            song_title: songTitle.trim().slice(0, 200),
            artist_name: artistName ? artistName.trim().slice(0, 100) : "",
            bid_amount_minor: Math.floor(bidAmountMinor),
            guest_email: guestEmail ? guestEmail.trim().toLowerCase().slice(0, 255) : ""
          }
        });

        const bid = bids?.[0];
        if (!bid) return sendJson(res, 400, { error: "Could not insert DJ bid." });

        await supabaseRequest(`/rest/v1/rpc/rank_dj_bids_for_wedding`, {
          method: "POST",
          body: { p_wedding_id: weddingId }
        });

        return sendJson(res, 201, { bidId: bid.id, rank: bid.rank_position });
      } catch (error) {
        console.error("dj bid failed", error.message);
        return sendJson(res, 400, { error: "Could not place DJ bid." });
      }
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });
  }

  return sendJson(res, 404, { error: "Endpoint not found." });
}
