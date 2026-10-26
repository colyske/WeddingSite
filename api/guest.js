import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

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
  const rpc = (name, body, options = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, { ...options, method: "POST", body });

  try {
    if (action === "site") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      const wedding = await rpc("get_public_wedding_site", { p_slug: slug });
      if (!wedding?.id) return sendJson(res, 404, { error: "This wedding site is not published." });
      return sendJson(res, 200, { wedding });
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
          const result = await rpc("submit_rsvp_with_pass", {
            p_wedding_id: weddingId,
            p_guest_email: text(body.guestEmail, 254),
            p_guest_name: text(body.guestName, 100),
            p_attending: body.attending === true,
            p_dietary_requested: Boolean(text(body.dietaryPreference, 60) || text(body.dietaryNotes, 240)),
            p_dietary_notes: [text(body.dietaryPreference, 60), text(body.dietaryNotes, 180)].filter(Boolean).join(": ").slice(0, 240),
            p_plus_one_count: Math.max(0, parseInt(body.plusOnes || 0))
          });
          const rsvp = Array.isArray(result) ? result[0] : result;
          if (!rsvp || !["confirmed", "declined"].includes(rsvp.status) || !rsvp.rsvp_id) {
            const full = rsvp?.status === "full";
            return sendJson(res, full ? 409 : 400, { error: rsvp?.message || "RSVP could not be saved." });
          }
          return sendJson(res, 200, { message: rsvp.message, status: rsvp.status, rsvpId: rsvp.rsvp_id });
        } catch (error) {
          return sendJson(res, error.message.includes("capacity") ? 409 : 400, { error: error.message || "RSVP failed." });
        }
      }

      if (action === "bid") {
        try {
          const result = await rpc("place_dj_bid", {
            p_wedding_id: weddingId,
            p_song_title: text(body.songTitle, 160),
            p_artist_name: text(body.artist, 100),
            p_bid_amount_minor: Math.round(Number(body.bidAmount || 0) * 100),
            p_bidder_name: ""
          });
          const bid = Array.isArray(result) ? result[0] : result;
          if (bid?.status !== "placed") return sendJson(res, 400, { error: bid?.message || "Bid could not be saved." });
          return sendJson(res, 200, { message: bid.message });
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
      
      const result = await rpc("get_public_fundraising", { p_slug: slug });
      return sendJson(res, 200, result || { tiers: [], vip: null, sponsors: [] });
    }

    if (action === "browse") {
      if (!methodOnly(req, res, "GET")) return;
      const offset = Math.max(0, parseInt(req.query.offset || "0"));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "12")));
      
      const weddings = await rpc("list_published_weddings_paginated", { p_offset: offset, p_limit: limit });
      return sendJson(res, 200, { weddings: weddings || [] });
    }

    if (action === "wedding") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      const wedding = await rpc("get_public_wedding_site", { p_slug: slug });
      if (!wedding?.id) return sendJson(res, 404, { error: "This wedding site is not published." });
      return sendJson(res, 200, wedding);
    }

    if (action === "guest-pass") {
      // E-card: retrieve guest RSVP data for QR pass display
      // Security: Only returns guest's own data; no direct table access; goes through RPC
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      const guestId = String(req.query.guest_id || "");
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      if (!UUID.test(guestId)) return sendJson(res, 400, { error: "Invalid guest." });
      
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      
      try {
        const guest = await rpc("get_guest_pass_data", { p_wedding_id: weddingId, p_guest_id: guestId });
        if (!guest || guest.length === 0) return sendJson(res, 404, { error: "Guest not found." });
        return sendJson(res, 200, guest[0]);
      } catch (error) {
        return sendJson(res, 403, { error: "Cannot retrieve guest data." });
      }
    }

    if (action === "verify-qr") {
      if (req.method === "GET") {
        const code = String(req.query.code || "");
        if (!UUID.test(code)) return sendJson(res, 400, { error: "Invalid pass code." });
        const result = await rpc("get_guest_verification", { p_code: code });
        const guest = Array.isArray(result) ? result[0] : result;
        if (!guest?.rsvp_id) return sendJson(res, 404, { error: "Pass not found or wedding is unpublished." });
        return sendJson(res, 200, { guest });
      }
      if (!methodOnly(req, res, "POST")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const code = String(body.code || "");
      if (!UUID.test(code)) return sendJson(res, 400, { error: "Invalid pass code." });
      try {
        const result = await rpc("mark_guest_rsvp_checked_in", { p_code: code }, { token: session.token });
        const guest = Array.isArray(result) ? result[0] : result;
        if (!guest?.rsvp_id) return sendJson(res, 404, { error: "Guest not found." });
        return sendJson(res, 200, { checked_in: true, guest });
      } catch (error) {
        return sendJson(res, 400, { error: error.message || "Could not verify guest." });
      }
    }

    return sendJson(res, 404, { error: "Unknown action." });

  } catch (error) {
    console.error("guest endpoint failed", error.message);
    return sendJson(res, 503, { error: "This is temporarily unavailable. Please try again shortly." });
  }
}
