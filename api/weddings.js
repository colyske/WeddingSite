import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const toSlug = text => String(text).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const FIELDS = "id,slug,couple_names,welcome_story,wedding_date,public_location,currency,max_guest_capacity,palette,attire_notes,published_at,created_at";

// Load venues and payout info for a wedding
const loadWeddingDetails = async (weddingId, opts) => {
  const venues = await supabaseRequest(`/rest/v1/venues?wedding_id=eq.${weddingId}&select=id,name,event_time,map_link,description,is_main,sort_order&order=sort_order.asc`, opts).catch(() => []);
  const payout = await supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${weddingId}`, opts).catch(() => null);
  const registry = await supabaseRequest(`/rest/v1/registry_items?wedding_id=eq.${weddingId}&select=id,name,description,category,target_amount_minor,notes,sort_order&order=sort_order.asc`, opts).catch(() => []);
  return { venues: venues || [], payout, registry: registry || [] };
};

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
      const details = await loadWeddingDetails(rows[0].id, opts);
      return sendJson(res, 200, { wedding: { ...rows[0], ...details } });
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
      if (body.attireNotes !== undefined) {
        patch.attire_notes = String(body.attireNotes).slice(0, 300);
      }
      if (!Object.keys(patch).length || patch.couple_names === "") return sendJson(res, 400, { error: "Nothing valid to update." });
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`,
        { ...opts, method: "PATCH", body: patch, prefer: "return=representation" });
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      
      // Update venues if provided
      if (Array.isArray(body.venues)) {
        try {
          const existing = (await supabaseRequest(`/rest/v1/venues?wedding_id=eq.${body.weddingId}&select=id`, opts) || []).map(v => v.id);
          const incoming = body.venues.filter(v => v && v.id).map(v => v.id);
          const toDelete = existing.filter(id => !incoming.includes(id));
          for (const id of toDelete) {
            await supabaseRequest(`/rest/v1/venues?id=eq.${id}`, { ...opts, method: "DELETE" }).catch(() => null);
          }
          for (let i = 0; i < body.venues.length; i++) {
            const v = body.venues[i];
            if (!v.name || !v.name.trim()) continue;
            const venue = {
              name: v.name.trim().slice(0, 100),
              event_time: v.eventTime || null,
              map_link: v.mapLink || null,
              description: v.description || null,
              is_main: v.isMain || false,
              sort_order: i
            };
            if (v.id && existing.includes(v.id)) {
              await supabaseRequest(`/rest/v1/venues?id=eq.${v.id}`, { ...opts, method: "PATCH", body: venue }).catch(() => null);
            } else if (!v.id) {
              await supabaseRequest("/rest/v1/venues", { ...opts, method: "POST", body: { wedding_id: body.weddingId, ...venue } }).catch(() => null);
            }
          }
        } catch (e) { console.warn("Venue update failed:", e.message); }
      }

      // Update registry items if provided
      if (Array.isArray(body.registry)) {
        try {
          const existing = (await supabaseRequest(`/rest/v1/registry_items?wedding_id=eq.${body.weddingId}&select=id`, opts) || []).map(r => r.id);
          const incoming = body.registry.filter(r => r && r.id).map(r => r.id);
          const toDelete = existing.filter(id => !incoming.includes(id));
          for (const id of toDelete) {
            await supabaseRequest(`/rest/v1/registry_items?id=eq.${id}`, { ...opts, method: "DELETE" }).catch(() => null);
          }
          for (let i = 0; i < body.registry.length; i++) {
            const r = body.registry[i];
            if (!r.name || !r.targetAmount) continue;
            const item = {
              name: r.name.trim().slice(0, 100),
              description: r.description || null,
              category: r.category || null,
              target_amount_minor: Math.round(r.targetAmount * 100),
              notes: r.notes || null,
              sort_order: i
            };
            if (r.id && existing.includes(r.id)) {
              await supabaseRequest(`/rest/v1/registry_items?id=eq.${r.id}`, { ...opts, method: "PATCH", body: item }).catch(() => null);
            } else if (!r.id) {
              await supabaseRequest("/rest/v1/registry_items", { ...opts, method: "POST", body: { wedding_id: body.weddingId, ...item } }).catch(() => null);
            }
          }
        } catch (e) { console.warn("Registry update failed:", e.message); }
      }

      // Update payout preferences if provided
      if (body.payoutDetails) {
        try {
          const details = body.payoutDetails;
          const method = String(details.method || "").toLowerCase();
          const validMethods = ["mpesa", "bank_transfer", "stripe", "paystack", "other"];
          if (validMethods.includes(method)) {
            // Encrypt details: simple approach (in production, use actual encryption)
            const fieldsJson = JSON.stringify(details.fields || {});
            const payout = {
              wedding_id: body.weddingId,
              method: method,
              details_encrypted: fieldsJson,
              verified: details.verified || false
            };
            const existing = await supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${body.weddingId}`, opts).catch(() => []);
            if (existing && existing.length > 0) {
              await supabaseRequest(`/rest/v1/payout_preferences?id=eq.${existing[0].id}`, { ...opts, method: "PATCH", body: payout }).catch(() => null);
            } else {
              await supabaseRequest("/rest/v1/payout_preferences", { ...opts, method: "POST", body: payout }).catch(() => null);
            }
          }
        } catch (e) { console.warn("Payout update failed:", e.message); }
      }
      
      const details = await loadWeddingDetails(rows[0].id, opts);
      return sendJson(res, 200, { wedding: { ...rows[0], ...details } });
    }

    if (action === "publish") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      try {
        await supabaseRequest("/rest/v1/rpc/publish_wedding_with_fee", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_confirmed: true } });
      } catch (error) {
        const msg = error.message || "";
        let userMessage = msg;
        if (msg.includes("publication fee")) {
          userMessage = "Publication fee must be paid or waived. Contact platform support to waive for testing.";
        } else if (msg.includes("web address")) {
          userMessage = "Set a public web address (slug) before publishing.";
        } else if (msg.includes("confirmation")) {
          userMessage = "Publication requires explicit confirmation.";
        }
        return sendJson(res, 409, { error: userMessage });
      }
      const details = await loadWeddingDetails(body.weddingId, opts);
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`, opts);
      return sendJson(res, 200, { published: true, wedding: rows?.[0] ? { ...rows[0], ...details } : null });
    }

    if (action === "payout") {
      if (!methodOnly(req, res, ["GET", "POST"])) return;
      if (!UUID.test(String(req.query.weddingId || body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      
      const weddingId = body.weddingId || req.query.weddingId;
      // Verify ownership
      const owned = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id`, opts);
      if (!owned?.length) return sendJson(res, 404, { error: "Wedding not found." });
      
      if (req.method === "GET") {
        const payout = await supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${weddingId}&select=method,display_mask,verified`, opts).catch(() => null);
        return sendJson(res, 200, { payout: payout || { method: null, display_mask: "", verified: false } });
      }
      
      if (req.method === "POST") {
        const { method, detailsEncrypted, displayMask } = body;
        if (!["mpesa", "bank_transfer", "stripe", "paystack", "other"].includes(method)) {
          return sendJson(res, 400, { error: "Choose a valid payout method." });
        }
        const payload = { method, details_encrypted: detailsEncrypted, display_mask: displayMask || "" };
        await supabaseRequest("/rest/v1/payout_preferences", {
          ...opts, method: "UPSERT", body: { wedding_id: weddingId, ...payload }
        }).catch(e => {
          console.warn("Payout upsert failed:", e.message);
          throw e;
        });
        return sendJson(res, 200, { payout: payload });
      }
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
