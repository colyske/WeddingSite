import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";
import { isPastWedding } from "../server/wedding-time.js";
import { createHmac } from "node:crypto";
import { normalizePhone, phoneKeyEmail } from "../server/phone.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Best-effort per-instance rate limiter (the database unique index is the real dedupe).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const clientHash = (req, slug) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const key = process.env.WEDDINGSITE_HASH_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || "weddingsite";
  return createHmac("sha256", key).update(`${slug}|${ip}|${req.headers["user-agent"] || ""}`).digest("hex").slice(0, 32);
};
const REF = /^[a-f0-9]{8}$/;
const normPhone = normalizePhone;
const phoneIn = p => `in.(${p},%2B${p})`;

const refFor = async (weddingId, rsvpId) => {
  try {
    const r = await supabaseRequest(`/rest/v1/guest_rsvps?id=eq.${rsvpId}&wedding_id=eq.${weddingId}&select=ref_code`, { service: true });
    return r?.[0]?.ref_code || "";
  } catch { return ""; }
};

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

    if (action === "og") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const site = /^[a-z0-9-]{3,80}$/.test(slug) ? await rpc("get_public_wedding_site", { p_slug: slug }).catch(() => null) : null;
      const host = req.headers["x-forwarded-host"] || req.headers.host || "weddingsite-six-bice.vercel.app";
      const origin = `https://${String(host).replace(/[^a-z0-9.:-]/gi, "")}`;
      const ref = REF.test(String(req.query.ref || "")) ? String(req.query.ref) : "";
      const target = `/guest.html?slug=${encodeURIComponent(slug)}${ref ? `&ref=${ref}` : ""}`;
      const title = site?.id ? `${site.couple_names} are getting married` : "WeddingSite";
      const when = site?.wedding_date ? String(site.wedding_date).slice(0, 10) : "";
      const desc = site?.id ? `You are invited${when ? " - " + when : ""}${site.public_location ? " - " + site.public_location : ""}. RSVP, send wishes and save the date.` : "Organize your wedding your way.";
      const image = "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80";
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="WeddingSite">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + "/w/" + slug)}"><meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}"></head><body><p><a href="${esc(target)}">Open the wedding site</a></p><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
    }
    if (action === "visit") {
      if (!methodOnly(req, res, "POST")) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const slug = String(body.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 400, { error: "Invalid wedding." });
      const hash = clientHash(req, slug);
      if (limited(`v|${hash}`, 30, 60000)) return sendJson(res, 429, { error: "Too many requests." });
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      const ref = REF.test(String(body.ref || "")) ? String(body.ref) : "";
      await supabaseRequest("/rest/v1/site_visits?on_conflict=wedding_id,ref_code,visitor_hash,day", { service: true, method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: { wedding_id: weddingId, ref_code: ref, visitor_hash: hash } });
      return sendJson(res, 200, { ok: true });
    }

    if (action === "extras") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      const weddingId = /^[a-z0-9-]{3,80}$/.test(slug) ? await resolveWeddingId(slug, rpc) : null;
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      const [w, wishes] = await Promise.all([
        supabaseRequest(`/rest/v1/weddings?id=eq.${weddingId}&select=faq,travel_info`, { service: true }),
        supabaseRequest(`/rest/v1/guest_wishes?wedding_id=eq.${weddingId}&status=eq.approved&select=author_name,message,created_at&order=created_at.desc&limit=50`, { service: true })
      ]);
      return sendJson(res, 200, { faq: w?.[0]?.faq || [], travel: w?.[0]?.travel_info || "", wishes: wishes || [] });
    }

    if (action === "wish") {
      if (!methodOnly(req, res, "POST")) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const slug = String(body.slug || "").toLowerCase();
      const name = text(body.name, 80), message = text(body.message, 500);
      if (!name || !message) return sendJson(res, 400, { error: "Please add your name and a message." });
      if (limited(`w|${clientHash(req, slug)}`, 5, 600000)) return sendJson(res, 429, { error: "Please wait a little before sending another wish." });
      const weddingId = /^[a-z0-9-]{3,80}$/.test(slug) ? await resolveWeddingId(slug, rpc) : null;
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      await supabaseRequest("/rest/v1/guest_wishes", { service: true, method: "POST", prefer: "return=minimal", body: { wedding_id: weddingId, author_name: name, message } });
      return sendJson(res, 200, { message: "Thank you! Your wish will appear once the couple approves it." });
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
      
      const wd = await supabaseRequest(`/rest/v1/weddings?id=eq.${weddingId}&published_at=not.is.null&archived_at=is.null&select=wedding_date,time_zone`, { service: true });
      if (!wd?.length) return sendJson(res, 404, { error: "Wedding not found." });
      if (isPastWedding(wd[0].wedding_date, wd[0].time_zone)) {
        return sendJson(res, 410, { error: "This wedding has taken place, so RSVPs and bids are closed. Thank you for celebrating with us!" });
      }

      if (action === "rsvp") {
        try {
          const phone = normPhone(body.guestPhone);
          if (!phone) return sendJson(res, 400, { error: "Please enter your phone number (with country code if it is not Kenyan)." });
          const attending = body.attending === true;
          const plusOnes = Math.min(10, Math.max(0, parseInt(body.plusOnes || 0) || 0));
          const cfg = (await supabaseRequest(`/rest/v1/weddings?id=eq.${weddingId}&select=currency,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options`, { service: true }))?.[0] || {};
          const lines = [];
          if (attending) {
            if (cfg.rsvp_fee_minor > 0) lines.push({ label: "RSVP fee", amount_minor: Number(cfg.rsvp_fee_minor) });
            if (plusOnes > 0 && cfg.extra_guest_fee_minor > 0) lines.push({ label: `Extra guests (${plusOnes} x fee)`, amount_minor: plusOnes * Number(cfg.extra_guest_fee_minor) });
            const diet = text(body.dietaryPreference, 60).toLowerCase();
            if (diet && cfg.premium_diet_fee_minor > 0 && (cfg.premium_diet_options || []).some(o => String(o).toLowerCase() === diet)) {
              lines.push({ label: "Premium dietary preference", amount_minor: Number(cfg.premium_diet_fee_minor) });
            }
          }
          const totalMinor = lines.reduce((s, l) => s + l.amount_minor, 0);
          if (totalMinor > 0 && body.payConfirmed !== true) {
            return sendJson(res, 402, { needsPayment: true, quote: { lines, totalMinor, currency: cfg.currency } });
          }
          const existing = await supabaseRequest(`/rest/v1/guest_rsvps?wedding_id=eq.${weddingId}&phone=${phoneIn(phone)}&select=guest_email&order=created_at.asc&limit=1`, { service: true });
          const keyEmail = existing?.[0]?.guest_email || text(body.guestEmail, 254).toLowerCase() || phoneKeyEmail(phone);
          const result = await rpc("submit_rsvp_with_pass", {
            p_wedding_id: weddingId,
            p_guest_email: keyEmail,
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
          const partyNames = body.attending === true && Number(body.plusOnes) > 0 ? text(body.partyNames, 400) : "";
          const extra = { phone, ...(partyNames ? { party_names: partyNames } : {}) };
          if (Object.keys(extra).length) {
            try { await supabaseRequest(`/rest/v1/guest_rsvps?id=eq.${rsvp.rsvp_id}`, { service: true, method: "PATCH", prefer: "return=minimal", body: extra }); }
            catch (e) { console.error("rsvp extras save failed:", e.message); }
          }
          let charged = 0;
          if (totalMinor > 0) {
            try { await rpc("record_test_rsvp_fees", { p_wedding_id: weddingId, p_name: text(body.guestName, 100), p_lines: lines }, { service: true }); charged = totalMinor; }
            catch (e) { console.error("rsvp fee ledger failed:", e.message); }
          }
          let refCode = "";
          try {
            const mine = await supabaseRequest(`/rest/v1/guest_rsvps?id=eq.${rsvp.rsvp_id}&select=ref_code,referred_by_code`, { service: true });
            refCode = mine?.[0]?.ref_code || "";
            const by = String(body.ref || "");
            if (REF.test(by) && by !== refCode && !mine?.[0]?.referred_by_code) {
              const owner = await supabaseRequest(`/rest/v1/guest_rsvps?wedding_id=eq.${weddingId}&ref_code=eq.${by}&select=id`, { service: true });
              if (owner?.length) await supabaseRequest(`/rest/v1/guest_rsvps?id=eq.${rsvp.rsvp_id}`, { service: true, method: "PATCH", prefer: "return=minimal", body: { referred_by_code: by } });
            }
          } catch (e) { console.error("referral attribution failed:", e.message); }
          return sendJson(res, 200, { message: rsvp.message, status: rsvp.status, rsvpId: rsvp.rsvp_id, refCode, chargedMinor: charged, lines });
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
      
      const [result, campaigns] = await Promise.all([
        rpc("get_public_fundraising", { p_slug: slug }),
        rpc("get_public_campaigns", { p_slug: slug }).catch(() => [])
      ]);
      return sendJson(res, 200, { ...(result || { tiers: [], vip: null, sponsors: [] }), campaigns: campaigns || [] });
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

    if (action === "seating") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      if (limited(`seat|${clientHash(req, slug)}`, 12, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Too many lookups. Please try again in a few minutes." });
      const phone = normPhone(req.query.phone);
      if (!phone) return sendJson(res, 400, { error: "Enter the phone number the couple has on their guest list (with country code if it is not Kenyan)." });
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      const rows = await supabaseRequest(`/rest/v1/guests?wedding_id=eq.${weddingId}&phone=${phoneIn(phone)}&select=name,table_number&limit=1`, { service: true });
      if (!rows?.length) return sendJson(res, 404, { error: "We could not find that phone number on the guest list. Try the number the couple invited, or ask them." });
      return sendJson(res, 200, { name: rows[0].name, table: rows[0].table_number || null });
    }

    if (action === "pass-lookup") {
      if (!methodOnly(req, res, "GET")) return;
      const slug = String(req.query.slug || "").toLowerCase();
      if (!/^[a-z0-9-]{3,80}$/.test(slug)) return sendJson(res, 404, { error: "Wedding not found." });
      const weddingId = await resolveWeddingId(slug, rpc);
      if (!weddingId) return sendJson(res, 404, { error: "Wedding not found." });
      const code = String(req.query.code || "").trim();
      const email = String(req.query.email || "").trim().toLowerCase();
      if (UUID.test(code)) {
        const result = await rpc("get_guest_pass_data", { p_wedding_id: weddingId, p_guest_id: code });
        if (!result?.length) return sendJson(res, 404, { error: "No pass found for that code." });
        return sendJson(res, 200, { rsvpId: code, guestName: result[0].name, refCode: await refFor(weddingId, code) });
      }
      if (email.length >= 5 && email.length <= 254 && email.includes("@")) {
        const rows = await rpc("lookup_guest_pass", { p_wedding_id: weddingId, p_email: email });
        if (!rows?.length) return sendJson(res, 404, { error: "No pass found for that email." });
        return sendJson(res, 200, { rsvpId: rows[0].rsvp_id, guestName: rows[0].guest_name, refCode: await refFor(weddingId, rows[0].rsvp_id) });
      }
      const phone = normPhone(req.query.phone);
      if (phone) {
        const rows = await supabaseRequest(`/rest/v1/guest_rsvps?wedding_id=eq.${weddingId}&phone=${phoneIn(phone)}&select=id,guest_name&order=created_at.desc&limit=1`, { service: true });
        if (!rows?.length) return sendJson(res, 404, { error: "No pass found for that phone number." });
        return sendJson(res, 200, { rsvpId: rows[0].id, guestName: rows[0].guest_name, refCode: await refFor(weddingId, rows[0].id) });
      }
      return sendJson(res, 400, { error: "Enter the email or phone number you used to RSVP, or your pass code." });
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
