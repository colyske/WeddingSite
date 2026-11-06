// Virtual, read-only sample: no database wedding, identity, ledger or payout records.
export const SHOWCASE_SLUG = "showcase-wedding";
export const SHOWCASE_ID = "00000000-0000-4000-8000-000000000001";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const isShowcase = value => [SHOWCASE_SLUG, SHOWCASE_ID].includes(String(value || "").toLowerCase());
export const showcase = {
  id: SHOWCASE_ID, slug: SHOWCASE_SLUG, is_showcase: true, couple_names: "Amara & Kito",
  wedding_date: "2027-03-06", time_zone: "Africa/Nairobi", currency: "KES",
  published_at: "2026-10-29T00:00:00Z", public_location: "Azure Gardens, Diani",
  welcome_story: "It started with a borrowed watering can. Amara had a row of sunflowers to rescue; Kito had absolutely no idea how to help. He stayed anyway.\n\nOne garden afternoon became a thousand little adventures: Sunday markets, long walks by the ocean, burnt pancakes, and a playlist that somehow always ended with one more dance. Somewhere between the laughter and the everyday, friendship became home.\n\nNow comes our favourite adventure yet. Under the garden trees, with the people who have loved us along the way, we are choosing forever. Come for the vows. Stay for the cake. Bring your whole heart.",
  palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
  palette_names: ["Forest Green", "Eucalyptus Sage", "Royal Gold", "Ivory"],
  attire_notes: "Formal African elegance or traditional attire. Choose a colour from our shared wedding palette and comfortable shoes for the garden.",
  max_guest_capacity: 150, rsvp_fee_minor: 0, allow_in_kind_sponsorship: false,
  venues: [
    { id: id(12), name: "Family introductions & blessing", event_date: "2027-01-09", event_time: "14:00", kind: "pre", address: "Family Homestead, Diani", description: "Two families, one table. Stories, introductions and a traditional blessing for the journey ahead.", is_main: false },
    { id: id(13), name: "Pre-wedding fundraiser", event_date: "2027-02-06", event_time: "14:00", kind: "pre", address: "Community Hall, Ukunda", description: "An afternoon of music and shared dreams. Your company is the loveliest contribution of all.", is_main: false },
    { id: id(14), name: "Bridal celebration & committee gathering", event_date: "2027-02-20", event_time: "15:00", kind: "pre", address: "Palm Courtyard, Diani", description: "Flowers in our hair, laughter in the courtyard, and the final little plans coming together.", is_main: false },
    { id: id(2), name: "Family welcome & tea", event_date: "2027-03-04", event_time: "15:00", kind: "pre", address: "Family Courtyard, Diani", description: "Meet the families, share stories and enjoy an afternoon of music.", is_main: false },
    { id: id(3), name: "Rehearsal & sunset dinner", event_date: "2027-03-05", event_time: "17:00", kind: "pre", address: "Garden Terrace, Diani", description: "A relaxed rehearsal for the wedding party, followed by dinner under a peach-coloured sky.", is_main: false },
    { id: id(4), name: "Garden ceremony", event_date: "2027-03-06", event_time: "11:00", kind: "main", address: "Azure Gardens, Diani", description: "A canopy of trees, our favourite people, and two very happy hearts. Please be seated before the vows; this is our unplugged moment.", is_main: true },
    { id: id(5), name: "Lunch, toasts & reception", event_date: "2027-03-06", event_time: "13:00", kind: "main", address: "Azure Pavilion, Diani", description: "A generous lunch, happy tears, a slice of cake and a dance floor for every generation.", is_main: false }
  ],
  registry: [{ id: id(6), name: "Our first home", category: "Home, sweet home", description: "For slow Sunday breakfasts, a table full of friends, and all the everyday magic of building a life together.", target_amount_minor: 25000000, amount_raised_minor: 20500000 }],
  tiers: [], vip: null
};
export const showcaseBids = [
  { song_title: "Together in the sunshine", artist_name: "Sunlit Notes", bid_amount_minor: 4200000, bid_count: 32 },
  { song_title: "Garden of joy", artist_name: "The Petal Ensemble", bid_amount_minor: 3100000, bid_count: 24 },
  { song_title: "One more dance", artist_name: "The Courtyard Quartet", bid_amount_minor: 2600000, bid_count: 19 },
  { song_title: "Dancing under the stars", artist_name: "Coastline Collective", bid_amount_minor: 2200000, bid_count: 16 },
  { song_title: "Home is wherever you are", artist_name: "The Sunday Sessions", bid_amount_minor: 1800000, bid_count: 13 },
  { song_title: "A thousand little adventures", artist_name: "Maji & Moon", bid_amount_minor: 1600000, bid_count: 11 },
  { song_title: "Our favourite day", artist_name: "The Garden Party", bid_amount_minor: 1400000, bid_count: 9 },
  { song_title: "Forever starts tonight", artist_name: "Golden Hour Band", bid_amount_minor: 1100000, bid_count: 7 }
];
export const showcaseLedger = [
  { contribution_type: "Song bid", paid_amount_minor: 4200000, currency: "KES", guest_display_name: "The wedding party", created_at: "2026-11-05T16:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 3100000, currency: "KES", guest_display_name: "A friend from Mombasa", created_at: "2026-11-05T14:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 2600000, currency: "KES", guest_display_name: "The dance crew", created_at: "2026-11-04T17:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 2200000, currency: "KES", guest_display_name: "With love from Nairobi", created_at: "2026-11-04T12:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1800000, currency: "KES", guest_display_name: "Aunties & uncles", created_at: "2026-11-03T18:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1600000, currency: "KES", guest_display_name: "Anonymous", created_at: "2026-11-03T13:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1400000, currency: "KES", guest_display_name: "The garden friends", created_at: "2026-11-02T15:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1100000, currency: "KES", guest_display_name: "Cousins near & far", created_at: "2026-11-02T11:00:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 8000000, currency: "KES", guest_display_name: "Both families", created_at: "2026-11-01T17:00:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 7000000, currency: "KES", guest_display_name: "A dear family friend", created_at: "2026-11-01T12:00:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 5500000, currency: "KES", guest_display_name: "Anonymous", created_at: "2026-10-31T16:00:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 30000000, currency: "KES", guest_display_name: "The family table", created_at: "2026-10-31T12:00:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 20000000, currency: "KES", guest_display_name: "Friends from university", created_at: "2026-10-30T16:00:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 18000000, currency: "KES", guest_display_name: "With love, the community", created_at: "2026-10-30T11:00:00Z" },
  { contribution_type: "Sponsor contribution", paid_amount_minor: 2500000, currency: "KES", guest_display_name: "Azure Bloom Studio", created_at: "2026-10-29T15:00:00Z" },
  { contribution_type: "Sponsor contribution", paid_amount_minor: 2500000, currency: "KES", guest_display_name: "Coast & Canopy Events", created_at: "2026-10-29T11:00:00Z" },
  { contribution_type: "VIP seating", paid_amount_minor: 1800000, currency: "KES", guest_display_name: "The garden circle", created_at: "2026-10-28T15:00:00Z" },
  { contribution_type: "VIP seating", paid_amount_minor: 1500000, currency: "KES", guest_display_name: "A generous guest", created_at: "2026-10-28T11:00:00Z" }
];
export const showcaseFundraising = {
  allow_in_kind_sponsorship: false,
  celebration: {
    campaign_id: id(7), currency: "KES", goal_minor: 140000000, raised_minor: 114800000,
    remaining_minor: 25200000, completion_percent: 82, campaign_raised_minor: 68000000,
    sources: [
      { key: "gifts", amount_minor: 68000000 }, { key: "songs", amount_minor: 18000000 },
      { key: "registry", amount_minor: 20500000 }, { key: "sponsors", amount_minor: 5000000 },
      { key: "vip", amount_minor: 3300000 }
    ]
  },
  campaigns: [{ id: id(7), name: "Celebration fund", purpose: "A garden full of love, a table full of laughter. Help us bring our favourite people together for a day to remember.", goal_minor: 140000000, raised_minor: 114800000,
    milestones: [{ id: id(8), name: "Garden venue", target_minor: 30000000, reached: true, description: "Space for all our favourite people." },
      { id: id(9), name: "Music & memories", target_minor: 80000000, reached: false, description: "The soundtrack to our first dance and every dance after." }] }],
  tiers: [{ id: id(10), name: "Golden celebration partner", min_amount_minor: 1000000, perks: "A clearly labelled sponsor card and a warm thank-you." }],
  vip: { id: id(11), title: "Garden lounge", description: "A little shade, a lovely garden view, and a special place to soak up every moment.", seats_total: 20, seats_sold: 12, price_minor: 275000 },
  sponsors: [
    { company_name: "Azure Bloom Studio", offer: "Thoughtfully styled celebrations, garden florals and moments worth remembering.",
      location: "Diani", amount_minor: 2500000, website: "https://example.com",
      social_links: { facebook: "https://www.facebook.com/JoinOurWeddingFictionalSample2099", instagram: "https://www.instagram.com/jow_fictional_sample_2099/" },
      public_contact: true, contact_email: "studio@example.com", contact_phone: "+1 202 555 0123", in_kind: false },
    { company_name: "Coast & Canopy Events", offer: "Local touches, thoughtful hosting and a celebration that feels like us.",
      location: "Ukunda", amount_minor: 2500000, website: "https://example.com",
      social_links: {}, public_contact: false, in_kind: false }
  ],
  sponsorAuction: { enabled: false }
};
export const showcaseExtras = {
  travel: "Make a little weekend of it. Arrive the day before, settle into a stay near the gardens, and leave time for a slow walk by the ocean. Allow extra time for local travel so you arrive ready to celebrate, not in a hurry.",
  faq: [{ q: "May I bring children?", a: "Little ones are part of our big family. Please include them in your party so we can make everyone comfortable." },
    { q: "What should I wear?", a: "Formal or traditional clothing in the shared palette. Comfortable shoes are welcome." },
    { q: "Will the celebration be outdoors?", a: "Yes, we are gathering in the garden. Bring a light layer for the evening and comfortable shoes for the paths." }],
  wishes: [{ author_name: "Your garden friends", message: "From that very first sunflower to this beautiful new beginning. Wishing you a lifetime of laughter and little adventures." }]
};
