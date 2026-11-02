(function (root) {
  "use strict";
  // Author-owned fiction only. Never populate this catalogue from client weddings.
  const fixtures = [
    {
      id: "garden-gathering", classification: "author-owned-fictional-inspiration",
      title: "The garden gathering", mood: "Botanical, warm and family-centred",
      names: "Mira & Rowan", date: "16 August 2099", location: "Fictional Fern Courtyard",
      palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
      paletteNames: ["Forest", "Sage", "Gold", "Ivory"],
      welcome: "From little everyday adventures to a garden full of our favourite people, this is a celebration of the life we are growing together. Come for the vows, stay for the stories and the last dance.",
      attire: "Garden elegance or traditional celebration wear. Earthy greens and warm accents are welcome; choose shoes comfortable on a garden path.",
      travel: "In this fictional example, guests arrive the evening before and stay near the courtyard. Replace this with confirmed accommodation, accessibility and transport guidance.",
      faq: [
        ["Will the celebration be outdoors?", "This sample ceremony is in a garden, with a covered reception nearby."],
        ["Can we bring children?", "This fictional celebration welcomes families. Set your own invitation policy."],
        ["What about dietary needs?", "The couple would collect dietary preferences privately through their own RSVP flow."]
      ],
      events: [
        { name: "Family welcome & tea", time: "15:00", place: "Fictional Fern Courtyard", kind: "pre", description: "An easy afternoon for introductions, family stories and a shared cup of tea." },
        { name: "Garden ceremony", time: "11:00", place: "Fictional Fern Garden", kind: "main", description: "An unplugged ceremony, followed by a little time together for photographs." },
        { name: "Lunch, toasts & dancing", time: "13:00", place: "Fictional Fern Pavilion", kind: "main", description: "A generous shared table, heartfelt speeches and music into the evening." }
      ]
    },
    {
      id: "coastal-weekend", classification: "author-owned-fictional-inspiration",
      title: "A coastal weekend", mood: "Airy, relaxed and sunset-inspired",
      names: "Lena & Ellis", date: "21 November 2099", location: "Fictional Tide House",
      palette: ["#175b70", "#b8d7dc", "#e7b59a", "#fff4df"],
      paletteNames: ["Ocean", "Sea glass", "Peach", "Sand"],
      welcome: "Our happiest days have always ended with a long walk and a beautiful sky. For this next chapter, we are bringing that feeling to one joyful weekend with you: slow conversations, bright flowers and plenty of dancing.",
      attire: "Relaxed celebration wear in ocean shades or warm sunset colours. Light layers and flat shoes suit this imagined seaside setting.",
      travel: "This fictional weekend includes a welcome evening and a next-day farewell. Add real travel times, accessible routes and a weather plan before inviting guests.",
      faq: [
        ["Is there a welcome evening?", "In this sample programme, a relaxed gathering starts the weekend."],
        ["What if the weather changes?", "This example has an indoor backup space; confirm your own plan."],
        ["Do we need to attend every event?", "The sample farewell is optional. Tell guests which of your events require an invitation."]
      ],
      events: [
        { name: "Welcome by the water", time: "17:00", place: "Fictional Tide Terrace", kind: "pre", description: "A relaxed welcome, light refreshments and time to settle into the weekend." },
        { name: "Sunset vows", time: "16:30", place: "Fictional Tide House", kind: "main", description: "A short ceremony in the soft afternoon light, with an indoor weather alternative." },
        { name: "Supper & starlight dancing", time: "18:00", place: "Fictional Tide Ballroom", kind: "main", description: "Seasonal dishes, joyful toasts and a dance floor for every generation." }
      ]
    },
    {
      id: "city-evening", classification: "author-owned-fictional-inspiration",
      title: "An evening in the city", mood: "Modern, intimate and candlelit",
      names: "Noor & Avery", date: "5 December 2099", location: "Fictional Lantern Hall",
      palette: ["#392c46", "#b48a99", "#c4a66a", "#f5eee7"],
      paletteNames: ["Aubergine", "Dusty rose", "Champagne", "Porcelain"],
      welcome: "A hundred small coincidences brought us together. Now we are making one very deliberate plan: a room filled with people we love, a candlelit dinner and an evening worth remembering. We are so glad you are part of our story.",
      attire: "Evening elegance, a favourite suit or festive traditional attire. Jewel tones and soft metallic accents complement this imagined candlelit room.",
      travel: "For this fictional city celebration, the ceremony and reception share a building. Replace these notes with confirmed entrances, parking and public transport options.",
      faq: [
        ["Are the ceremony and dinner together?", "In this example, both take place in the same fictional hall."],
        ["Is the venue step-free?", "Accessibility must be confirmed directly for your real venue; this sample makes no verified claim."],
        ["Can we request a song?", "Decide in your own setup whether to enable music requests; no requests or bids are accepted here."]
      ],
      events: [
        { name: "Evening ceremony", time: "17:00", place: "Fictional Lantern Hall", kind: "main", description: "A candlelit ceremony with close family and friends." },
        { name: "Dinner & speeches", time: "18:00", place: "Fictional Lantern Dining Room", kind: "main", description: "A seated dinner with thoughtful toasts and space for conversation." },
        { name: "The after-dinner dance", time: "20:00", place: "Fictional Lantern Salon", kind: "main", description: "Favourite songs and a joyful final chapter to the evening." }
      ]
    }
  ];
  const freeze = value => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(fixtures);
  const get = id => fixtures.find(item => item.id === id &&
    item.classification === "author-owned-fictional-inspiration") || null;
  function starter(id) {
    const source = get(id);
    if (!source) throw new Error("Choose a listed fictional inspiration style.");
    // Explicit allowlist: no fictional identities, dates, places, prices or state.
    return {
      palette: [...source.palette],
      venues: source.events.map((event, index) => ({
        name: event.name, time: "", eventDate: "", address: "", map: "",
        description: `Sample wording - personalize: ${event.description}`,
        kind: event.kind, isMain: index === source.events.findIndex(item => item.kind === "main")
      }))
    };
  }
  function publicDesign(palette) {
    if (!Array.isArray(palette) || palette.length > 4 || !palette.every(color => /^#[0-9a-f]{6}$/i.test(color))) {
      throw new Error("This public wedding's colours cannot be reused. Choose another style.");
    }
    return {
      classification: "public-design-only",
      palette: fixtures[0].palette.map((color, index) => palette[index] || color),
      venues: [
        { name: "Your ceremony", time: "", eventDate: "", address: "", map: "",
          description: "Add your own ceremony plans and accessibility guidance.", kind: "main", isMain: true },
        { name: "Your reception", time: "", eventDate: "", address: "", map: "",
          description: "Add your own reception programme and guest guidance.", kind: "main", isMain: false }
      ]
    };
  }
  root.WSInspiration = Object.freeze({ fixtures, get, starter, publicDesign });
})(globalThis);
