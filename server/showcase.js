// Virtual, read-only sample: no database wedding, identity, ledger or payout records.
export const SHOWCASE_SLUG = "showcase-wedding";
export const SHOWCASE_ID = "00000000-0000-4000-8000-000000000001";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const isShowcase = value => [SHOWCASE_SLUG, SHOWCASE_ID].includes(String(value || "").toLowerCase());
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SHOWCASE_DATE = new Date("2027-03-06T00:00:00Z");
function nextSaturday(date) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + (6 - result.getUTCDay() + 7) % 7);
  return result;
}
function addMonths(date, count) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
function rollingShowcaseDate(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let weddingDate = new Date(FIRST_SHOWCASE_DATE);
  while (Math.ceil((weddingDate.getTime() - today) / DAY_MS) <= 77) {
    const refreshDate = new Date(weddingDate.getTime() - 77 * DAY_MS);
    weddingDate = nextSaturday(addMonths(refreshDate, 4));
  }
  return weddingDate.toISOString().slice(0, 10);
}
const shiftedShowcaseDate = days => {
  const date = new Date(`${rollingShowcaseDate()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export const showcase = {
  id: SHOWCASE_ID, slug: SHOWCASE_SLUG, is_showcase: true, couple_names: "Amara & Kito",
  get wedding_date() { return rollingShowcaseDate(); }, time_zone: "Africa/Nairobi", currency: "KES",
  published_at: "2026-10-29T00:00:00Z", public_location: "Azure Gardens, Diani",
  welcome_story: "It started with a borrowed watering can. Amara had a row of sunflowers to rescue; Kito had absolutely no idea how to help. He stayed anyway.\n\nOne garden afternoon became a thousand little adventures: Sunday markets, long walks by the ocean, burnt pancakes, and a playlist that somehow always ended with one more dance. Somewhere between the laughter and the everyday, friendship became home.\n\nNow comes our favourite adventure yet. Under the garden trees, with the people who have loved us along the way, we are choosing forever. Come for the vows. Stay for the cake. Bring your whole heart.",
  palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
  palette_names: ["Forest Green", "Eucalyptus Sage", "Royal Gold", "Ivory"],
  attire_notes: "Formal African elegance or traditional attire. Choose a colour from our shared wedding palette and comfortable shoes for the garden.",
  max_guest_capacity: 150, rsvp_fee_minor: 0, allow_in_kind_sponsorship: false,
  get venues() { return [
    { id: id(12), name: "Family introductions & blessing", event_date: shiftedShowcaseDate(-70), event_time: "14:00", kind: "pre", address: "Family Homestead, Diani", description: "Two families, one table. Stories, introductions and a traditional blessing for the journey ahead.", is_main: false },
    { id: id(13), name: "Pre-wedding fundraiser", event_date: shiftedShowcaseDate(-35), event_time: "14:00", kind: "pre", address: "Community Hall, Ukunda", description: "An afternoon of music and shared dreams. Your company is the loveliest contribution of all.", is_main: false },
    { id: id(14), name: "Bridal celebration & committee gathering", event_date: shiftedShowcaseDate(-14), event_time: "15:00", kind: "pre", address: "Palm Courtyard, Diani", description: "Flowers in our hair, laughter in the courtyard, and the final little plans coming together.", is_main: false },
    { id: id(2), name: "Family welcome & tea", event_date: shiftedShowcaseDate(-2), event_time: "15:00", kind: "pre", address: "Family Courtyard, Diani", description: "Meet the families, share stories and enjoy an afternoon of music.", is_main: false },
    { id: id(3), name: "Rehearsal & sunset dinner", event_date: shiftedShowcaseDate(-1), event_time: "17:00", kind: "pre", address: "Garden Terrace, Diani", description: "A relaxed rehearsal for the wedding party, followed by dinner under a peach-coloured sky.", is_main: false },
    { id: id(4), name: "Garden ceremony", event_date: rollingShowcaseDate(), event_time: "11:00", kind: "main", address: "Azure Gardens, Diani", description: "A canopy of trees, our favourite people, and two very happy hearts. Please be seated before the vows; this is our unplugged moment.", is_main: true },
    { id: id(5), name: "Lunch, toasts & reception", event_date: rollingShowcaseDate(), event_time: "13:00", kind: "main", address: "Azure Pavilion, Diani", description: "A generous lunch, happy tears, a slice of cake and a dance floor for every generation.", is_main: false }
  ]; },
  registry: [{ id: id(6), name: "Our first home", category: "Home, sweet home", description: "For slow Sunday breakfasts, a table full of friends, and all the everyday magic of building a life together.", target_amount_minor: 20000000, amount_raised_minor: 14600000 }],
  tiers: [], vip: null
};
export const showcaseBids = [
  { song_title: "Together in the sunshine", artist_name: "Sunlit Notes", bid_amount_minor: 1200000, bid_count: 24 },
  { song_title: "Garden of joy", artist_name: "The Petal Ensemble", bid_amount_minor: 1000000, bid_count: 22 },
  { song_title: "One more dance", artist_name: "The Courtyard Quartet", bid_amount_minor: 800000, bid_count: 18 },
  { song_title: "Bloom", artist_name: "The Coastline Band", bid_amount_minor: 650000, bid_count: 16 },
  { song_title: "Can't help falling in love", artist_name: "Elvis Presley", bid_amount_minor: 600000, bid_count: 15 },
  { song_title: "L-O-V-E", artist_name: "Nat King Cole", bid_amount_minor: 500000, bid_count: 12 },
  { song_title: "Kito's pick", artist_name: "The Sauti Collective", bid_amount_minor: 400000, bid_count: 10 },
  { song_title: "Amara's pick", artist_name: "Asha Mwana", bid_amount_minor: 350000, bid_count: 9 },
  { song_title: "Jerusalema", artist_name: "Master KG", bid_amount_minor: 250000, bid_count: 7 },
  { song_title: "Perfect", artist_name: "Ed Sheeran", bid_amount_minor: 200000, bid_count: 6 },
  { song_title: "Sauti ya moyo", artist_name: "Pwani Voices", bid_amount_minor: 150000, bid_count: 5 },
  { song_title: "Celebration", artist_name: "The Garden Quartet", bid_amount_minor: 100000, bid_count: 4 }
];
export const showcaseLedger = [
  { contribution_type: "Celebration fund", paid_amount_minor: 20000000, currency: "KES", guest_display_name: "Miriam & Peter", created_at: "2026-11-05T12:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1200000, currency: "KES", guest_display_name: "Zuri M.", created_at: "2026-11-05T11:45:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 5000000, currency: "KES", guest_display_name: "Auntie Wanjiku", created_at: "2026-11-04T17:20:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 18000000, currency: "KES", guest_display_name: "The Mombasa cousins", created_at: "2026-11-04T14:05:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 1000000, currency: "KES", guest_display_name: "Kito's university friends", created_at: "2026-11-04T10:10:00Z" },
  { contribution_type: "Sponsor contribution", paid_amount_minor: 5000000, currency: "KES", guest_display_name: "Azure Bloom Studio", created_at: "2026-11-03T16:00:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 17000000, currency: "KES", guest_display_name: "With love, the family", created_at: "2026-11-03T13:30:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 4000000, currency: "KES", guest_display_name: "Anonymous", created_at: "2026-11-03T09:25:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Nia & Baraka", created_at: "2026-11-02T19:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 800000, currency: "KES", guest_display_name: "A friend from Nairobi", created_at: "2026-11-02T16:15:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 15000000, currency: "KES", guest_display_name: "The Otieno family", created_at: "2026-11-02T11:40:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 3000000, currency: "KES", guest_display_name: "Salma & Yusuf", created_at: "2026-11-01T15:10:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 650000, currency: "KES", guest_display_name: "The garden table", created_at: "2026-11-01T12:00:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Amina K.", created_at: "2026-10-31T18:30:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 14000000, currency: "KES", guest_display_name: "Amara's work family", created_at: "2026-10-31T14:00:00Z" },
  { contribution_type: "Registry gift", paid_amount_minor: 2600000, currency: "KES", guest_display_name: "The Pwani neighbours", created_at: "2026-10-31T10:45:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 600000, currency: "KES", guest_display_name: "Malaika W.", created_at: "2026-10-30T20:00:00Z" },
  { contribution_type: "Sponsor contribution", paid_amount_minor: 2500000, currency: "KES", guest_display_name: "Coastline House", created_at: "2026-10-30T15:15:00Z" },
  { contribution_type: "Celebration fund", paid_amount_minor: 14000000, currency: "KES", guest_display_name: "The Diani friends", created_at: "2026-10-30T11:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 500000, currency: "KES", guest_display_name: "Tariq & friends", created_at: "2026-10-29T17:40:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 400000, currency: "KES", guest_display_name: "Zawadi N.", created_at: "2026-10-29T14:10:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 350000, currency: "KES", guest_display_name: "Kendi M.", created_at: "2026-10-29T10:20:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "The Kamau family", created_at: "2026-10-28T16:40:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Nuru J.", created_at: "2026-10-28T12:00:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Asha & Juma", created_at: "2026-10-27T15:30:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 200000, currency: "KES", guest_display_name: "Sifa W.", created_at: "2026-10-27T11:20:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Farida & Hassan", created_at: "2026-10-26T17:00:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 150000, currency: "KES", guest_display_name: "Mosi T.", created_at: "2026-10-26T13:00:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Wanjiru & David", created_at: "2026-10-25T18:20:00Z" },
  { contribution_type: "Song bid", paid_amount_minor: 100000, currency: "KES", guest_display_name: "Kito's aunties", created_at: "2026-10-25T12:45:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Mariam & Salim", created_at: "2026-10-24T16:30:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "The Wekesa family", created_at: "2026-10-23T13:15:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Pendo & Malik", created_at: "2026-10-22T10:00:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "The Mwangi family", created_at: "2026-10-21T15:20:00Z" },
  { contribution_type: "VIP seat", paid_amount_minor: 250000, currency: "KES", guest_display_name: "Njeri & Kamau", created_at: "2026-10-20T13:10:00Z" }
];
export const showcaseFundraising = {
  allow_in_kind_sponsorship: false,
  celebration: {
    campaign_id: id(7), currency: "KES", goal_minor: 140000000, raised_minor: 114800000,
    remaining_minor: 25200000, completion_percent: 82, campaign_raised_minor: 84000000,
    sources: [
      { key: "gifts", amount_minor: 84000000 }, { key: "songs", amount_minor: 6200000 },
      { key: "registry", amount_minor: 14600000 }, { key: "sponsors", amount_minor: 7500000 },
      { key: "vip", amount_minor: 2500000 }
    ]
  },
  campaigns: [{ id: id(7), name: "Celebration fund", purpose: "A garden full of love, a table full of laughter. Help us bring our favourite people together for a day to remember.", goal_minor: 100000000, raised_minor: 84000000,
    milestones: [{ id: id(8), name: "Garden venue", target_minor: 55000000, reached: true, description: "Space for all our favourite people." },
      { id: id(9), name: "Music & memories", target_minor: 100000000, reached: false, description: "The soundtrack to our first dance and every dance after." }] }],
  tiers: [{ id: id(10), name: "Golden celebration partner", min_amount_minor: 1000000, perks: "A clearly labelled sponsor card and a warm thank-you." }],
  vip: { id: id(11), title: "Garden lounge", description: "A little shade, a lovely garden view, and a special place to soak up every moment.", seats_total: 12, seats_sold: 10, price_minor: 250000 },
  sponsors: [
    { company_name: "Azure Bloom Studio", offer: "Thoughtfully styled celebrations, garden florals and moments worth remembering.", location: "Diani", amount_minor: 3500000, website: "https://example.com", social_links: {}, public_contact: false, in_kind: false },
    { company_name: "Coastline House", offer: "A welcoming stay for friends and family making a weekend of the celebration.", location: "Diani", amount_minor: 2500000, website: "https://example.com", social_links: {}, public_contact: false, in_kind: false },
    { company_name: "Pwani Sound House", offer: "Sound, lights and a dance floor full of the people we love.", location: "Mombasa", amount_minor: 1500000, website: "https://example.com", social_links: {}, public_contact: false, in_kind: false }
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
