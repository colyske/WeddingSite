import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

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
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const bids = await rpc("get_dj_leaderboard", { p_wedding_id: req.query.weddingId });
      return sendJson(res, 200, { bids: bids || [] });
    }

    if (action === "ledger") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const ledger = await rpc("get_published_contributions_page", { p_wedding_id: req.query.weddingId, p_offset: 0, p_limit: 50 });
      return sendJson(res, 200, { ledger: ledger || [] });
    }

    if (action === "rsvp" || action === "bid") {
      if (!methodOnly(req, res, "POST")) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      
      if (action === "rsvp") {
        try {
          await rpc("submit_rsvp", {
            p_wedding_id: body.weddingId,
            p_guest_email: text(body.guestEmail, 254),
            p_guest_name: text(body.guestName, 100),
            p_attending: body.attending === true,
            p_dietary_requested: body.guestEmail ? true : false,
            p_dietary_notes: text(body.dietaryNotes, 240),
            p_plus_one_count: 0
          });
          return sendJson(res, 200, { message: "RSVP received." });
        } catch (error) {
          return sendJson(res, error.message.includes("capacity") ? 409 : 400, { error: error.message || "RSVP failed." });
        }
      }

      if (action === "bid") {
        try {
          await rpc("place_dj_bid", {
            p_wedding_id: body.weddingId,
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

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("guest endpoint failed", error.message);
    return sendJson(res, 503, { error: "This is temporarily unavailable. Please try again shortly." });
  }
}
