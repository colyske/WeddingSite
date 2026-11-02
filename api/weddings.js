import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";
import { referralError } from "../server/referral-errors.js";
import handleReferrals from "../server/referrals.js";
import { paymentAdaptersFor } from "./checkout.js";
import { normalizePhone, isPhoneKeyEmail } from "../server/phone.js";
import { isReservedLabel } from "../server/site-hosts.js";
import { isShowcase } from "../server/showcase.js";
import { contentError } from "../server/content-policy.js";
import { handlePublicationPayment } from "../server/publication-payments.js";
import { publicationQuote } from "../server/publication-fx.js";
import { collectionCapabilities } from "../server/collection-capabilities.js";
import "../currencies.js";
import "../inspiration-fixtures.js";
import { publicWeddingStyle } from "../server/wedding-style.js";
import "../starter-setup.js";
import { starterCapabilities } from "../server/starter-capabilities.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const NAMED_COLORS = [
  ["Forest Green", "#244b3a"], ["Eucalyptus Sage", "#a9b5a2"], ["Royal Gold", "#be9b52"], ["Ivory", "#eee8d9"],
  ["Black", "#000000"], ["White", "#ffffff"], ["Charcoal", "#36454f"], ["Navy", "#000080"],
  ["Royal Blue", "#4169e1"], ["Sky Blue", "#87ceeb"], ["Teal", "#008080"], ["Turquoise", "#40e0d0"],
  ["Sage Green", "#9caf88"], ["Olive Green", "#808000"], ["Forest Green", "#228b22"], ["Mint", "#98ff98"],
  ["Burgundy", "#800020"], ["Crimson", "#dc143c"], ["Rose", "#ff007f"], ["Blush Pink", "#de5d83"],
  ["Lavender", "#e6e6fa"], ["Purple", "#800080"], ["Plum", "#8e4585"], ["Orange", "#ffa500"],
  ["Coral", "#ff7f50"], ["Terracotta", "#e2725b"], ["Mustard", "#ffdb58"], ["Gold", "#ffd700"],
  ["Beige", "#f5f5dc"], ["Taupe", "#483c32"], ["Brown", "#8b4513"], ["Silver", "#c0c0c0"]
];
const colorHexForName = name => {
  const normalized = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return NAMED_COLORS.find(([label]) => label.toLowerCase() === normalized)?.[1] || null;
};
const friendlyColorName = hex => {
  const rgb = String(hex).slice(1).match(/.{2}/g)?.map(value => parseInt(value, 16)) || [];
  if (rgb.length !== 3) return "";
  let closest = NAMED_COLORS[0], distance = Infinity;
  for (const candidate of NAMED_COLORS) {
    const values = candidate[1].slice(1).match(/.{2}/g).map(value => parseInt(value, 16));
    const next = values.reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0);
    if (next < distance) { distance = next; closest = candidate; }
  }
  return closest[0];
};
const toSlug = text => String(text).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const FIELDS = "id,slug,couple_names,welcome_story,cover_image_url,guest_instructions,starter_review_note,wedding_date,time_zone,public_location,currency,revenue_features,max_guest_capacity,palette,attire_notes,palette_names,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options,allow_in_kind_sponsorship,enabled_payment_methods,background_music_url,faq,travel_info,published_at,created_at,archived_at,unpublished_at,first_published_at,lifecycle_admin_restricted";
const REVENUE_FEATURES = ["giving", "sponsors", "featured_sponsors", "song_requests", "vip_seating"];
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
    for (const adapter of paymentAdaptersFor(currency, market)) {
      if (adapter.id !== "daraja") methods.set(adapter.id, adapter.name);
    }
  }
  return [...methods].map(([id, name]) => ({ id, name }));
};

const loadWeddingDetails = async (weddings, opts) => {
  const rows = Array.isArray(weddings) ? weddings : [weddings];
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const inFilter = `in.(${ids.map(encodeURIComponent).join(",")})`;
  const [venues, payouts, registry, tiers, vip, siteContent, campaigns, setupStatuses, featuredCampaigns, pendingStarters] = await Promise.all([
    supabaseRequest(`/rest/v1/venues?wedding_id=${inFilter}&select=id,wedding_id,name,event_time,event_date,map_link,description,is_main,kind,address,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/payout_preferences?wedding_id=${inFilter}&select=wedding_id,method,display_mask,verified`, opts),
    supabaseRequest(`/rest/v1/registry_items?wedding_id=${inFilter}&select=id,wedding_id,name,description,category,target_amount_minor,notes,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=${inFilter}&select=id,wedding_id,name,min_amount_minor,perks,sort_order&order=sort_order.asc`, opts),
    supabaseRequest(`/rest/v1/vip_offers?wedding_id=${inFilter}&select=id,wedding_id,title,description,seats_total,seats_sold,price_minor`, opts),
    supabaseRequest(`/rest/v1/guest_site_content?wedding_id=${inFilter}&select=wedding_id,story_draft,story_approved,travel_notes,travel_approved`, opts),
    supabaseRequest(`/rest/v1/fundraising_streams?wedding_id=${inFilter}&select=id,wedding_id,enabled`, opts),
    supabaseRequest("/rest/v1/rpc/get_wedding_setup_status", {
      ...opts, method: "POST", body: { p_wedding_ids: ids }
    }),
    supabaseRequest(`/rest/v1/sponsor_featured_campaigns?wedding_id=${inFilter}&select=wedding_id,enabled,starts_at,closes_at,slot_count,minimum_bid_minor,bid_increment_minor`, { service: true }),
    supabaseRequest(`/rest/v1/wedding_starter_pending?wedding_id=${inFilter}&select=wedding_id,setup`, opts)
  ]);
  return rows.map(row => ({
    ...row,
    starter_pending_setup: (pendingStarters || []).find(item => item.wedding_id === row.id)?.setup || null,
    venues: (venues || []).filter(item => item.wedding_id === row.id),
    payout: (payouts || []).find(item => item.wedding_id === row.id) || null,
    registry: (registry || []).filter(item => item.wedding_id === row.id),
    tiers: (tiers || []).filter(item => item.wedding_id === row.id),
    vip: (vip || []).find(item => item.wedding_id === row.id) || null,
    siteContent: (siteContent || []).find(item => item.wedding_id === row.id) || {},
    campaigns: (campaigns || []).filter(item => item.wedding_id === row.id),
    featuredSponsorCampaign: (featuredCampaigns || []).find(item => item.wedding_id === row.id) || null,
    kyc_submitted: (setupStatuses || []).some(item => item.wedding_id === row.id && item.kyc_submitted === true)
  }));
};

// Authenticated Client workspace API. All reads/writes run as the signed-in user so RLS applies.
export default async function handler(req, res) {
  if (req.query?.client_referrals === "1") return handleReferrals(req, res);
  const session = await requireAuth(req, res);
  if (!session) return;
  const opts = { token: session.token };
  const action = String(req.query?.action || "list");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (action === "collection-capabilities") {
    if (!methodOnly(req, res, "GET")) return;
    const weddingId = String(req.query.weddingId || "");
    if (weddingId && !UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
    if (weddingId) {
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id`,
        opts
      );
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
    }
    try {
      return sendJson(res, 200, { currencies: await collectionCapabilities({ weddingId: weddingId || null }) });
    } catch (error) {
      console.error("Wedding payment currency capabilities unavailable:", error.message);
      return sendJson(res, 503, {
        error: "We could not check which guest-payment options are ready right now. Your saved wedding currency and answers are safe; try checking again later."
      });
    }
  }
  if (["publication-options", "publication-create", "publication-status"].includes(action)) {
    return handlePublicationPayment(req, res, session, action);
  }

  try {
    const invalidContent = req.method === "POST" && contentError(body);
    if (invalidContent) return sendJson(res, 400, { error: invalidContent });
    if (action === "starter-review") {
        if (!methodOnly(req, res, "POST")) return;
        if (!UUID.test(String(body.weddingId || "")) || !UUID.test(String(body.requestKey || "")) ||
            !["apply", "omit"].includes(body.decision) || body.reviewed !== true ||
            !globalThis.WSCurrencies.supportsAccounting(body.currency)) {
          return sendJson(res, 400, { error: "Review the starter and choose whether to apply or leave out its prices." });
        }
        const current = (await supabaseRequest(
          `/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,currency,published_at`, opts))?.[0];
        if (!current) return sendJson(res, 404, { error: "Wedding not found." });
        const pending = (await supabaseRequest(
          `/rest/v1/wedding_starter_pending?wedding_id=eq.${body.weddingId}&select=setup`, opts))?.[0]?.setup;
        const input = { currency: body.currency, decision: body.decision, reviewed: true };
        const prior = await supabaseRequest(`/rest/v1/wedding_starter_reviews?wedding_id=eq.${body.weddingId}&select=request_key&limit=1`, { service: true });
        if (!prior?.length) {
          if (!pending || current.published_at || current.currency !== body.currency) {
            return sendJson(res, 409, { error: "Your saved wedding changed. Reload the currency step before reviewing the starter." });
          }
          if (body.decision === "apply") {
            if (pending.currency !== body.currency) {
              return sendJson(res, 409, { error: "The source prices use a different currency. Keep personalizing, or explicitly leave those prices out; they cannot be converted or relabelled." });
            }
            const supported = await starterCapabilities(undefined, { weddingId: body.weddingId });
            if (!supported.some(item => item.code === body.currency)) {
              return sendJson(res, 409, { error: "Guest-payment collection is not ready in this currency yet. Your source settings are kept for later review; you can keep personalizing." });
            }
          }
        }
        const result = await supabaseRequest("/rest/v1/rpc/review_deferred_wedding_starter", {
          service: true, method: "POST", body: { p_owner: session.user.id, p_wedding_id: body.weddingId,
            p_request_key: body.requestKey, p_input: input }
        });
        return sendJson(res, 200, result);
    }
    if (action === "paystack-onboarding" || action === "paystack-consent") {
      if (!methodOnly(req, res, action === "paystack-consent" ? "POST" : "GET")) return;
      const weddingId = action === "paystack-consent" ? body.weddingId : req.query.weddingId;
      if (!UUID.test(weddingId || "") || (action === "paystack-consent" &&
          (!UUID.test(body.revision || "") || body.confirmed !== true))) {
        return sendJson(res, 400, { error: "Confirm the current verified Paystack destination." });
      }
      if (action === "paystack-consent") {
        await supabaseRequest("/rest/v1/rpc/consent_paystack_destination", {
          ...opts, method: "POST", body: { p_wedding_id: weddingId, p_revision: body.revision, p_confirmed: true }
        });
      }
      const onboarding = await supabaseRequest("/rest/v1/rpc/paystack_destination_status", {
        ...opts, method: "POST", body: { p_wedding_id: weddingId }
      });
      const settlements = await supabaseRequest("/rest/v1/rpc/paystack_finance_summary", {
        ...opts, method: "POST", body: { p_wedding_id: weddingId }
      });
      return sendJson(res, 200, { onboarding, settlements });
    }
    if (action === "list") {
      if (!methodOnly(req, res, "GET")) return;
      const rows = await supabaseRequest(
        `/rest/v1/weddings?client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}&order=created_at.desc&limit=50`, opts);
      return sendJson(res, 200, { weddings: await loadWeddingDetails(rows || [], opts) });
    }

    if (action === "get") {
      if (!methodOnly(req, res, "GET")) return;
      if (!UUID.test(String(req.query.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${req.query.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`, opts);
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const [wedding] = await loadWeddingDetails(rows, opts);
      const moderation = await supabaseRequest("/rest/v1/rpc/wedding_moderation_status", {
        ...opts, method: "POST", body: { p_wedding_id: req.query.weddingId } });
      return sendJson(res, 200, { wedding: { ...wedding, moderation: moderation || null } });
    }

    if (action === "moderation-correction") {
      if (!methodOnly(req, res, "POST")) return;
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!UUID.test(String(body.caseId || "")) || !Number.isSafeInteger(body.expectedRevision)) {
        return sendJson(res, 400, { error: "Reload the page and try again." });
      }
      if (note.length < 10 || note.length > 2000) return sendJson(res, 400, { error: "Describe what you corrected in 10 to 2000 characters." });
      const result = await supabaseRequest("/rest/v1/rpc/submit_moderation_correction", { ...opts, method: "POST",
        body: { p_case_id: body.caseId, p_note: note, p_expected_revision: body.expectedRevision } });
      return sendJson(res, 200, { ok: true, case: result });
    }

    if (action === "create") {
      if (!methodOnly(req, res, "POST")) return;
      if (body.styleSlug !== undefined) {
        if (body.inspirationId !== undefined || !globalThis.WSCurrencies.supportsAccounting(body.currency)) {
          return sendJson(res, 400, { error: "Choose one style source and your own supported accounting currency." });
        }
        if (typeof body.styleSlug !== "string" || !/^[a-z0-9-]{3,80}$/.test(body.styleSlug)) return sendJson(res, 400, { error: "Choose an eligible public wedding style." });
      }
      if (body.inspirationId !== undefined && (!globalThis.WSInspiration.get(body.inspirationId) ||
          !globalThis.WSCurrencies.supportsAccounting(body.currency))) {
        return sendJson(res, 400, { error: "Choose a listed fictional inspiration style and your own supported accounting currency." });
      }
      const hasStarterSource = body.inspirationId !== undefined || body.styleSlug !== undefined;
      const deferredStarter = hasStarterSource && body.starterDeferred === true;
      let starterSetup;
      if (hasStarterSource || body.starterSetup !== undefined) {
        if (!hasStarterSource) return sendJson(res, 400, { error: "Choose an eligible inspiration source for starter configuration." });
        try {
          // Validate the source structure without treating it as accepted money.
          starterSetup = globalThis.WSStarterSetup.normalize(
            deferredStarter ? { ...body.starterSetup, reviewed: true } : body.starterSetup, body.currency);
        }
        catch (error) { return sendJson(res, 400, { error: error.message, field: "starter-setup" }); }
        const invalidStarter = contentError(starterSetup);
        if (invalidStarter) return sendJson(res, 400, { error: invalidStarter, field: "starter-setup" });
      }
      if (body.referral !== undefined && body.referral !== null &&
          (typeof body.referral !== "object" || Array.isArray(body.referral) ||
            !UUID.test(String(body.referral.intentId || "")) ||
            !UUID.test(String(body.referral.revision || "")) ||
            !["accept", "decline"].includes(body.referral.decision) ||
            body.referral.termsVersion !== "client-referrals-v1")) {
        return sendJson(res, 400, { error: "Review the referral disclosure and choose accept or decline." });
      }
      if (!UUID.test(String(body.requestKey || ""))) return sendJson(res, 400, { error: "A stable create request key is required." });
      if (body.referral !== undefined && body.referral !== null &&
          (!UUID.test(String(body.referral.intentId || "")) || !UUID.test(String(body.referral.revision || "")) ||
            !["accept", "decline"].includes(body.referral.decision) || body.referral.termsVersion !== "client-referrals-v1")) {
        return sendJson(res, 400, { error: "Review the current referral disclosure and choose accept or decline." });
      }
      const names = String(body.coupleNames || "").trim();
      const location = String(body.location || "").trim();
      const palette = Array.isArray(body.palette)
        ? body.palette.map(color => typeof color === "string" ? color.trim().toLowerCase() : "")
        : ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"];
      const capacity = Number(body.maxCapacity ?? 150);
      const currency = String(body.currency || "USD").toUpperCase();
      let venues;
      if (body.venues != null && (!Array.isArray(body.venues) || body.venues.length > 30)) return sendJson(res, 400, { error: "Use a list of up to 30 events." });
      try {
        venues = (Array.isArray(body.venues) ? body.venues : []).slice(0, 30).map((venue, sortOrder) => ({
          name: String(venue?.name || "").trim().slice(0, 100),
          eventTime: parseVenueTime(venue?.eventTime ?? venue?.time),
          eventDate: venue?.eventDate || body.weddingDate || null,
          address: String(venue?.address || "").trim().slice(0, 200) || null,
          mapLink: String(venue?.mapLink ?? venue?.map ?? "").trim() || null,
          description: String(venue?.description || "").trim().slice(0, 500) || null,
          isMain: venue?.isMain === true,
          kind: venue?.kind === "pre" ? "pre" : "main",
          sortOrder
        })).filter(venue => venue.name || venue.eventTime || venue.eventDate || venue.address || venue.mapLink || venue.description);
      } catch (error) {
        return sendJson(res, 400, { error: error.message || "Check the venue details.", field: "venues" });
      }
      if (venues.some(venue => venue.mapLink && !/^https?:\/\//i.test(venue.mapLink))) {
        return sendJson(res, 400, { error: "Venue map links must use HTTP or HTTPS." });
      }
      if (venues.some(venue => venue.eventDate && !validDate(venue.eventDate))) {
        return sendJson(res, 400, { error: "Enter real event dates in YYYY-MM-DD format.", field: "venues" });
      }
      if ((!deferredStarter && names.length < 1) || names.length > 120 || location.length > 120 || !globalThis.WSCurrencies.supportsAccounting(currency) ||
          !Number.isInteger(capacity) || capacity < 1 || palette.length > 4 || !palette.every(c => COLOR.test(c))) {
        return sendJson(res, 400, { error: "Check the couple names, location, currency, guest capacity and up to four hex colors." });
      }
      if (body.weddingDate !== undefined && body.weddingDate !== null && body.weddingDate !== "" && !validDate(body.weddingDate)) return sendJson(res, 400, { error: "Enter a real wedding date (YYYY-MM-DD), or leave it unanswered." });
      const slugRoot = toSlug(names) || "wedding";
      const base = isReservedLabel(slugRoot) || isShowcase(slugRoot) ? `${slugRoot}-wedding` : slugRoot;
      if (body.timeZone !== undefined && body.timeZone !== null && body.timeZone !== "" && !validZone(body.timeZone)) {
        return sendJson(res, 400, { error: "Choose a valid time zone." });
      }
      const timeZone = validZone(body.timeZone) ? body.timeZone : DEFAULT_ZONE;
      for (const suffix of ["", `-${Math.random().toString(36).slice(2, 6)}`, `-${Math.random().toString(36).slice(2, 8)}`]) {
        try {
          const createBody = {
            p_request_key: body.requestKey,
            p_input: {
              slug: `${base}${suffix}`.slice(0, 80).padEnd(3, "x"), coupleNames: names,
              weddingDate: body.weddingDate || null, location: location || null,
              currency, maxCapacity: capacity, palette, venues, timeZone,
              paletteNames: palette.map(friendlyColorName), referral: body.referral || null,
              ...(starterSetup ? { starterSetup, ...(deferredStarter ? { starterDeferred: true } : {}) } : {})
            }
          };
          const path = `/rest/v1/rpc/${deferredStarter ? "create_deferred_wedding_starter" : starterSetup ? "create_wedding_from_starter" : "create_wedding_draft"}`;
          let created;
          try { created = await supabaseRequest(path, { ...opts, method: "POST", body: createBody }); }
          catch (error) {
            if (!starterSetup || !(deferredStarter ? /STARTER_SOURCE_REQUIRED:/ : /STARTER_CAPABILITY_REQUIRED:/).test(error.message)) throw error;
            if (body.styleSlug && !await publicWeddingStyle(body.styleSlug)) {
              return sendJson(res, 400, { error: "This wedding is no longer available for public setup reuse. Choose another style." });
            }
            if (!deferredStarter) {
              const supported = await starterCapabilities();
              if (!supported.some(item => item.code === currency)) {
                return sendJson(res, 400, { error: "Choose a currency currently supported for guest-payment collection.", field: "starter-setup" });
              }
            }
            await supabaseRequest(`/rest/v1/rpc/${deferredStarter ? "stage_wedding_starter_source" : "stage_wedding_starter_capability"}`, { service: true, method: "POST",
              body: { p_owner: session.user.id, p_request_key: body.requestKey, p_input: createBody.p_input } });
            created = await supabaseRequest(path, { ...opts, method: "POST", body: createBody });
          }
          return sendJson(res, 201, created);
        } catch (error) {
          if (/REFERRAL_CONFLICT:|Self referral|Invalid or withdrawn referral code/.test(error.message)) {
            const [status, message] = referralError(error);
            return sendJson(res, status, { error: message,
              ...(/REFERRAL_CONFLICT:/.test(error.message) ? { code: "REFERRAL_CONFLICT" } : {}) });
          }
          if (!/duplicate|unique/i.test(error.message)) throw error;
        }
      }
      return sendJson(res, 409, { error: "That web address is taken. Try different names." });
    }

    if (action === "update") {
      if (!methodOnly(req, res, "POST")) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const patch = {};
      let baseCurrency = null;
      if (body.currency !== undefined) {
        const current = (await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=currency`, opts))?.[0];
        if (!current) return sendJson(res, 404, { error: "Wedding not found." });
        baseCurrency = current.currency;
      }
      let normalizedVenues = null;
      if (body.venues !== undefined) {
        if (body.venues !== null && (!Array.isArray(body.venues) || body.venues.length > 30)) return sendJson(res, 400, { error: "Use a list of up to 30 events, or null to clear." });
        try {
          normalizedVenues = (body.venues || []).slice(0, 30).map((v, sortOrder) => ({
            id: v?.id || null,
            name: String(v?.name || "").trim().slice(0, 100),
            eventTime: parseVenueTime(v?.eventTime ?? v?.time),
            eventDate: v?.eventDate || null,
            mapLink: String(v?.mapLink ?? v?.map ?? "").trim() || null,
            description: String(v?.description || "").trim().slice(0, 500) || null,
            isMain: v?.isMain === true && v?.kind !== "pre",
            kind: v?.kind === "pre" ? "pre" : "main",
            address: String(v?.address || "").trim().slice(0, 200) || null,
            sortOrder
          }));
          normalizedVenues.forEach((venue, index) => {
            const source = body.venues[index];
            if (venue.id && !UUID.test(String(venue.id))) throw new Error("Reload the event list before saving.");
            if (source.eventDate !== undefined && source.eventDate !== null && source.eventDate !== "" && !validDate(source.eventDate)) throw new Error("Enter a real event date, or clear it on a draft.");
            if (venue.id) {
              for (const [key, aliases] of Object.entries({
                name: ["name"], eventTime: ["eventTime", "time"], eventDate: ["eventDate"],
                mapLink: ["mapLink", "map"], description: ["description"],
                address: ["address"], kind: ["kind"], isMain: ["isMain"]
              })) {
                if (!aliases.some(alias => Object.hasOwn(source, alias))) delete venue[key];
              }
            }
          });
          if (normalizedVenues.some(v => v.eventDate && !validDate(v.eventDate))) {
            return sendJson(res, 400, { error: "Enter real event dates in YYYY-MM-DD format.", field: "venues" });
          }
          if (normalizedVenues.some(v => v.mapLink && !/^https?:\/\//i.test(v.mapLink))) {
            return sendJson(res, 400, { error: "Venue map links must use HTTP or HTTPS." });
          }
        } catch (error) {
          return sendJson(res, 400, { error: error.message || "Check the venue details.", field: "venues" });
        }
      }
      
      // Handle slug updates with uniqueness validation
      if (body.slug !== undefined) {
        const newSlug = String(body.slug ?? "").trim().toLowerCase();
        if (newSlug && !/^[a-z0-9-]{3,80}$/.test(newSlug)) {
          return sendJson(res, 400, { error: "Slug must be 3-80 lowercase letters, numbers, and hyphens." });
        }
        const reserved = ["admin", "api", "auth", "dashboard", "signin", "guest", "demo", "form-diagnostics", "index", "showcase-wedding"];
        if (newSlug && (reserved.includes(newSlug) || isReservedLabel(newSlug))) {
          return sendJson(res, 400, { error: "That web address is reserved. Please choose a different one." });
        }
        if (!newSlug) patch.slug = null;
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
      
      if (body.coupleNames !== undefined) {
        if (typeof body.coupleNames !== "string" || !body.coupleNames.trim()) return sendJson(res, 400, { error: "Couple names are required.", field: "couple-names" });
        patch.couple_names = body.coupleNames.trim().slice(0, 120);
      }
      if (body.welcomeStory !== undefined) patch.welcome_story = String(body.welcomeStory ?? "").slice(0, 500);
      if (body.coverImageUrl !== undefined) {
        const value = String(body.coverImageUrl ?? "").trim();
        if (value) {
          let url;
          try { url = new URL(value); } catch { return sendJson(res, 400, { error: "Use a public HTTPS photo link.", field: "cover-image-url" }); }
          if (url.protocol !== "https:" || url.username || url.password || value.length > 2048) {
            return sendJson(res, 400, { error: "Use a public HTTPS photo link without a username or password.", field: "cover-image-url" });
          }
          patch.cover_image_url = url.toString();
        } else patch.cover_image_url = null;
      }
      if (body.guestInstructions !== undefined) patch.guest_instructions = String(body.guestInstructions ?? "").trim().slice(0, 1000) || null;
      if (body.weddingDate !== undefined) {
        if (body.weddingDate !== null && body.weddingDate !== "" && !validDate(body.weddingDate)) return sendJson(res, 400, { error: "Enter a real wedding date (YYYY-MM-DD), or clear it on a draft.", field: "wedding-date" });
        patch.wedding_date = body.weddingDate || null;
      }
      if (body.timeZone !== undefined) {
        if (!validZone(body.timeZone)) return sendJson(res, 400, { error: "Choose a valid time zone." });
        patch.time_zone = body.timeZone;
      }
      if (body.location !== undefined) patch.public_location = String(body.location ?? "").trim().slice(0, 120) || null;
      if (body.maxCapacity !== undefined) {
        const capacity = Number(body.maxCapacity);
        if (!Number.isInteger(capacity) || capacity < 1) return sendJson(res, 400, { error: "Capacity must be a whole number." });
        patch.max_guest_capacity = capacity;
      }
      if (body.currency !== undefined) {
        const currency = String(body.currency).toUpperCase();
        if (!globalThis.WSCurrencies.supportsAccounting(currency)) return sendJson(res, 400, { error: "Choose a supported two-decimal wedding currency. Other currency exponents are display-only." });
        patch.currency = currency;
      }
      if (body.palette !== undefined) {
        const palette = Array.isArray(body.palette)
          ? body.palette.map(color => typeof color === "string" ? color.trim().toLowerCase() : "")
          : null;
        if (!palette || palette.length > 4 || !palette.every(c => COLOR.test(c))) {
          return sendJson(res, 400, { error: "Choose up to four valid hex colors." });
        }
        patch.palette = palette;
      }
      if (body.paletteNames !== undefined) {
        const names = Array.isArray(body.paletteNames) ? body.paletteNames : [];
        patch.palette_names = (patch.palette || []).map((color, index) =>
          String(names[index] || "").trim().slice(0, 40) || friendlyColorName(color)
        );
      } else if (patch.palette) {
        patch.palette_names = patch.palette.map(friendlyColorName);
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
      if (body.allowInKindSponsorship !== undefined) {
        if (body.allowInKindSponsorship !== false) return sendJson(res, 400, { error: "Free and in-kind sponsorship enquiries are no longer available." });
        patch.allow_in_kind_sponsorship = false;
      }
      if (body.backgroundMusicUrl !== undefined) {
        const url = String(body.backgroundMusicUrl).trim();
        patch.background_music_url = url ? url.slice(0, 500) : null;
      }
      let revenueFeatures;
      if (body.revenueFeatures !== undefined) {
        revenueFeatures = body.revenueFeatures;
        if (!revenueFeatures || typeof revenueFeatures !== "object" || Array.isArray(revenueFeatures) ||
            Object.keys(revenueFeatures).length !== REVENUE_FEATURES.length ||
            REVENUE_FEATURES.some(key => typeof revenueFeatures[key] !== "boolean")) {
          return sendJson(res, 400, { error: "Choose whether each guest feature is shown." });
        }
        patch.revenue_features = revenueFeatures;
      }
      if (!Object.keys(patch).length && normalizedVenues === null) return sendJson(res, 400, { error: "Nothing valid to update." });
      const updated = await supabaseRequest("/rest/v1/rpc/save_wedding_content", { ...opts, method: "POST", body: {
        p_wedding_id: body.weddingId, p_patch: patch, p_venues: normalizedVenues,
        p_expected_currency: baseCurrency, p_expected_presets: body.amountPresetsBase ?? null
      } });
      const rows = [updated];

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

      if (body.featuredSponsorCampaign) {
        const campaign = body.featuredSponsorCampaign;
        const positiveMoney = value => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1000000000;
        const slotCount = Number(campaign.slotCount);
        const startsAt = typeof campaign.startsAt === "string" && campaign.startsAt ? new Date(campaign.startsAt) : null;
        const closesAt = typeof campaign.closesAt === "string" && campaign.closesAt ? new Date(campaign.closesAt) : null;
        if (campaign.enabled === true && (!startsAt || !closesAt || !Number.isFinite(startsAt.getTime()) ||
            !Number.isFinite(closesAt.getTime()) || closesAt <= startsAt ||
            !Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > 20 ||
            !positiveMoney(campaign.minimumBid) || Math.round(Number(campaign.minimumBid) * 100) < 1 ||
            !positiveMoney(campaign.bidIncrement) || Math.round(Number(campaign.bidIncrement) * 100) < 1)) {
          return sendJson(res, 400, { error: "Enter a valid campaign window, 1–20 slots, minimum bid and bid increment." });
        }
        await supabaseRequest("/rest/v1/rpc/save_sponsor_featured_campaign", {
          ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_data: {
            enabled: campaign.enabled === true,
            starts_at: startsAt?.toISOString() || null,
            closes_at: closesAt?.toISOString() || null,
            slot_count: slotCount,
            minimum_bid_minor: positiveMoney(campaign.minimumBid) ? Math.round(Number(campaign.minimumBid) * 100) : null,
            bid_increment_minor: positiveMoney(campaign.bidIncrement) ? Math.round(Number(campaign.bidIncrement) * 100) : null
          } }
        });
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
            return sendJson(res, 400, { error: "Choose a payout method currently configured by Join Our Wedding." });
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
      
      const [updatedWedding] = await loadWeddingDetails(rows, opts);
      return sendJson(res, 200, { wedding: updatedWedding });
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
      const rows = await supabaseRequest(`/rest/v1/weddings?id=eq.${req.query.weddingId}&select=currency`, opts);
      if (!rows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const quote = await publicationQuote(req.query.weddingId, session.token, rows[0].currency);
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
      const ownerRows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,currency`, opts);
      if (!ownerRows?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const liveCurrencies = await collectionCapabilities({ weddingId: body.weddingId, record: true });
      if (!liveCurrencies.some(currency => currency.code === ownerRows[0].currency)) {
        return sendJson(res, 409, {
          error: "There is no currently ready guest-payment option for this wedding currency. Save your draft, choose a currency shown as available, or ask support to review payment availability. Nothing was enabled or converted.",
          missingFields: ["fundraising-route"]
        });
      }
      const missing = await supabaseRequest("/rest/v1/rpc/wedding_publication_readiness", {
        ...opts, method: "POST", body: { p_wedding_id: body.weddingId }
      });
      if (!Array.isArray(missing)) throw new Error("Publication readiness could not be checked.");
      if (missing.length) return sendJson(res, 409, {
        error: "Complete the required wedding details before publishing.", missingFields: missing
      });
      try {
        await supabaseRequest("/rest/v1/rpc/publish_wedding_with_fee", { ...opts, method: "POST", body: { p_wedding_id: body.weddingId, p_confirmed: true } });
      } catch (error) {
        const msg = error.message || "";
        let userMessage = msg;
        if (msg.includes("PAYMENT_REQUIRED")) {
          return sendJson(res, 402, { error: msg.replace(/^.*PAYMENT_REQUIRED:?\s*/, "").slice(0, 300) || "A publication fee is required.", paymentRequired: true });
        } else if (msg.includes("MODERATION_RESTRICTED")) {
          return sendJson(res, 409, { error: "Platform staff restricted this wedding. Review the reason, submit your correction, and an Admin will review it.", moderationRequired: true });
        } else if (/KYC|identity/i.test(msg)) {
          return sendJson(res, 409, { error: "Submit complete KYC details for both partners. Join Our Wedding does not independently verify identity documents.", kycRequired: true });
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
      const rows = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=${FIELDS}`, opts);
      const [publishedWedding] = await loadWeddingDetails(rows || [], opts);
      return sendJson(res, 200, { published: true, wedding: publishedWedding || null });
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

    if (["balance", "withdraw", "withdrawals", "guests-import", "guests-list", "fundraising", "fundraising-save", "campaigns", "campaigns-save", "sponsor-enquiries", "sponsor-enquiry-review"].includes(action)) {
      const weddingId = String(req.query.weddingId || body.weddingId || "");
      if (!UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
      const owned = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,currency`, opts);
      if (!owned?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const currency = owned[0].currency;

      if (action === "balance") {
        const rows = await supabaseRequest("/rest/v1/rpc/withdrawable_balance", { ...opts, method: "POST", body: { p_wedding_id: weddingId, p_currency: currency } });
        const r = rows?.[0] || {};
        return sendJson(res, 200, {
          currency, available_minor: Number(r.available_minor || 0), settling_minor: Number(r.settling_minor || 0),
          held_minor: Number(r.held_minor || 0), next_available_at: r.next_available_at || null
        });
      }
      if (action === "withdrawals") {
        const rows = await supabaseRequest(`/rest/v1/payout_records?wedding_id=eq.${weddingId}&select=id,amount_minor,currency,status,requested_at,staff_reason&order=requested_at.desc&limit=100`, opts);
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
          if (error.message?.includes("PAYOUT_KYC_REQUIRED")) {
            return sendJson(res, 409, {
              error: "Complete KYC to receive your payout.", kycRequired: true,
              kycUrl: `/wedding.html?id=${encodeURIComponent(weddingId)}#kyc-section`
            });
          }
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
          supabaseRequest(`/rest/v1/sponsors?wedding_id=eq.${weddingId}&select=id,company_name,contact_email,contact_phone,website,social_links,public_contact,amount_minor,status,in_kind,location,offer,created_at&order=amount_minor.desc&limit=200`, opts)
        ]);
        return sendJson(res, 200, { tiers: tiers || [], vip: vip?.[0] || null, sponsors: sponsors || [] });
      }
      if (action === "sponsor-enquiries") {
        if (!methodOnly(req, res, "GET")) return;
        const enquiries = await supabaseRequest(
          `/rest/v1/sponsor_enquiries?wedding_id=eq.${weddingId}&select=id,company_name,contact_name,contact_email,contact_phone,location,offer,in_kind,public_contact,status,created_at&order=created_at.desc&limit=200`,
          { service: true }
        );
        return sendJson(res, 200, { enquiries: enquiries || [] });
      }
      if (action === "sponsor-enquiry-review") {
        if (!methodOnly(req, res, "POST")) return;
        if (!UUID.test(String(body.enquiryId || "")) || !["approved", "declined"].includes(body.status)) {
          return sendJson(res, 400, { error: "Choose a valid sponsor enquiry and review decision." });
        }
        const approved = body.status === "approved";
        if (approved) return sendJson(res, 410, { error: "New in-kind sponsorship cannot be approved. Historical enquiries may be declined." });
        const result = await supabaseRequest("/rest/v1/rpc/review_sponsor_enquiry", {
          ...opts, method: "POST", body: { p_enquiry_id: body.enquiryId, p_approved: approved }
        });
        return sendJson(res, 200, { reviewed: Boolean(result), status: body.status });
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
      const rows = await supabaseRequest("/rest/v1/rpc/get_dj_bid_ledger", {
        ...opts, method: "POST", body: { p_wedding_id: req.query.weddingId }
      });
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
    if (["STARTER_DEPENDENCY", "STARTER_CAPABILITIES_UNAVAILABLE"].includes(error.code)) return sendJson(res, 503, { error: errorMsg });
    const moderation = errorMsg.match(/MODERATION(?:_RESTRICTED)?:\s*([^\n]{1,300})/);
    if (/CREATE_CONFLICT|DRAFT_CONFLICT|REFERRAL_CONFLICT/.test(errorMsg)) return sendJson(res, 409, { error: errorMsg.replace(/^.*(?:CREATE_CONFLICT|DRAFT_CONFLICT|REFERRAL_CONFLICT):\s*/, "") });
    if (errorMsg.includes("Self referral")) return sendJson(res, 403, { error: "Self referral is not allowed." });
    if (errorMsg.includes("PUBLISH_INCOMPLETE")) return sendJson(res, 409, {
      error: "Published wedding details must stay complete. Unpublish first if you need to clear them.",
      missingFields: (errorMsg.split("publishing:")[1] || "").split(",").map(field => field.trim()).filter(Boolean)
    });
    if (moderation) {
      return sendJson(res, 409, { error: moderation[1].trim(), moderationRequired: errorMsg.includes("MODERATION_RESTRICTED") });
    }
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
