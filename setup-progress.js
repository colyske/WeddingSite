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
  const validColor = value => /^#[0-9a-f]{6}$/i.test(String(value || ""));

  function calculate(wedding = {}) {
    const venues = Array.isArray(wedding.venues) ? wedding.venues : [];
    const palette = Array.isArray(wedding.palette) ? wedding.palette.filter(validColor) : [];
    const site = wedding.siteContent || {};
    const story = wedding.welcome_story || site.story_draft || site.story_approved;
    const travel = site.travel_notes || site.travel_approved || wedding.travel_info;
    const hasEvent = venues.some(venue => validText(venue.name) && validText(venue.event_time) &&
      validDate(venue.event_date || wedding.wedding_date));
    const paidFeatures = Number(wedding.rsvp_fee_minor) > 0 || Number(wedding.extra_guest_fee_minor) > 0 ||
      Number(wedding.premium_diet_fee_minor) > 0 || (Array.isArray(wedding.registry) && wedding.registry.length > 0) ||
      (Array.isArray(wedding.campaigns) && wedding.campaigns.some(campaign => campaign.enabled !== false)) ||
      (Array.isArray(wedding.tiers) && wedding.tiers.length > 0) || Boolean(wedding.vip);
    const hasDirections = venues.some(venue => validText(venue.address) || validText(venue.map_link));
    const publishRequired = [
      { id: "couple-names", label: "Add the couple names and a valid site address", complete: validText(wedding.couple_names) && validSlug(wedding.slug), anchor: "couple-names" },
      { id: "wedding-date", label: "Set the wedding date", complete: validDate(wedding.wedding_date), anchor: "wedding-date" },
      { id: "venues-section", label: "Add an event with its date and start time", complete: hasEvent, anchor: "venues-section" },
      { id: "kyc-section", label: "Submit both partners’ KYC details", complete: wedding.kyc_submitted === true, anchor: "kyc-section",
        help: "Submission is checked for completeness; identity documents are not independently verified by Join Our Wedding." }
    ].map(item => ({ ...item, required: true }));
    const optional = [
      { id: "welcome-story", label: "Write a welcome story", complete: validText(story), anchor: "welcome-story" },
      { id: "palette-preview", label: "Choose a wedding theme palette", complete: palette.length > 0, anchor: "palette-preview",
        help: "Optional; a palette can be removed entirely." },
      { id: "venues-section", label: "Add an address or map link for directions", complete: hasDirections, anchor: "venues-section" },
      { id: "travel-info", label: "Add travel information for guests", complete: validText(travel), anchor: "travel-info" }
    ].map(item => ({ ...item, required: false }));
    const payoutItem = paidFeatures ? [{
      id: "payout-method", label: "Set up a payout method for paid features",
      complete: wedding.payout?.verified === true, anchor: "payout-method",
      required: false,
      help: "Only included because at least one paid feature is configured."
    }] : [];
    const items = [...publishRequired, ...payoutItem, ...optional];
    const completed = items.filter(item => item.complete).length;
    const percent = items.length ? Math.round(completed / items.length * 100) : 0;
    const requiredReady = publishRequired.every(item => item.complete) && !wedding.archived_at;
    return {
      items, percent, completed, total: items.length, requiredReady,
      nextStep: items.find(item => !item.complete) || null
    };
  }

  function colorAt(percent) {
    const hue = 28 + Math.max(0, Math.min(100, percent)) * 1.05;
    return `hsl(${hue} 78% 42%)`;
  }

  function render(target, wedding, { compact = false, editorUrl = "" } = {}) {
    if (!target) return;
    if (!document.getElementById("ws-setup-styles")) {
      const style = document.createElement("style");
      style.id = "ws-setup-styles";
      style.textContent = `
        .ws-setup-summary{display:flex;align-items:center;gap:1rem;margin:.5rem 0 1rem}
        .ws-setup-ring{width:88px;height:88px;flex:0 0 88px;border-radius:50%;display:grid;place-items:center;
          background:conic-gradient(var(--ws-progress-color) var(--ws-progress),#e5e5dd 0);position:relative}
        .ws-setup-ring:before{content:"";position:absolute;inset:9px;border-radius:50%;background:#fff}
        .ws-setup-ring span{position:relative;font-size:1.15rem;font-weight:700;color:#27382e}
        .ws-setup-copy{display:grid;gap:.22rem}
        .ws-setup-copy strong{font-size:1.05rem}
        .ws-ready{color:#26723c;font-weight:700}.ws-needs-attention{color:#9a4a12;font-weight:700}
        .ws-setup-next,.ws-setup-checklist a{color:inherit;text-decoration:underline;text-underline-offset:2px}
        .ws-setup-checklist{list-style:none;padding:0;display:grid;gap:.65rem}
        .ws-setup-checklist li{display:flex;gap:.6rem;align-items:flex-start}
        .ws-setup-checklist li.complete{color:#285d39}.ws-setup-checklist li.incomplete{color:#6e461e}
        .ws-checkmark{font-size:1.15rem;font-weight:700;line-height:1.2}
        .ws-setup-checklist small{display:block;color:#66736a;margin-top:.15rem}
        .ws-setup-footnote{font-size:.84rem;color:#6b756e;margin:.5rem 0}
        @media(prefers-reduced-motion:reduce){.ws-setup-ring{transition:none!important}}
      `;
      document.head.appendChild(style);
    }
    const progress = calculate(wedding);
    const color = colorAt(progress.percent);
    const list = compact ? progress.items.filter(item => !item.complete).slice(0, 2) : progress.items;
    const nextHref = item => `${editorUrl || ""}#${encodeURIComponent(item.anchor)}`;
    target.innerHTML = `
      <div class="ws-setup-summary">
        <div class="ws-setup-ring" role="progressbar" aria-label="Wedding site setup completion"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"
          aria-valuetext="${progress.percent}% complete; ${progress.completed} of ${progress.total} setup steps"
          style="--ws-progress:${progress.percent}%;--ws-progress-color:${color}">
          <span>${progress.percent}%</span>
        </div>
        <div class="ws-setup-copy">
          <strong>Wedding site setup</strong>
          <span>${progress.completed} of ${progress.total} steps complete</span>
          <span class="${progress.requiredReady ? "ws-ready" : "ws-needs-attention"}">
            ${progress.requiredReady ? "Required to publish: ready" : "Required to publish: incomplete"}
          </span>
          ${progress.nextStep ? `<a class="ws-setup-next" href="${nextHref(progress.nextStep)}">Next: ${escapeHtml(progress.nextStep.label)} →</a>` : "<span>Everything on the setup checklist is complete.</span>"}
        </div>
      </div>
      ${compact ? "" : `<ul class="ws-setup-checklist">${list.map(item => `
        <li class="${item.complete ? "complete" : "incomplete"}">
          <span class="ws-checkmark" aria-hidden="true">${item.complete ? "✓" : "○"}</span>
          <span><a href="${nextHref(item)}">${escapeHtml(item.label)}</a>
            ${item.required ? `<small>Required to publish</small>` : ""}
            ${item.help ? `<small>${escapeHtml(item.help)}</small>` : ""}
          </span>
        </li>`).join("")}</ul>`}
      <p class="ws-setup-footnote">Progress reflects saved wedding details. Optional paid features are excluded unless you configure one.</p>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  global.WSSetupProgress = { calculate, render, colorAt };
})(window);
