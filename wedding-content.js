(function (root) {
  "use strict";
  const sections = {
    welcome: [".eyebrow", ".hero-tag", ".hero-side"],
    story: ["h2"], details: ["h2", ".palette-label"], venues: ["h2"],
    prewedding: ["h2", ":scope > p.fine"], campaigns: ["h2", ":scope > p.fine"],
    registry: ["h2", ":scope > p.fine"], rsvp: ["h2"], bids: ["h2"],
    ledger: ["h2", ":scope > p.fine"], "sponsor-tiers": ["h2"],
    "vip-section": ["h2", ":scope > p.fine"], sponsors: ["h2", ":scope > p.fine"],
    "info-section": ["h2", "h3"], guestbook: ["h2"]
  };
  const fields = Object.entries(sections).flatMap(([section, selectors]) =>
    selectors.map((selector, index) => ({ key: `${section}:${index}`, section, selector })));
  function normalize(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !fields.some(field => field.key === key)) ||
        Object.values(value).some(text => typeof text !== "string" || text.length > 2000)) {
      throw new Error("Check your page wording. Use plain text of up to 2,000 characters per field.");
    }
    return { ...value };
  }
  function apply(document, value) {
    for (const field of fields) {
      if (!Object.hasOwn(value || {}, field.key)) continue;
      const element = document.getElementById(field.section)?.querySelector(field.selector);
      if (element) { element.textContent = value[field.key]; element.hidden = !value[field.key].trim(); }
    }
  }
  root.WSWeddingContent = { fields, normalize, apply };
})(globalThis);
