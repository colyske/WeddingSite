// AI guidance suggestions for wedding planning
// Provides helpful hints without requiring external API

window.WeddingSiteAI = {
  // Story suggestions based on common wedding narratives
  storyHints: [
    "Share how you met and what made you realize they were the one",
    "Describe a meaningful moment in your relationship",
    "Tell guests about your journey together",
    "Share what you love most about your partner",
    "Describe your favorite memory together"
  ],

  // Venue description hints
  venueHints: [
    "Include parking information and directions",
    "Mention nearest public transportation",
    "Note the dress code if relevant (e.g., 'Formal. Expect outdoor conditions')",
    "Add details about accessibility (elevators, wheelchair access)",
    "Describe the ambiance (formal, casual, garden, ballroom, etc.)"
  ],

  // Attire guidance
  attireHints: [
    "Include color suggestions for coordination",
    "Mention the dress code (black-tie, semi-formal, cocktail, casual)",
    "Note seasonal considerations",
    "Suggest shoe comfort for venue type",
    "Mention any cultural or religious dress considerations"
  ],

  // Registry/fundraising tips
  fundraisingHints: [
    "Add 2-3 fundraising milestones for progress visualization",
    "Consider $500-$2000 ranges for major expenses",
    "Provide clear information about where funds will go",
    "Set a realistic goal based on guest count",
    "Consider tax/platform fee implications"
  ],

  // Itinerary/program suggestions
  programHints: [
    "Include ceremony start time and length",
    "Add reception schedule (dinner, speeches, dancing)",
    "Note any interactive elements (first dance, games, etc.)",
    "Provide timing for photo opportunities",
    "Include Q&A or special moments"
  ],

  // RSVP/dietary guidance
  rsvpHints: [
    "Offer 3-4 dietary preference options plus 'Other'",
    "Set RSVP deadline 2-3 weeks before event",
    "Ask about plus-one preferences upfront",
    "Include accessibility/mobility questions if relevant",
    "Provide a way to contact organizers with questions"
  ],

  // Get contextual hint for a field
  getHint(fieldType) {
    const hints = this[fieldType + "Hints"] || [];
    return hints[Math.floor(Math.random() * hints.length)] || "Complete this field";
  },

  // Generate full story using template
  generateStoryTemplate() {
    return `Our story began when we met [where/how]. Since then, [what makes us special together]. 
We can't wait to celebrate with all of you and start this new chapter.`;
  },

  // Suggest registry milestones
  suggestMilestones(guestCount, weddingBudget) {
    const budgetPerGuest = weddingBudget / (guestCount || 100);
    const scaled = Math.round(budgetPerGuest * guestCount * 0.3); // 30% as fundraising target

    return [
      { name: "Honeymoon", target: Math.round(scaled * 0.4) },
      { name: "Home Setup", target: Math.round(scaled * 0.3) },
      { name: "Future Together", target: Math.round(scaled * 0.3) }
    ];
  },

  // DJ bidding guidance
  djGuidance() {
    return {
      minBid: 5,
      suggestedBid: 25,
      maxBidShown: 100,
      tips: [
        "Set starting bid to encourage participation",
        "Higher bids get top-of-queue placement",
        "Consider setting a budget or max bids",
        "Show real-time leaderboard to drive engagement"
      ]
    };
  },

  // Venue mapping suggestions
  venueMapping() {
    return {
      googleMapsFormat: "https://maps.google.com/?q={lat},{lng}",
      appleFormat: "https://maps.apple.com/?q={lat},{lng}",
      example: "Get coordinates from Google Maps, Apple Maps, or GPS"
    };
  },

  // General wedding planning checklist
  planningChecklist() {
    return [
      "Create and publish your wedding site (this!)",
      "Invite guests and share the site link",
      "Set your color palette and design",
      "Add venue details with maps",
      "Write your couple story",
      "Set up DJ song bidding or playlist",
      "Configure registry/fundraising milestones",
      "Set RSVP deadline",
      "Monitor guest responses and contributions",
      "Coordinate with vendors using wedding site"
    ];
  }
};
