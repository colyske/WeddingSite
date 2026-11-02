(function (root) {
  "use strict";
  const featureKeys = ["giving", "sponsors", "featured_sponsors", "song_requests", "vip_seating"];
  const defaultFeatures = () => Object.fromEntries(featureKeys.map(key => [key, true]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const keysOnly = (value, keys, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Check ${label}.`);
  };
  const text = (value, max, label, optional = false) => {
    if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) throw new Error(`Check ${label}.`);
    return value.trim();
  };
  function restoreEditable(value) {
    const record = (item, fields) => {
      keysOnly(item, fields, "saved starter answers");
      if (fields.some(key => typeof item[key] !== "string")) throw new Error("Check saved starter answers.");
    };
    const list = (items, max, check) => {
      if (!Array.isArray(items) || items.length > max) throw new Error("Check saved starter sections.");
      items.forEach(check);
    };
    keysOnly(value, ["currency", "reviewed", "reviewNote", "features", "rsvp", "tiers", "campaigns", "registry", "vip", "featured", "content"], "saved starter");
    text(value.reviewNote, 1000, "saved starter review", true);
    if (typeof value.currency !== "string" || (value.currency && !root.WSCurrencies.supportsAccounting(value.currency)) ||
        typeof value.reviewed !== "boolean") throw new Error("Check saved starter currency and review.");
    keysOnly(value.features, featureKeys, "saved starter features");
    if (featureKeys.some(key => typeof value.features[key] !== "boolean")) throw new Error("Check saved starter features.");
    keysOnly(value.rsvp, ["fee", "extraGuestFee", "premiumDietFee", "premiumDietOptions"], "saved RSVP options");
    if (["fee", "extraGuestFee", "premiumDietFee"].some(key => typeof value.rsvp[key] !== "string")) throw new Error("Check saved RSVP fees.");
    list(value.rsvp.premiumDietOptions, 10, option => {
      if (typeof option !== "string") throw new Error("Check saved meal options.");
    });
    keysOnly(value.content, ["attire", "travel", "faq"], "saved guest prompts");
    record({ attire: value.content.attire, travel: value.content.travel }, ["attire", "travel"]);
    list(value.content.faq, 12, item => record(item, ["q", "a"]));
    if (value.vip !== null) record(value.vip, ["title", "description", "seats", "price"]);
    if (value.featured !== null) record(value.featured, ["slots", "minimum", "increment"]);
    list(value.registry, 20, item => record(item, ["name", "category", "description", "target"]));
    list(value.tiers, 6, item => record(item, ["name", "minAmount", "perks"]));
    list(value.campaigns, 6, campaign => {
      keysOnly(campaign, ["name", "purpose", "goal", "enabled", "milestones"], "saved fundraising goal");
      if (["name", "purpose", "goal"].some(key => typeof campaign[key] !== "string") ||
          typeof campaign.enabled !== "boolean") throw new Error("Check saved fundraising goal.");
      list(campaign.milestones, 10, milestone => record(milestone, ["name", "target", "description"]));
    });
    return clone(value);
  }
  function money(value, min, max, label) {
    if (typeof value !== "string" || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) {
      throw new Error(`${label}: enter an amount with at most two decimal places.`);
    }
    const [whole, fraction = ""] = value.split(".");
    const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(minor) || minor < min || minor > max) throw new Error(`${label}: amount is outside the allowed limits.`);
    return minor;
  }
  function normalize(value, currency) {
    keysOnly(value, ["currency", "reviewed", "reviewNote", "features", "rsvp", "tiers", "campaigns", "registry", "vip", "featured", "content"], "starter configuration");
    if (!root.WSCurrencies.supportsAccounting(currency) || value.currency !== currency || value.reviewed !== true) {
      throw new Error("Choose your currency, then review and confirm every starter price and goal in that currency.");
    }
    keysOnly(value.features, featureKeys, "guest features");
    if (featureKeys.some(key => typeof value.features[key] !== "boolean")) throw new Error("Review all guest feature choices.");
    keysOnly(value.rsvp, ["fee", "extraGuestFee", "premiumDietFee", "premiumDietOptions"], "RSVP options");
    if (!Array.isArray(value.rsvp.premiumDietOptions) || value.rsvp.premiumDietOptions.length > 10) throw new Error("Use up to ten premium meal choices.");
    if (!Array.isArray(value.tiers) || value.tiers.length > 6) throw new Error("Use up to six sponsor packages.");
    if (!Array.isArray(value.campaigns) || value.campaigns.length > 6) throw new Error("Use up to six fundraising goals.");
    if (new Set(value.campaigns.map(campaign => typeof campaign?.name === "string" ? campaign.name.trim() : "")).size !== value.campaigns.length) throw new Error("Give each fundraising goal a different name.");
    if (!Array.isArray(value.registry) || value.registry.length > 20) throw new Error("Use up to twenty gift registry goals.");
    keysOnly(value.content, ["attire", "travel", "faq"], "guest prompts");
    if (!Array.isArray(value.content.faq) || value.content.faq.length > 12) throw new Error("Use up to twelve guest questions.");
    let vip = null;
    let featured = null;
    if (value.featured !== null) {
      keysOnly(value.featured, ["slots", "minimum", "increment"], "featured sponsor setup");
      if (!/^\d+$/.test(value.featured.slots) || Number(value.featured.slots) < 1 || Number(value.featured.slots) > 20) throw new Error("Use 1 to 20 featured sponsor slots.");
      featured = { slots: Number(value.featured.slots), minimumMinor: money(value.featured.minimum, 1, 100000000000, "Featured minimum"),
        incrementMinor: money(value.featured.increment, 1, 100000000000, "Featured increment") };
    }
    if (value.vip !== null) {
      keysOnly(value.vip, ["title", "description", "seats", "price"], "VIP offer");
      if (!/^\d+$/.test(value.vip.seats) || Number(value.vip.seats) < 1 || Number(value.vip.seats) > 500) throw new Error("Use 1 to 500 VIP seats.");
      vip = { title: text(value.vip.title, 80, "VIP title"), description: text(value.vip.description, 240, "VIP description", true),
        seats: Number(value.vip.seats), priceMinor: money(value.vip.price, 1, 100000000000, "VIP price") };
    }
    return {
      currency, reviewed: true, reviewNote: text(value.reviewNote, 1000, "starter review", true),
      features: clone(value.features),
      vip, featured, content: {
        attire: text(value.content.attire, 300, "attire prompt", true),
        travel: text(value.content.travel, 2000, "travel prompt", true),
        faq: value.content.faq.map(item => {
          keysOnly(item, ["q", "a"], "guest question");
          return { q: text(item.q, 160, "guest question"), a: text(item.a, 600, "guest answer", true) };
        })
      },
      registry: value.registry.map(item => {
        keysOnly(item, ["name", "category", "description", "target"], "registry item");
        return { name: text(item.name, 100, "registry name"), category: text(item.category, 50, "registry category", true),
          description: text(item.description, 240, "registry description", true),
          targetMinor: money(item.target, 100, 100000000000, "Registry goal") };
      }),
      rsvp: {
        feeMinor: money(value.rsvp.fee, 0, 100000000, "RSVP fee"),
        extraGuestFeeMinor: money(value.rsvp.extraGuestFee, 0, 100000000, "Extra guest fee"),
        premiumDietFeeMinor: money(value.rsvp.premiumDietFee, 0, 100000000, "Premium meal fee"),
        premiumDietOptions: value.rsvp.premiumDietOptions.map(option => text(option, 40, "premium meal choice"))
      },
      tiers: value.tiers.map(tier => {
        keysOnly(tier, ["name", "minAmount", "perks"], "sponsor package");
        return { name: text(tier.name, 60, "package name"), minimumMinor: money(tier.minAmount, 1, 100000000000, "Package price"),
          perks: text(tier.perks, 240, "package offering") };
      }),
      campaigns: value.campaigns.map(campaign => {
        keysOnly(campaign, ["name", "purpose", "goal", "enabled", "milestones"], "fundraising goal");
        if (typeof campaign.enabled !== "boolean" || !Array.isArray(campaign.milestones) || campaign.milestones.length > 10) {
          throw new Error("Review fundraising visibility and up to ten milestones.");
        }
        const goalMinor = money(campaign.goal, 1, 100000000000, "Fundraising goal");
        return { name: text(campaign.name, 100, "goal name"), purpose: text(campaign.purpose, 240, "goal purpose"),
          goalMinor, enabled: campaign.enabled, milestones: campaign.milestones.map(milestone => {
            keysOnly(milestone, ["name", "target", "description"], "milestone");
            const targetMinor = money(milestone.target, 1, goalMinor, "Milestone target");
            return { name: text(milestone.name, 100, "milestone name"), targetMinor,
              description: text(milestone.description, 240, "milestone description", true) };
          }) };
      })
    };
  }
  const prices = {
    USD: ["25", "100", "1500", "500", "1000"],
    KES: ["2500", "10000", "150000", "50000", "100000"],
    EUR: ["25", "100", "1500", "500", "1000"],
    GBP: ["20", "80", "1200", "400", "800"],
    NGN: ["25000", "100000", "1500000", "500000", "1000000"],
    ZAR: ["400", "1600", "24000", "8000", "16000"]
  };
  function fictional(id, currency = "") {
    const source = root.WSInspiration.get(id);
    if (!source) throw new Error("Choose a listed fictional inspiration style.");
    const sample = prices[currency] || ["", "", "", "", ""];
    const names = {
      "garden-gathering": ["Garden partner", "Celebration partner", "Gathering together", "A place to celebrate", "Music & memories"],
      "coastal-weekend": ["Weekend partner", "Sunset partner", "A joyful weekend", "Welcome gathering", "The celebration table"],
      "city-evening": ["Evening partner", "Spotlight partner", "A night to remember", "The shared table", "Our dance floor"]
    }[id];
    return {
      currency, reviewed: false,
      reviewNote: "This private starter contains illustrative offerings, goals and guest guidance, not purchased sponsorships or received funds. Personalize the copied sections and supply your own story, dates and venue details. Featured bidding stays disabled with blank dates. Photos and guest instructions are optional.",
      features: defaultFeatures(),
      registry: [{ name: "Our next chapter", category: "Celebration", description: "Sample registry goal - describe your own plans.", target: sample[2] }],
      vip: { title: "Celebration lounge", description: "Sample seating offering - confirm your actual arrangements.", seats: "12", price: sample[0] },
      featured: { slots: "3", minimum: sample[1], increment: sample[0] },
      content: { attire: `Illustrative - review: ${source.attire}`.slice(0, 300), travel: source.travel,
        faq: source.faq.map(([q, a]) => ({ q, a: `Illustrative - personalize: ${a}` })) },
      rsvp: { fee: "0", extraGuestFee: "0", premiumDietFee: "0", premiumDietOptions: ["Celebration menu"] },
      tiers: [
        { name: names[0], minAmount: sample[0], perks: "Sample offering: a clearly labelled supporter card. Review and personalize." },
        { name: names[1], minAmount: sample[1], perks: "Sample offering: supporter recognition and a thank-you. Confirm your own terms." }
      ],
      campaigns: [{ name: names[2], purpose: "Sample goal for our celebration. Replace with your own plans.",
        goal: sample[2], enabled: true, milestones: [
          { name: names[3], target: sample[3], description: "Sample planning milestone - review before use." },
          { name: names[4], target: sample[4], description: "Sample planning milestone - review before use." }
        ] }]
    };
  }
  function clearMoney(value, currency) {
    const next = clone(value);
    next.currency = currency;
    next.reviewed = false;
    next.rsvp.fee = next.rsvp.extraGuestFee = next.rsvp.premiumDietFee = "";
    next.tiers.forEach(tier => { tier.minAmount = ""; });
    next.registry.forEach(item => { item.target = ""; });
    if (next.vip) next.vip.price = "";
    if (next.featured) next.featured.minimum = next.featured.increment = "";
    next.campaigns.forEach(campaign => {
      campaign.goal = "";
      campaign.milestones.forEach(milestone => { milestone.target = ""; });
    });
    return next;
  }
  const prompts = () => ({ attire: "Add your own dress guidance and accessibility considerations.",
    travel: "Add confirmed transport, accommodation and accessibility guidance for your own venues.",
    faq: [{ q: "What should guests know before attending?", a: "Replace this prompt with guidance for your own celebration." }] });
  root.WSStarterSetup = Object.freeze({ featureKeys, defaultFeatures, normalize, restoreEditable, fictional, clearMoney, prompts,
    hasSamples: currency => Object.hasOwn(prices, currency), clone });
})(globalThis);
