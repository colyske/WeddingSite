import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Helper: resolve wedding ID from slug (for guest operations)
async function resolveWeddingId(slug, rpc) {
  if (!slug) return null;
  const rows = await rpc("get_public_wedding", { p_slug: slug });
  return rows?.[0]?.id || null;
}

// Public, unauthenticated guest endpoints. Every write goes through a SECURITY DEFINER RPC;
// anonymous clients have no direct table access and never receive platform fees or guest emails.
export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  const rpc = (name, body) => supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body });

  try {
    if (action === "site") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      const rows = await rpc("get_public_wedding", { p_slug: slug });
      if (!rows?.length) return sendJson(res, 404, { error: "This wedding site is not published." });
      return sendJson(res, 200, { wedding: rows[0] });
    }

    if (action === "leaderboard") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      
      let weddingId = String(req.query.weddingId || "");
      if (!UUID.test(weddingId)) {
        if (!slug) return sendJson(res, 400, { error: "Invalid wedding." });
        weddingId = await resolveWeddingId(slug, rpc);
        if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      }
      
      const bids = await rpc("get_dj_leaderboard", { p_wedding_id: weddingId });
      return sendJson(res, 200, { bids: bids || [] });
    }

    if (action === "ledger") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      
      let weddingId = String(req.query.weddingId || "");
      if (!UUID.test(weddingId)) {
        if (!slug) return sendJson(res, 400, { error: "Invalid wedding." });
        weddingId = await resolveWeddingId(slug, rpc);
        if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      }
      
      const offset = Math.max(0, parseInt(req.query.offset || "0"));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "50")));
      const ledger = await rpc("get_published_contributions_page", { p_wedding_id: weddingId, p_offset: offset, p_limit: limit });
      return sendJson(res, 200, { ledger: ledger || [] });
    }

    if (action === "rsvp" || action === "bid") {
      if (!methodOnly(req, res, "POST")) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      
      let weddingId = String(body.weddingId || "");
      if (!UUID.test(weddingId)) {
        const slug = String(body.weddingSlug || body.slug || "").toLowerCase();
        if (!slug) return sendJson(res, 400, { error: "Invalid wedding." });
        weddingId = await resolveWeddingId(slug, rpc);
        if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      }
      
      if (action === "rsvp") {
        try {
          await rpc("submit_rsvp", {
            p_wedding_id: weddingId,
            p_guest_email: text(body.guestEmail, 254),
            p_guest_name: text(body.guestName, 100),
            p_attending: body.attending === true,
            p_dietary_requested: body.guestEmail ? true : false,
            p_dietary_notes: text(body.dietaryNotes, 240),
            p_plus_one_count: Math.max(0, parseInt(body.plusOnes || 0))
          });
          return sendJson(res, 200, { message: "RSVP received." });
        } catch (error) {
          return sendJson(res, error.message.includes("capacity") ? 409 : 400, { error: error.message || "RSVP failed." });
        }
      }

      if (action === "bid") {
        try {
          await rpc("place_dj_bid", {
            p_wedding_id: weddingId,
            p_song_title: text(body.songTitle, 160),
            p_artist_name: text(body.artist, 100),
            p_bid_amount_minor: Math.round(Number(body.bidAmount || 0) * 100),
            p_bidder_name: ""
          });
          return sendJson(res, 200, { message: "Bid placed." });
        } catch (error) {
          return sendJson(res, 400, { error: error.message || "Bid failed." });
        }
      }
    }

    if (action === "rsvp-count") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      
      const count = await rpc("get_rsvp_count", { p_wedding_id: weddingId });
      return sendJson(res, 200, { count: count?.[0]?.count || 0 });
    }

    if (action === "fundraising") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      
      const tiers = await supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${weddingId}&select=id,name,min_amount_minor,perks,sort_order&order=sort_order.asc`).catch(() => []);
      const vip = await supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${weddingId}&select=id,title,description,seats_total,seats_sold,price_minor&limit=1`).catch(() => []);
      const sponsors = await supabaseRequest(`/rest/v1/sponsors?wedding_id=eq.${weddingId}&select=id,company_name,contact_email,contact_phone,website,amount_minor&status=eq.active&order=amount_minor.desc&limit=100`).catch(() => []);
      
      return sendJson(res, 200, { tiers: tiers || [], vip: vip?.[0] || null, sponsors: sponsors || [] });
    }

    if (action === "browse") {
      if (!methodOnly(req, res, "GET")) return;
      const offset = Math.max(0, parseInt(req.query.offset || "0"));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "12")));
      
      const weddings = await rpc("list_published_weddings_paginated", { p_offset: offset, p_limit: limit });
      return sendJson(res, 200, { weddings: weddings || [] });
    }

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("guest endpoint failed", error.message);
    return sendJson(res, 503, { error: "This is temporarily unavailable. Please try again shortly." });
  }
}
