import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";
import { paymentAdaptersFor } from "./checkout.js";
import { normalizePhone, isPhoneKeyEmail } from "../server/phone.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const toSlug = text => String(text).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const FIELDS = "id,slug,couple_names,welcome_story,wedding_date,time_zone,public_location,currency,max_guest_capacity,palette,attire_notes,palette_names,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options,enabled_payment_methods,background_music_url,published_at,created_at,archived_at,unpublished_at,first_published_at";
const DEFAULT_ZONE = "Africa/Nairobi";
const validZone = tz => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const parseVenueTime = value => {
  const input = String(value || "").trim();
  if (!input) return null;
  const match = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) throw new Error("Enter venue times as HH:MM or h:MM AM/PM.");
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();
  if (minutes > 59 || seconds > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) {
    throw new Error("Enter a valid venue time.");
  }
  if (meridiem) hours = hours % 12 + (meridiem === "PM" ? 12 : 0);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
const configuredPayoutMethods = currency => {
  const markets = new Set([
    ...String(process.env.STRIPE_SUPPORTED_MARKETS || "").split(","),
    ...String(process.env.PAYSTACK_SUPPORTED_MARKETS || "").split(",")
  ].map(market => market.trim().toUpperCase()).filter(Boolean));
  const methods = new Map();
  for (const market of markets) {
    for (const adapter of paymentAdaptersFor(currency, market)) methods.set(adapter.id, adapter.name);
  }
  return [...methods].map(([id, name]) => ({ id, name }));
};

// Load venues and payout info for a wedding
const loadWeddingDetails = async (weddingId, opts) => {
  const [venues, payout, registry, tiers, vip] = await Promise.all([
    supabaseRequest(`/rest/v1/venues?wedding_id=eq.${weddingId}&select=id,name,event_time,event_date,map_link,description,is_main,kind,address,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${weddingId}&select=method,display_mask,verified`, opts),
    supabaseRequest(`/rest/v1/registry_items?wedding_id=eq.${weddingId}&select=id,name,description,category,target_amount_minor,notes,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${weddingId}&select=id,name,min_amount_minor,perks,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${weddingId}&select=id,title,description,seats_total,seats_sold,price_minor&limit=1`, opts)
  ]);
  return { venues: venues || [], payout: payout?.[0] || null, registry: registry || [], tiers: tiers || [], vip: vip?.[0] || null };
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
      const location = String(body.location || "").trim();
      const palette = Array.isArray(body.palette) && body.palette.length
        ? body.palette.map(color => typeof color === "string" ? color.trim().toLowerCase() : "")
        : ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"];
      const capacity = Number(body.maxCapacity ?? 150);
      const currency = String(body.currency || "USD").toUpperCase();
      let venues;
      try {
        venues = (Array.isArray(body.venues) ? body.venues : []).slice(0, 30).map((venue, sortOrder) => ({
          name: String(venue?.name || "").trim().slice(0, 100),
          eventTime: parseVenueTime(venue?.eventTime ?? venue?.time),
          mapLink: String(venue?.mapLink ?? venue?.map ?? "").trim() || null,
          description: String(venue?.description || "").trim().slice(0, 500) || null,
          isMain: venue?.isMain === true,
          sortOrder
        })).filter(venue => venue.name);
      } catch (error) {
        return sendJson(res, 400, { error: error.message || "Check the venue details." });
      }
      if (venues.some(venue => venue.mapLink && !/^https?:\/\//i.test(venue.mapLink))) {
        return sendJson(res, 400, { error: "Venue map links must use HTTP or HTTPS." });
      }
      if (names.length < 1 || names.length > 120 || location.length < 1 || location.length > 120 || !/^[A-Z]{3}$/.test(currency) ||
          !Number.isInteger(capacity) || capacity < 1 || palette.length < 1 || palette.length > 4 || !palette.every(c => COLOR.test(c))) {
        return sendJson(res, 400, { error: "Check the couple names, location, currency, guest capacity and up to four hex colors." });
      }
      if (!validDate(body.weddingDate)) return sendJson(res, 400, { error: "The wedding date is required (YYYY-MM-DD)." });
      if (!venues.some(venue => venue.eventTime)) return sendJson(res, 400, { error: "The wedding time is required: add the main venue with a start time." });
      const base = toSlug(names) || "wedding";
      if (body.timeZone !== undefined && body.timeZone !== null && body.timeZone !== "" && !validZone(body.timeZone)) {
        return sendJson(res, 400, { error: "Choose a valid time zone." });
      }
      const timeZone = validZone(body.timeZone) ? body.timeZone : DEFAULT_ZONE;
      for (const suffix of ["", `-${Math.random().toString(36).slice(2, 6)}`, `-${Math.random().toString(36).slice(2, 8)}`]) {
        try {
          const id = await supabaseRequest("/rest/v1/rpc/create_wedding_with_venues", { ...opts, method: "POST", body: {
            p_slug: `${base}${suffix}`.slice(0, 80).padEnd(3, "x"), p_couple_names: names,
            p_wedding_date: body.weddingDate, p_location: location.slice(0, 120),
            p_currency: currency, p_capacity: capacity, p_palette: palette, p_venues: venues } });
          if (timeZone !== DEFAULT_ZONE) {
            await supabaseRequest(`/rest/v1/weddings?id=eq.${encodeURIComponent(id)}&client_owner_id=eq.${encodeURIComponent(session.user.id)}`,
              { ...opts, method: "PATCH", body: { time_zone: timeZone } });
          }
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
      let normalizedVenues = null;
      if (Array.isArray(body.venues)) {
        try {
          normalizedVenues = body.venues.slice(0, 30).map((v, sortOrder) => ({
            id: v?.id || null,
            name: String(v?.name || "").trim().slice(0, 100),
            eventTime: parseVenueTime(v?.eventTime ?? v?.time),
            eventDate: validDate(v?.eventDate) ? v.eventDate : null,
            mapLink: String(v?.mapLink ?? v?.map ?? "").trim() || null,
            description: String(v?.description || "").trim().slice(0, 500) || null,
            isMain: v?.isMain === true && v?.kind !== "pre",
            kind: v?.kind === "pre" ? "pre" : "main",
            address: String(v?.address || "").trim().slice(0, 200) || null,
            sortOrder
          })).filter(v => v.name);
          if (!normalizedVenues.some(v => v.eventTime && v.kind !== "pre")) {
            return sendJson(res, 400, { error: "The wedding time is required: at least one venue needs a start time." });
          }
          if (normalizedVenues.some(v => v.mapLink && !/^https?:\/\//i.test(v.mapLink))) {
            return sendJson(res, 400, { error: "Venue map links must use HTTP or HTTPS." });
          }
        } catch (error) {
          return sendJson(res, 400, { error: error.message || "Check the venue details." });
        }
      }
      
      // Handle slug updates with uniqueness validation
      if (body.slug !== undefined) {
        const newSlug = String(body.slug).trim().toLowerCase();
        if (newSlug && !/^[a-z0-9-]{3,80}$/.test(newSlug)) {
          return sendJson(res, 400, { error: "Slug must be 3-80 lowercase letters, numbers, and hyphens." });
        }
        const reserved = ["admin", "api", "auth", "dashboard", "signin", "guest", "demo", "form-diagnostics", "index"];
        if (newSlug && reserved.includes(newSlug)) {
          return sendJson(res, 400, { error: "That web address is reserved. Please choose a different one." });
        }
        if (newSlug) {
          // Check uniqueness
          try {
            const existing = await supabaseRequest(`/rest/v1/weddings?slug=eq.${encodeURIComponent(newSlug)}&select=id`, opts);
            if (existing?.length > 0 && existing[0].id !== body.weddingId) {
              return sendJson(res, 409, { error: "That web address is already taken. Please choose a different one." });
            }
            patch.slug = newSlug;
          } catch (e) {
            console.warn("Slug uniqueness check error:", e);
            return sendJson(res, 400, { error: "Could not validate web address. Please try again." });
          }
        }
      }
      
      if (body.coupleNames !== undefined) patch.couple_names = String(body.coupleNames).trim().slice(0, 120);
      if (body.welcomeStory !== undefined) patch.welcome_story = String(body.welcomeStory).slice(0, 500);
      if (body.weddingDate !== undefined) {
        if (!validDate(body.weddingDate)) return sendJson(res, 400, { error: "The wedding date is required (YYYY-MM-DD)." });
        patch.wedding_date = body.weddingDate;
      }
      if (body.timeZone !== undefined) {
        if (!validZone(body.timeZone)) return sendJson(res, 400, { error: "Choose a valid time zone." });
        patch.time_zone = body.timeZone;
      }
      if (body.location !== undefined) patch.public_location = String(body.location).slice(0, 120);
      if (body.maxCapacity !== undefined) {
        const capacity = Number(body.maxCapacity);
        if (!Number.isInteger(capacity) || capacity < 1) return sendJson(res, 400, { error: "Capacity must be a whole number." });
        patch.max_guest_capacity = capacity;
      }
      if (body.currency !== undefined) {
        const currency = String(body.currency).toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) return sendJson(res, 400, { error: "Choose a valid currency." });
        patch.currency = currency;
      }
      if (body.palette !== undefined) {
        const palette = Array.isArray(body.palette)
          ? body.palette.map(color => typeof color === "string" ? color.trim().toLowerCase() : "")
          : null;
        if (!palette || palette.length < 1 || palette.length > 4 || !palette.every(c => COLOR.test(c))) {
          return sendJson(res, 400, { error: "Choose one to four hex colors." });
        }
        patch.palette = palette;
      }
      if (body.paletteNames !== undefined) {
        patch.palette_names = Array.isArray(body.paletteNames) ? body.paletteNames.slice(0, 4).map(n => String(n || "").trim().slice(0, 40)) : [];
      }
      for (const [key, col] of [["rsvpFee", "rsvp_fee_minor"], ["extraGuestFee", "extra_guest_fee_minor"], ["premiumDietFee", "premium_diet_fee_minor"]]) {
        if (body[key] === undefined) continue;
        const minor = Math.round(Number(body[key]) * 100);
        if (!Number.isFinite(minor) || minor < 0 || minor > 100000000) return sendJson(res, 400, { error: "Fees must be between 0 and 1,000,000." });
        patch[col] = minor;
      }
      if (body.premiumDietOptions !== undefined) {
        const list = Array.isArray(body.premiumDietOptions) ? body.premiumDietOptions : String(body.premiumDietOptions).split(",");
        patch.premium_diet_options = list.map(o => String(o).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
      }
      if (body.attireNotes !== undefined) {
        patch.attire_notes = String(body.attireNotes).slice(0, 300);
      }
      if (body.backgroundMusicUrl !== undefined) {
        const url = String(body.backgroundMusicUrl).trim();
        patch.background_music_url = url ? url.slice(0, 500) : null;
      }
      if (!Object.keys(patch).length || patch.couple_names === "") return sendJson(res, 400, { error: "Nothing valid to update." });
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`,
        { ...opts, method: "PATCH", body: patch, prefer: "return=representation" });
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      
      // Update venues if provided
      if (Array.isArray(body.venues)) {
        try {
          const existing = (await supabaseRequest(`/rest/v1/venues?wedding_id=eq.${body.weddingId}&select=id`, opts) || []).map(v => v.id);
          const incoming = normalizedVenues.filter(v => v.id).map(v => v.id);
          const toDelete = existing.filter(id => !incoming.includes(id));
          for (const id of toDelete) {
            await supabaseRequest(`/rest/v1/venues?id=eq.${id}`, { ...opts, method: "DELETE" });
          }
          for (let i = 0; i < normalizedVenues.length; i++) {
            const v = normalizedVenues[i];
            if (!v.name) continue;
            const venue = {
              name: v.name,
              event_time: v.eventTime,
              event_date: v.eventDate,
              map_link: v.mapLink || null,
              description: v.description || null,
              is_main: v.isMain || false,
              kind: v.kind,
              address: v.address,
              sort_order: i
            };
            if (v.id && existing.includes(v.id)) {
              await supabaseRequest(`/rest/v1/venues?id=eq.${v.id}`, { ...opts, method: "PATCH", body: venue });
            } else if (!v.id) {
              await supabaseRequest("/rest/v1/venues", { ...opts, method: "POST", body: { wedding_id: body.weddingId, ...venue } });
            }
          }
        } catch (e) {
          console.error("Venue update failed:", e.message);
          throw e;
        }
      }

      // Update registry items if provided
      if (Array.isArray(body.registry)) {
        try {
          const existing = (await supabaseRequest(`/rest/v1/registry_items?wedding_id=eq.${body.weddingId}&select=id`, opts) || []).map(r => r.id);
          const incoming = body.registry.filter(r => r && r.id).map(r => r.id);
          const toDelete = existing.filter(id => !incoming.includes(id));
          for (const id of toDelete) {
            await supabaseRequest(`/rest/v1/registry_items?id=eq.${id}`, { ...opts, method: "DELETE" });
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
              await supabaseRequest(`/rest/v1/registry_items?id=eq.${r.id}`, { ...opts, method: "PATCH", body: item });
            } else if (!r.id) {
              await supabaseRequest("/rest/v1/registry_items", { ...opts, method: "POST", body: { wedding_id: body.weddingId, ...item } });
            }
          }
        } catch (e) { console.error("Registry update failed:", e.message); throw e; }
      }

      // Update sponsor tiers if provided
      if (Array.isArray(body.tiers)) {
        try {
          const existing = (await supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${body.weddingId}&select=id`, opts) || []).map(t => t.id);
          const incoming = body.tiers.filter(t => t && t.id).map(t => t.id);
          const toDelete = existing.filter(id => !incoming.includes(id));
          for (const id of toDelete) {
            await supabaseRequest(`/rest/v1/sponsor_tiers?id=eq.${id}`, { ...opts, method: "DELETE" });
          }
          for (let i = 0; i < body.tiers.length; i++) {
            const t = body.tiers[i];
            if (!t.name || !t.minAmount) continue;
            const tier = {
              name: t.name.trim().slice(0, 60),
              min_amount_minor: Math.round(t.minAmount * 100),
              perks: String(t.perks || "").trim().slice(0, 240) || "Recognised as a supporter",
              sort_order: i
            };
            if (t.id && existing.includes(t.id)) {
              await supabaseRequest(`/rest/v1/sponsor_tiers?id=eq.${t.id}`, { ...opts, method: "PATCH", body: tier });
            } else if (!t.id) {
              await supabaseRequest("/rest/v1/sponsor_tiers", { ...opts, method: "POST", body: { wedding_id: body.weddingId, ...tier } });
            }
          }
        } catch (e) { console.error("Tier update failed:", e.message); throw e; }
      }

      // Update VIP offer if provided
      if (body.vip) {
        try {
          const v = body.vip;
          await supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${body.weddingId}`, { ...opts, method: "DELETE", prefer: "return=minimal" });
          if (v.price > 0 && v.seats > 0) {
            await supabaseRequest("/rest/v1/vip_offers", { ...opts, method: "POST", prefer: "return=minimal", body: {
              wedding_id: body.weddingId,
              title: String(v.title || "VIP seating").slice(0, 80),
              description: String(v.description || "").slice(0, 240),
              seats_total: Math.min(Math.floor(Number(v.seats)), 500),
              price_minor: Math.round(Number(v.price) * 100)
            }});
          }
        } catch (e) { console.error("VIP offer update failed:", e.message); throw e; }
      }

      // Update payout preferences if provided
      if (Object.hasOwn(body, "payoutDetails")) {
        try {
          const details = body.payoutDetails;
          if (!details) {
            await supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${body.weddingId}`, { ...opts, method: "DELETE" });
          } else {
          const method = String(details.method || "").toLowerCase();
          const currency = String(body.currency || rows[0].currency || "USD").toUpperCase();
          const validMethods = configuredPayoutMethods(currency).map(item => item.id);
          if (!validMethods.includes(method)) {
            return sendJson(res, 400, { error: "Choose a payout method currently configured by WeddingSite." });
          } else {
            // Encrypt details: simple approach (in production, use actual encryption)
            const fieldsJson = JSON.stringify(details.fields || {});
            const payout = {
              wedding_id: body.weddingId,
              method: method,
              details_encrypted: fieldsJson,
              verified: false
            };
            await supabaseRequest(`/rest/v1/payout_preferences?wedding_id=eq.${body.weddingId}&on_conflict=wedding_id`, {
              ...opts, method: "POST", body: payout, prefer: "resolution=merge-duplicates,return=minimal"
            });
          }
          }
        } catch (e) { console.error("Payout update failed:", e.message); throw e; }
      }
      
      const details = await loadWeddingDetails(rows[0].id, opts);
      return sendJson(res, 200, { wedding: { ...rows[0], ...details } });
    }

    if (action === "payout-methods") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${req.query.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=currency`, opts);
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      return sendJson(res, 200, { methods: configuredPayoutMethods(rows[0].currency) });
    }

    if (action === "delete" || req.method === "DELETE") {
      return sendJson(res, 405, { error: "Weddings are never deleted. Unpublish or archive instead." });
    }

    if (action === "quote") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const quote = await supabaseRequest("/rest/v1/rpc/publication_quote", { ...opts, method: "POST", body: { p_wedding_id: req.query.weddingId } });
      return sendJson(res, 200, { quote });
    }

    if (action === "unpublish" || action === "archive") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      if (body.confirmed !== true) return sendJson(res, 400, { error: "Please confirm this action." });
      if (action === "unpublish") {
        await supabaseRequest("/rest/v1/rpc/unpublish_wedding", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_confirmed: true } });
      } else {
        await supabaseRequest("/rest/v1/rpc/archive_wedding", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_archived: body.archived !== false } });
      }
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&select=${FIELDS}`, opts);
      return sendJson(res, 200, { ok: true, wedding: rows?.[0] || null });
    }

    if (action === "kyc-get") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const kyc = await supabaseRequest("/rest/v1/rpc/get_wedding_kyc", { ...opts, method: "POST", body: { p_wedding_id: req.query.weddingId, p_reveal: false } });
      return sendJson(res, 200, { kyc });
    }

    if (action === "kyc-save") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const data = body.kyc && typeof body.kyc === "object" ? body.kyc : {};
      const result = await supabaseRequest("/rest/v1/rpc/save_wedding_kyc", { ...opts, method: "POST",
        body: { p_wedding_id: body.weddingId, p_data: data, p_consent: body.consent === true } });
      return sendJson(res, 200, { ok: true, kyc: result });
    }

    if (action === "publish") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      try {
        await supabaseRequest("/rest/v1/rpc/publish_wedding_with_fee", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_confirmed: true } });
      } catch (error) {
        const msg = error.message || "";
        let userMessage = msg;
        if (msg.includes("PAYMENT_REQUIRED")) {
          return sendJson(res, 402, { error: msg.replace(/^.*PAYMENT_REQUIRED:?\s*/, "").slice(0, 300) || "A publication fee is required.", paymentRequired: true });
        } else if (/KYC|identity/i.test(msg)) {
          return sendJson(res, 409, { error: "Complete the couple identity (KYC) details before publishing.", kycRequired: true });
        } else if (/date/i.test(msg)) {
          userMessage = "Set the wedding date before publishing.";
        } else if (msg.includes("publication fee")) {
          userMessage = "Publication fee must be paid or waived.";
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

    if (["balance", "withdraw", "withdrawals", "guests-import", "guests-list", "fundraising", "fundraising-save", "campaigns", "campaigns-save"].includes(action)) {
      const weddingId = String(req.query.weddingId || body.weddingId || "");
      if (!UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
      const owned = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,currency`, opts);
      if (!owned?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const currency = owned[0].currency;

      if (action === "balance") {
        const rows = await supabaseRequest("/rest/v1/rpc/withdrawable_balance", { ...opts, method: "POST", body: { p_wedding_id: weddingId, p_currency: currency } });
        const r = rows?.[0] || {};
        return sendJson(res, 200, { currency, available_minor: Number(r.available_minor || 0), settling_minor: Number(r.settling_minor || 0), next_available_at: r.next_available_at || null });
      }
      if (action === "withdrawals") {
        const rows = await supabaseRequest(`/rest/v1/payout_records?wedding_id=eq.${weddingId}&select=id,amount_minor,currency,status,requested_at&order=requested_at.desc&limit=100`, opts);
        return sendJson(res, 200, { withdrawals: rows || [] });
      }
      if (action === "withdraw") {
        if (!methodOnly(req, res, "POST")) return;
        const amount = Number(body.amountMinor);
        if (!Number.isSafeInteger(amount) || amount < 1) return sendJson(res, 400, { error: "Enter a valid amount." });
        if (body.confirmed !== true) return sendJson(res, 400, { error: "Explicit confirmation is required." });
        try {
          const id = await supabaseRequest("/rest/v1/rpc/request_payout", { ...opts, method: "POST", body: {
            p_wedding_id: weddingId, p_amount_minor: amount, p_currency: currency, p_note: String(body.notes || "").slice(0, 240), p_confirmed: true } });
          return sendJson(res, 201, { payoutId: id });
        } catch (error) {
          return sendJson(res, 409, { error: error.message || "Payout could not be requested." });
        }
      }
      if (action === "guests-list") {
        const rows = await supabaseRequest(`/rest/v1/guests?wedding_id=eq.${weddingId}&select=id,name,email,phone,dietary_preference,table_number,rsvp_status&order=table_number,name&limit=2000`, opts);
        return sendJson(res, 200, { guests: rows || [] });
      }
      if (action === "guests-import") {
        if (!methodOnly(req, res, "POST")) return;
        const guests = (Array.isArray(body.guests) ? body.guests : []).slice(0, 2000).map(g => ({
          wedding_id: weddingId,
          name: String(g.name || "").trim().slice(0, 120),
          email: String(g.email || "").trim().toLowerCase().slice(0, 200) || null,
          phone: normalizePhone(g.phone) || null,
          dietary_preference: String(g.dietary || "").trim().slice(0, 50) || null,
          table_number: String(g.table || "").trim().slice(0, 20) || null
        })).filter(g => g.name);
        if (!guests.length) return sendJson(res, 400, { error: "No valid guests found." });
        await supabaseRequest(`/rest/v1/guests?wedding_id=eq.${weddingId}`, { ...opts, method: "DELETE", prefer: "return=minimal" });
        await supabaseRequest("/rest/v1/guests", { ...opts, method: "POST", body: guests, prefer: "return=minimal" });
        return sendJson(res, 201, { imported: guests.length });
      }
      if (action === "fundraising") {
        const [tiers, vip, sponsors] = await Promise.all([
          supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${weddingId}&select=id,name,min_amount_minor,perks,sort_order&order=sort_order`, opts),
          supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${weddingId}&select=id,title,description,seats_total,price_minor&limit=1`, opts),
          supabaseRequest(`/rest/v1/sponsors?wedding_id=eq.${weddingId}&select=id,company_name,contact_email,contact_phone,website,amount_minor,status,created_at&order=amount_minor.desc&limit=200`, opts)
        ]);
        return sendJson(res, 200, { tiers: tiers || [], vip: vip?.[0] || null, sponsors: sponsors || [] });
      }
      if (action === "campaigns") {
        if (!methodOnly(req, res, "GET")) return;
        const data = await supabaseRequest("/rest/v1/rpc/get_campaign_ledger", { service: true, method: "POST", body: { p_wedding_id: weddingId } });
        const streams = await supabaseRequest(`/rest/v1/fundraising_streams?wedding_id=eq.${weddingId}&select=id,name,purpose,goal_minor,enabled,sort_order&order=sort_order`, { service: true });
        const ms = await supabaseRequest(`/rest/v1/fundraising_milestones?wedding_id=eq.${weddingId}&select=id,stream_id,name,description,target_minor,sort_order&order=sort_order`, { service: true });
        const campaigns = (streams || []).map(s => ({ ...s, milestones: (ms || []).filter(m => m.stream_id === s.id) }));
        return sendJson(res, 200, { currency, campaigns, summary: data?.campaigns || [], rows: data?.rows || [] });
      }
      if (action === "campaigns-save") {
        if (!methodOnly(req, res, "POST")) return;
        const minor = v => Math.round(Number(v) * 100);
        const okAmt = n => Number.isSafeInteger(n) && n > 0 && n <= 100000000000;
        const list = Array.isArray(body.campaigns) ? body.campaigns.slice(0, 6) : [];
        const payload = [];
        for (const c of list) {
          const name = String(c.name || "").trim().slice(0, 100);
          if (!name) continue;
          const goal = minor(c.goal);
          if (!okAmt(goal)) return sendJson(res, 400, { error: `Set a goal amount for "${name}".` });
          const milestones = [];
          for (const m of (Array.isArray(c.milestones) ? c.milestones.slice(0, 10) : [])) {
            const mn = String(m.name || "").trim().slice(0, 100);
            if (!mn) continue;
            const t = minor(m.target);
            if (!okAmt(t)) return sendJson(res, 400, { error: `Set a target amount for milestone "${mn}".` });
            milestones.push({ id: m.id || null, name: mn, description: String(m.description || "").slice(0, 240), target_minor: t });
          }
          payload.push({ id: c.id || null, name, purpose: String(c.purpose || "").slice(0, 240), goal_minor: goal, enabled: c.enabled !== false, milestones });
        }
        await supabaseRequest("/rest/v1/rpc/save_fundraising_campaigns", { service: true, method: "POST", body: { p_wedding_id: weddingId, p_payload: payload } });
        return sendJson(res, 200, { saved: true });
      }
      if (action === "fundraising-save") {
        if (!methodOnly(req, res, "POST")) return;
        const tiers = (Array.isArray(body.tiers) ? body.tiers : []).slice(0, 6).map((t, i) => ({
          wedding_id: weddingId, name: String(t.name || "").trim().slice(0, 60),
          min_amount_minor: Math.round(Number(t.minAmount) * 100), perks: String(t.perks || "").trim().slice(0, 240) || "Recognised as a supporter", sort_order: i
        })).filter(t => t.name && Number.isSafeInteger(t.min_amount_minor) && t.min_amount_minor > 0);
        await supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${weddingId}`, { ...opts, method: "DELETE", prefer: "return=minimal" });
        if (tiers.length) await supabaseRequest("/rest/v1/sponsor_tiers", { ...opts, method: "POST", body: tiers, prefer: "return=minimal" });
        const v = body.vip;
        await supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${weddingId}`, { ...opts, method: "DELETE", prefer: "return=minimal" });
        if (v && Number(v.seats) > 0 && Number(v.price) > 0) {
          await supabaseRequest("/rest/v1/vip_offers", { ...opts, method: "POST", prefer: "return=minimal", body: {
            wedding_id: weddingId, title: String(v.title || "VIP seating").slice(0, 80), description: String(v.description || "").slice(0, 240),
            seats_total: Math.min(Math.floor(Number(v.seats)), 500), price_minor: Math.round(Number(v.price) * 100) } });
        }
        return sendJson(res, 200, { saved: true });
      }
    }

    if (action === "rsvps") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/guest_rsvps?wedding_id=eq.${req.query.weddingId}&select=id,guest_name,guest_email,phone,attendance_status,dietary_notes,plus_one_count,party_names,created_at,rsvped_at,checked_in_at&order=created_at.desc&limit=200`, opts);
      return sendJson(res, 200, { rsvps: (rows || []).map(r => isPhoneKeyEmail(r.guest_email) ? { ...r, guest_email: "" } : r) });
    }

    if (action === "bids") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/dj_song_bids?wedding_id=eq.${req.query.weddingId}&select=id,song_title,artist_name,bid_amount_minor,bidder_name,currency,rank_position,created_at&order=bid_amount_minor.desc,created_at.asc&limit=200`, opts);
      return sendJson(res, 200, { bids: rows || [] });
    }

    const wid = String(req.query.weddingId || body.weddingId || "");
    if (["referrals", "analytics", "wishes-list", "wish-moderate", "extras-get", "extras-save"].includes(action) && !UUID.test(wid)) {
      return sendJson(res, 400, { error: "Invalid wedding." });
    }

    if (action === "referrals") {
      if (!methodOnly(req, res, "GET")) return;
      const rows = await supabaseRequest("/rest/v1/rpc/referral_summary", { ...opts, method: "POST", body: { p_wedding_id: wid } });
      return sendJson(res, 200, { referrals: rows || [] });
    }

    if (action === "analytics") {
      if (!methodOnly(req, res, "GET")) return;
      const result = await supabaseRequest("/rest/v1/rpc/wedding_analytics", { ...opts, method: "POST", body: { p_wedding_id: wid } });
      return sendJson(res, 200, { analytics: result || {} });
    }

    if (action === "wishes-list") {
      if (!methodOnly(req, res, "GET")) return;
      const rows = await supabaseRequest(`/rest/v1/guest_wishes?wedding_id=eq.${wid}&select=id,author_name,message,status,created_at&order=created_at.desc&limit=200`, opts);
      return sendJson(res, 200, { wishes: rows || [] });
    }

    if (action === "wish-moderate") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.wishId || "")) || !["approved", "hidden", "pending"].includes(body.status)) return sendJson(res, 400, { error: "Invalid request." });
      await supabaseRequest(`/rest/v1/guest_wishes?id=eq.${body.wishId}&wedding_id=eq.${wid}`, { ...opts, method: "PATCH", prefer: "return=minimal", body: { status: body.status } });
      return sendJson(res, 200, { ok: true });
    }

    if (action === "extras-get") {
      if (!methodOnly(req, res, "GET")) return;
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${wid}&select=faq,travel_info`, opts);
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      return sendJson(res, 200, { faq: rows[0].faq || [], travel: rows[0].travel_info || "" });
    }

    if (action === "extras-save") {
      if (!methodOnly(req, res, "POST")) return;
      const faq = (Array.isArray(body.faq) ? body.faq : []).slice(0, 12)
        .map(f => ({ q: String(f?.q || "").trim().slice(0, 160), a: String(f?.a || "").trim().slice(0, 600) }))
        .filter(f => f.q && f.a);
      const travel = String(body.travel || "").trim().slice(0, 2000);
      await supabaseRequest(`/rest/v1/weddings?id=eq.${wid}&client_owner_id=eq.${encodeURIComponent(session.user.id)}`, { ...opts, method: "PATCH", prefer: "return=minimal", body: { faq, travel_info: travel || null } });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    // Log full error for debugging but never expose secrets
    const errorMsg = error.message || error.toString();
    console.error("weddings endpoint error:", {
      action,
      statusCode: error.status,
      message: errorMsg,
      code: error.code
    });

    // Provide specific error messages instead of generic ones
    let userMessage = "The request could not be completed.";
    if (errorMsg.includes("relation does not exist")) {
      userMessage = "Database table not found. Platform is not fully initialized. Contact admin.";
    } else if (errorMsg.includes("permission denied") || errorMsg.includes("RLS")) {
      userMessage = "You don't have permission to access this resource.";
    } else if (errorMsg.includes("connection refused") || errorMsg.includes("timeout")) {
      userMessage = "Database service is temporarily unavailable. Please try again.";
    } else if (errorMsg.includes("invalid token") || errorMsg.includes("unauthorized")) {
      userMessage = "Your session has expired. Please sign in again.";
    } else if (error.status === 404) {
      userMessage = error.message || "Resource not found.";
    } else if (error.status && error.status >= 400 && error.status < 500) {
      userMessage = error.message || "Invalid request.";
    }

    return sendJson(res, error.status && error.status < 500 ? error.status : 503, { error: userMessage });
  }
}
