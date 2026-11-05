// Only guest-visible content crosses into the renderer. Never spread a workspace record.
const pick = (record, keys) => Object.fromEntries(keys.map(key => [key, record?.[key] ?? null]));
const featureKeys = ["giving", "sponsors", "featured_sponsors", "song_requests", "vip_seating"];
export const permanentFeatures = Object.fromEntries(featureKeys.map(key => [key, true]));

// No foreign-currency fallback: KES is the showcase's accounting currency.
export function creationFundPreset(currency, setup) {
  if (currency === "KES") return 50000000;
  const amount = setup?.currency === currency ? setup.campaigns?.[0]?.goalMinor : null;
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000000 ? amount : null;
}

export function interactivePreview(wedding, campaigns = []) {
  const site = pick(wedding, [
    "id", "slug", "couple_names", "welcome_story", "cover_image_url", "guest_instructions",
    "wedding_date", "time_zone", "public_location", "currency", "palette", "palette_names",
    "attire_notes", "background_music_url", "max_guest_capacity", "rsvp_fee_minor",
    "extra_guest_fee_minor", "premium_diet_fee_minor", "premium_diet_options"
  ]);
  site.is_preview = true;
  site.interactive_creation = wedding.interactive_creation === true;
  site.revenue_features = wedding.interactive_creation ? permanentFeatures : wedding.revenue_features;
  site.venues = (wedding.venues || []).map(row => pick(row, [
    "id", "name", "event_time", "event_date", "map_link", "description", "is_main", "kind", "address", "sort_order"
  ]));
  site.registry = (wedding.registry || []).map(row => ({
    ...pick(row, ["id", "name", "description", "category", "target_amount_minor", "notes"]), amount_raised_minor: 0
  }));
  const structure = wedding.starter_structure;
  const funds = campaigns.map(row => ({
    ...pick(row, ["id", "name", "purpose", "goal_minor"]), raised_minor: 0, milestones: []
  }));
  if (!funds.length) funds.push({
    id: "incomplete-fund", name: structure?.campaigns?.[0]?.name || "Celebration fund",
    purpose: "Set a positive goal in your wedding currency before publishing.",
    goal_minor: null, raised_minor: 0, milestones: []
  });
  return {
    site: { wedding: site },
    fundraising: {
      campaigns: funds,
      tiers: (wedding.tiers || []).map(row => pick(row, ["id", "name", "min_amount_minor", "perks"])),
      vip: wedding.vip ? { ...pick(wedding.vip, ["id", "title", "description", "seats_total", "price_minor"]), seats_sold: 0 } : null,
      sponsors: [], sponsorAuction: null
    },
    extras: { faq: wedding.faq || [], travel: wedding.travel_info || "", wishes: [] },
    leaderboard: { bids: [] }, ledger: { ledger: [] }, "rsvp-count": { count: 0 }
  };
}
