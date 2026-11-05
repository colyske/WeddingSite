(function (global) {
  "use strict";

  const validText = value => typeof value === "string" && value.trim().length > 0;
  const validSlug = value => /^[a-z0-9-]{3,80}$/.test(String(value || ""));
  const validDate = value => {
    const text = String(value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
  };
  const validCover = value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  };

  function calculate(wedding = {}) {
    const venues = Array.isArray(wedding.venues) ? wedding.venues : [];
    const features = wedding.revenue_features || {};
    const campaigns = Array.isArray(wedding.campaigns) ? wedding.campaigns : [];
    const registry = Array.isArray(wedding.registry) ? wedding.registry : [];
    const tiers = Array.isArray(wedding.tiers) ? wedding.tiers : [];
    const capabilities = Array.isArray(wedding.collectionCapabilities) ? wedding.collectionCapabilities : [];
    const hasEvent = venues.some(venue => venue.kind !== "pre") && venues.every(venue =>
      validText(venue.name) && validText(venue.event_time) && validDate(venue.event_date) && validText(venue.address));
    const supportedCurrency = capabilities.some(currency =>
      currency.code === wedding.currency && Array.isArray(currency.methods) && currency.methods.length > 0);
    const hasFundraisingRoute = supportedCurrency && (wedding.interactive_creation
      ? campaigns.some(campaign => campaign.enabled !== false && campaign.currency === wedding.currency && Number(campaign.goal_minor) > 0)
      : (
      features.song_requests === true ||
      features.giving !== false && (registry.length > 0 || campaigns.some(campaign => campaign.enabled !== false)) ||
      features.sponsors !== false && tiers.length > 0 ||
      features.vip_seating !== false && Number(wedding.vip?.price_minor) > 0
    ));
    const publishRequired = [
      { id: "couple-names", label: "Add the couple names and a site address",
        complete: validText(wedding.couple_names) && validSlug(wedding.slug), anchor: "couple" },
      { id: "wedding-date", label: "Set the wedding date",
        complete: validDate(wedding.wedding_date), anchor: "date" },
      { id: "venues-section", label: "Add a complete wedding-day event with a name, date, time and street address",
        complete: hasEvent, anchor: "venues" },
      { id: "welcome-story", label: "Write a short welcome story",
        complete: validText(wedding.welcome_story), anchor: "couple" },
      { id: "fundraising-route", label: wedding.interactive_creation
        ? "Keep a visible celebration fund with a positive goal in your wedding currency and a configured guest-payment option"
        : "Set up a fundraising option in a currency with a configured guest-payment option",
        complete: hasFundraisingRoute, anchor: supportedCurrency ? wedding.interactive_creation ? "campaigns" : "giving" : "money",
        help: supportedCurrency ? "A guest-payment option is configured for this currency; payout readiness is separate." :
          "No live guest-payment option is currently ready for this currency. We never convert amounts or enable payment methods automatically." }
    ].map(item => ({ ...item, required: true }));
    const optional = [
      { id: "cover-image-url", label: "Add a public HTTPS cover photo",
        complete: validCover(wedding.cover_image_url), anchor: "couple" },
      { id: "guest-instructions", label: "Tell guests what they need to know before RSVPing",
        complete: validText(wedding.guest_instructions), anchor: "guests" },
      { id: "palette-preview", label: "Choose a wedding theme palette",
        complete: Array.isArray(wedding.palette) && wedding.palette.length > 0, anchor: "theme" },
      { id: "travel-info", label: "Add travel information",
        complete: validText(wedding.siteContent?.travel_notes || wedding.siteContent?.travel_approved || wedding.travel_info), anchor: "extras" },
      { id: "faq", label: "Answer common guest questions",
        complete: Array.isArray(wedding.faq) && wedding.faq.length > 0, anchor: "extras" },
    ].map(item => ({ ...item, required: false }));
    const items = [...publishRequired, ...optional];
    const requiredReady = publishRequired.every(item => item.complete) && !wedding.archived_at;
    return { items, requiredReady, nextStep: items.find(item => !item.complete) || null };
  }

  function render(target, wedding, { compact = false, editorUrl = "" } = {}) {
    if (!target) return;
    if (!document.getElementById("ws-setup-styles")) {
      const style = document.createElement("style");
      style.id = "ws-setup-styles";
      style.textContent = `
        .ws-readiness h2{margin-top:0}.ws-readiness p{max-width:70ch}
        .ws-readiness-list{list-style:none;padding:0;display:grid;gap:.55rem}
        .ws-readiness-list li{display:flex;gap:.6rem;align-items:flex-start;padding:.6rem .75rem;border-radius:10px;border:1px solid;border-left-width:5px}
        .ws-readiness-list li.complete{color:#1f4f30;background:#eef8f1;border-color:#9ccfad}
        .ws-readiness-list li.incomplete{color:#5c3a12;background:#fff6e5;border-color:#e3b66a}
        .ws-readiness-list li.optional{color:#3f4a5a;background:#f4f5f8;border-color:#c5cad6}
        .ws-readiness-list a{color:inherit}
        .ws-readiness-mark{font-size:1.15rem;font-weight:700;line-height:1.2}
        .ws-readiness-list small{display:block;color:inherit;opacity:.85;margin-top:.15rem}
        .ws-readiness-footnote{font-size:.84rem;color:#6b756e}
      `;
      document.head.appendChild(style);
    }
    const readiness = calculate(wedding);
    const list = compact ? readiness.items.filter(item => item.required && !item.complete) : readiness.items;
    const href = item => `${editorUrl || ""}#step=${encodeURIComponent(item.anchor)}`;
    target.innerHTML = `
      <div class="ws-readiness">
        <h2>Before your wedding can go live</h2>
        <p class="${readiness.requiredReady ? "ws-ready" : "ws-needs-attention"}">
          ${readiness.requiredReady ? "Your required setup is ready for publication review." :
            "You’re making progress. Complete the items below when you’re ready; you can save your draft at any point."}
        </p>
        ${readiness.nextStep ? `<p><a href="${href(readiness.nextStep)}">Next helpful step: ${escapeHtml(readiness.nextStep.label)} →</a></p>` : ""}
        <ul class="ws-readiness-list">${list.map(item => `
          <li class="${item.complete ? "complete" : item.required ? "incomplete" : "optional"}">
            <span class="ws-readiness-mark" aria-hidden="true">${item.complete ? "✓" : item.required ? "!" : "○"}</span>
            <span><a href="${href(item)}">${escapeHtml(item.label)}</a>
              <small>${item.complete ? "Done" : item.required ? "Needed before publishing" : "Optional"}</small>
              ${item.help ? `<small>${escapeHtml(item.help)}</small>` : ""}
            </span>
          </li>`).join("")}</ul>
        <p class="ws-readiness-footnote">Drafts can be saved before everything is ready. Guest-payment availability is not proof of payout readiness; private identity and payout checks stay separate.</p>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  global.WSSetupProgress = { calculate, render };
})(window);
