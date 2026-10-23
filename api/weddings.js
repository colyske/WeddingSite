import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const toSlug = text => String(text).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const FIELDS = "id,slug,couple_names,welcome_story,wedding_date,public_location,currency,max_guest_capacity,palette,published_at,created_at";

// Authenticated Client workspace API. All reads/writes run as the signed-in user so RLS applies.
export default async function handler(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;
  const opts = { token: session.token };
  const action = String(req.query?.action || "list");
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    if (action === "list") {
      if (!methodOnly(req, res, "GET")) return;
      const rows = await supabaseRequest(
        `/rest/v1/weddings?client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}&order=created_at.desc&limit=50`, opts);
      return sendJson(res, 200, { weddings: rows || [] });
    }

    if (action === "get") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${req.query.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`, opts);
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      return sendJson(res, 200, { wedding: rows[0] });
    }

    if (action === "create") {
      if (!methodOnly(req, res, "POST")) return;
      const names = String(body.coupleNames || "").trim();
      const palette = Array.isArray(body.palette) && body.palette.length ? body.palette : ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"];
      const capacity = Number(body.maxCapacity ?? 150);
      const currency = String(body.currency || "USD").toUpperCase();
      if (names.length < 1 || names.length > 120 || !/^[A-Z]{3}$/.test(currency) ||
          !Number.isInteger(capacity) || capacity < 1 || palette.length > 4 || !palette.every(c => COLOR.test(c))) {
        return sendJson(res, 400, { error: "Check the couple names, currency, guest capacity and up to four hex colors." });
      }
      const base = toSlug(names) || "wedding";
      for (const suffix of ["", `-${Math.random().toString(36).slice(2, 6)}`, `-${Math.random().toString(36).slice(2, 8)}`]) {
        try {
          const id = await supabaseRequest("/rest/v1/rpc/create_wedding", { ...opts, method: "POST", body: {
            p_slug: `${base}${suffix}`.slice(0, 80).padEnd(3, "x"), p_couple_names: names,
            p_wedding_date: body.weddingDate || null, p_location: String(body.location || "").slice(0, 120),
            p_currency: currency, p_capacity: capacity, p_palette: palette } });
          return sendJson(res, 201, { weddingId: id, slug: `${base}${suffix}` });
        } catch (error) {
          if (!/duplicate|unique/i.test(error.message)) throw error;
        }
      }
      return sendJson(res, 409, { error: "That web address is taken. Try different names." });
    }

    if (action === "update") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const patch = {};
      if (body.coupleNames !== undefined) patch.couple_names = String(body.coupleNames).trim().slice(0, 120);
      if (body.welcomeStory !== undefined) patch.welcome_story = String(body.welcomeStory).slice(0, 500);
      if (body.weddingDate !== undefined) patch.wedding_date = body.weddingDate || null;
      if (body.location !== undefined) patch.public_location = String(body.location).slice(0, 120);
      if (body.maxCapacity !== undefined) {
        const capacity = Number(body.maxCapacity);
        if (!Number.isInteger(capacity) || capacity < 1) return sendJson(res, 400, { error: "Capacity must be a whole number." });
        patch.max_guest_capacity = capacity;
      }
      if (body.palette !== undefined) {
        if (!Array.isArray(body.palette) || body.palette.length < 1 || body.palette.length > 4 || !body.palette.every(c => COLOR.test(c))) {
          return sendJson(res, 400, { error: "Choose one to four hex colors." });
        }
        patch.palette = body.palette;
      }
      if (!Object.keys(patch).length || patch.couple_names === "") return sendJson(res, 400, { error: "Nothing valid to update." });
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`,
        { ...opts, method: "PATCH", body: patch, prefer: "return=representation" });
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      return sendJson(res, 200, { wedding: rows[0] });
    }

    if (action === "publish") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      try {
        await supabaseRequest("/rest/v1/rpc/publish_wedding_with_fee", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId } });
      } catch (error) {
        return sendJson(res, 409, { error: error.message });
      }
      return sendJson(res, 200, { published: true });
    }

    if (action === "rsvps") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/guest_rsvps?wedding_id=eq.${req.query.weddingId}&select=id,guest_name,guest_email,attending,dietary_notes,created_at&order=created_at.desc&limit=200`, opts);
      return sendJson(res, 200, { rsvps: rows || [] });
    }

    if (action === "bids") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/dj_song_bids?wedding_id=eq.${req.query.weddingId}&select=id,song_title,artist,bid_amount_minor,guest_name,created_at&order=created_at.desc&limit=200`, opts);
      return sendJson(res, 200, { bids: rows || [] });
    }

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("weddings endpoint failed", error.message);
    return sendJson(res, error.status && error.status < 500 ? error.status : 503, { error: "The request could not be completed." });
  }
}
