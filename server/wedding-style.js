import { supabaseRequest } from "./supabase.js";
import { isShowcase, showcase, showcaseFundraising } from "./showcase.js";
import "../inspiration-fixtures.js";
import "../starter-setup.js";

export async function publicWeddingStyle(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9-]{3,80}$/.test(slug)) return null;
  // Only platform configuration already exposed on the public guest experience.
  const rows = isShowcase(slug) ? [showcase] : await supabaseRequest(
    `/rest/v1/weddings?slug=eq.${encodeURIComponent(slug)}&published_at=not.is.null&archived_at=is.null&lifecycle_admin_restricted=eq.false&select=id,palette,currency,revenue_features,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options&limit=1`,
    { service: true });
  if (!rows?.length) return null;
  const source = rows[0];
  const features = Object.fromEntries(globalThis.WSStarterSetup.featureKeys.map(key =>
    [key, source.revenue_features?.[key] !== false]));
  const [tiers, campaigns, registry, vip, events, featured] = isShowcase(slug)
    ? [showcaseFundraising.tiers, showcaseFundraising.campaigns, showcase.registry, [showcaseFundraising.vip], showcase.venues, []]
    : await Promise.all([
    features.sponsors ? supabaseRequest(`/rest/v1/sponsor_tiers?wedding_id=eq.${source.id}&select=min_amount_minor&order=sort_order&limit=6`, { service: true }) : [],
    features.giving ? supabaseRequest(`/rest/v1/fundraising_streams?wedding_id=eq.${source.id}&enabled=eq.true&select=id,goal_minor&order=sort_order&limit=6`, { service: true }) : [],
    features.giving ? supabaseRequest(`/rest/v1/registry_items?wedding_id=eq.${source.id}&select=target_amount_minor&order=sort_order&limit=20`, { service: true }) : [],
    features.vip_seating ? supabaseRequest(`/rest/v1/vip_offers?wedding_id=eq.${source.id}&select=seats_total,price_minor&limit=1`, { service: true }) : [],
    supabaseRequest(`/rest/v1/venues?wedding_id=eq.${source.id}&select=kind,is_main&order=sort_order,created_at&limit=30`, { service: true }),
    features.featured_sponsors ? supabaseRequest(`/rest/v1/sponsor_featured_campaigns?wedding_id=eq.${source.id}&enabled=eq.true&select=slot_count,minimum_bid_minor,bid_increment_minor&limit=1`, { service: true }) : []
  ]);
  const amount = (minor, defaultValue = 0) => {
    const value = Number(minor ?? defaultValue);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("This public setup has an invalid amount.");
    return (value / 100).toFixed(2);
  };
  const goals = await Promise.all((campaigns || []).map(async (campaign, index) => {
    const milestones = isShowcase(slug) ? campaign.milestones : await supabaseRequest(
      `/rest/v1/fundraising_milestones?stream_id=eq.${campaign.id}&wedding_id=eq.${source.id}&select=target_minor&order=sort_order&limit=10`, { service: true });
    return { name: `Your fundraising goal ${index + 1}`, purpose: "Describe your own plans for this goal.",
      goal: amount(campaign.goal_minor), enabled: true, milestones: (milestones || []).map((milestone, i) => ({
        name: `Your milestone ${i + 1}`, target: amount(milestone.target_minor), description: "Describe your own milestone."
      })) };
  }));
  const design = globalThis.WSInspiration.publicDesign(source.palette);
  const eventStructure = (events || []).map((event, index) => ({
    name: `${event.kind === "pre" ? "Pre-wedding activity" : "Wedding-day event"} ${index + 1}`,
    kind: event.kind === "pre" ? "pre" : "main", time: "", eventDate: "", address: "", map: "",
    description: "Personalize this event with your own plans and guest guidance.",
    isMain: index === events.findIndex(item => item.kind !== "pre" && item.is_main === true) ||
      (!events.some(item => item.kind !== "pre" && item.is_main === true) && index === events.findIndex(item => item.kind !== "pre"))
  }));
  return {
    ...design, venues: eventStructure.length ? eventStructure : design.venues, classification: "public-reusable-configuration",
    setup: {
      currency: String(source.currency).trim(), reviewed: false, features,
      registry: (registry || []).map((item, index) => ({ name: `Your gift goal ${index + 1}`, category: "",
        description: "Describe your own gift goal.", target: amount(item.target_amount_minor) })),
      vip: vip?.[0] ? { title: "Your seating offering", description: "Describe your own seating arrangements.",
        seats: String(vip[0].seats_total), price: amount(vip[0].price_minor) } : null,
      featured: featured?.[0] ? { slots: String(featured[0].slot_count), minimum: amount(featured[0].minimum_bid_minor),
        increment: amount(featured[0].bid_increment_minor) } : null,
      content: globalThis.WSStarterSetup.prompts(),
      rsvp: { fee: amount(source.rsvp_fee_minor), extraGuestFee: amount(source.extra_guest_fee_minor),
        premiumDietFee: amount(source.premium_diet_fee_minor),
        premiumDietOptions: (source.premium_diet_options || []).slice(0, 10).map((_, index) => `Your premium meal ${index + 1}`) },
      tiers: (tiers || []).map((tier, index) => ({
        name: `Your sponsor package ${index + 1}`, minAmount: amount(tier.min_amount_minor),
        perks: "Describe the offering you can provide. No sponsor identity or purchased package is copied."
      })),
      campaigns: goals
    }
  };
}
