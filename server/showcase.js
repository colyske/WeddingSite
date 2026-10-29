// Virtual, read-only sample: no database wedding, identity, ledger or payout records.
export const SHOWCASE_SLUG = "showcase-wedding";
export const SHOWCASE_ID = "00000000-0000-4000-8000-000000000001";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const isShowcase = value => [SHOWCASE_SLUG, SHOWCASE_ID].includes(String(value || "").toLowerCase());
export const showcase = {
  id: SHOWCASE_ID, slug: SHOWCASE_SLUG, is_showcase: true, couple_names: "Amara & Kito (sample)",
  wedding_date: "2099-08-16", time_zone: "Africa/Nairobi", currency: "KES",
  published_at: "2026-10-29T00:00:00Z", public_location: "Fictional Azure Gardens, Diani",
  welcome_story: "A fictional celebration of friendship, family and new beginnings. Amara and Kito met at a community garden, bonded over music, and built a life full of small adventures. Join this sample journey from the family gathering to the last dance.",
  palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
  palette_names: ["Forest Green", "Eucalyptus Sage", "Royal Gold", "Ivory"],
  attire_notes: "Formal African elegance or traditional attire. Choose a colour from our shared wedding palette and comfortable shoes for the garden.",
  max_guest_capacity: 150, rsvp_fee_minor: 0, allow_in_kind_sponsorship: false,
  venues: [
    { id: id(12), name: "Family introductions & blessing", event_date: "2099-06-07", event_time: "14:00", kind: "pre", address: "Fictional Family Homestead, Diani", description: "A sample introduction of the families and a traditional blessing for the journey ahead.", is_main: false },
    { id: id(13), name: "Pre-wedding fundraiser", event_date: "2099-07-12", event_time: "14:00", kind: "pre", address: "Fictional Community Hall, Ukunda", description: "A sample afternoon of music, shared plans and voluntary paid contributions toward the celebration.", is_main: false },
    { id: id(14), name: "Bridal celebration & committee gathering", event_date: "2099-08-02", event_time: "15:00", kind: "pre", address: "Fictional Palm Courtyard, Diani", description: "A sample bridal celebration while the organizing committee confirms the final programme and guest arrangements.", is_main: false },
    { id: id(2), name: "Family welcome & tea", event_date: "2099-08-14", event_time: "15:00", kind: "pre", address: "Sample Family Courtyard, fictional venue", description: "Meet the families, share stories and enjoy an afternoon of music.", is_main: false },
    { id: id(3), name: "Rehearsal & sunset dinner", event_date: "2099-08-15", event_time: "17:00", kind: "pre", address: "Sample Garden Terrace, fictional venue", description: "A relaxed rehearsal for the wedding party, followed by dinner.", is_main: false },
    { id: id(4), name: "Garden ceremony", event_date: "2099-08-16", event_time: "11:00", kind: "main", address: "Fictional Azure Gardens, Diani", description: "Please be seated before the ceremony. An unplugged moment for our vows.", is_main: true },
    { id: id(5), name: "Lunch, toasts & reception", event_date: "2099-08-16", event_time: "13:00", kind: "main", address: "Fictional Azure Pavilion, Diani", description: "Lunch, family speeches, cake and dancing into the evening.", is_main: false }
  ],
  registry: [{ id: id(6), name: "Our first home", category: "Home", description: "A fictional registry goal to illustrate giving progress.", target_amount_minor: 20000000, amount_raised_minor: 6000000 }],
  tiers: [], vip: null
};
export const showcaseBids = [
  { song_title: "Together in the sunshine", artist_name: "The Sample Band", bid_amount_minor: 250000, bid_count: 5 },
  { song_title: "Garden of joy", artist_name: "Fictional Ensemble", bid_amount_minor: 150000, bid_count: 3 },
  { song_title: "One more dance", artist_name: "The Demo Quartet", bid_amount_minor: 75000, bid_count: 2 }
];
export const showcaseLedger = [
  { contribution_type: "Song bid", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Sample Guest A", created_at: "2026-10-28T12:00:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 500000, currency: "KES", guest_display_name: "Anonymous", created_at: "2026-10-27T14:00:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 1000000, currency: "KES", guest_display_name: "Sample Family", created_at: "2026-10-26T10:00:00Z" }
];
export const showcaseFundraising = {
  allow_in_kind_sponsorship: false,
  campaigns: [{ id: id(7), name: "Celebration fund", purpose: "A sample campaign for family and friends.", goal_minor: 50000000, raised_minor: 18000000,
    milestones: [{ id: id(8), name: "Garden venue", target_minor: 15000000, reached: true, description: "Space for all our favourite people." },
      { id: id(9), name: "Music & memories", target_minor: 30000000, reached: false, description: "Our next sample milestone." }] }],
  tiers: [{ id: id(10), name: "Golden celebration partner", min_amount_minor: 1000000, perks: "A clearly labelled sponsor card and a warm thank-you." }],
  vip: { id: id(11), title: "Garden lounge", description: "Sample premium seating with a shaded garden view.", seats_total: 12, seats_sold: 4, price_minor: 250000 },
  sponsors: [{ company_name: "Azure Bloom Studio (sample)", offer: "Thoughtfully styled celebrations, garden florals and moments worth remembering.",
    location: "Fictional Diani studio · sample profiles, not a real business", amount_minor: 1000000, website: "https://example.com",
    social_links: { facebook: "https://www.facebook.com/JoinOurWeddingFictionalSample2099", instagram: "https://www.instagram.com/jow_fictional_sample_2099/" },
    public_contact: true, contact_email: "studio@example.com", contact_phone: "+1 202 555 0123", in_kind: false }],
  sponsorAuction: { enabled: false }
};
export const showcaseExtras = {
  travel: "Sample travel guide: arrive the day before, choose accommodation near the fictional garden venue, and allow time for local travel. This is not a real event or travel booking.",
  faq: [{ q: "May I bring children?", a: "This sample celebration welcomes families; a real couple can set their own guest policy." },
    { q: "What should I wear?", a: "Formal or traditional clothing in the shared palette. Comfortable shoes are welcome." },
    { q: "Can I make a payment or RSVP here?", a: "No. This is a fictional showcase. All payments, RSVPs, passes and messages are disabled." }],
  wishes: [{ author_name: "Sample Friend", message: "Wishing you a lifetime of laughter and beautiful adventures." }]
};
