(function () {
  "use strict";
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  window.WSGuestPreview = preview;
  window.WSGuestFetch = async (input, options = {}) => {
    if (!preview) return window.fetch(input, options);
    const url = new URL(input, location.href);
    if (url.origin !== location.origin || url.pathname !== "/api/guest" ||
        (options.method || "GET") !== "GET") throw new Error("Guest actions are disabled in this private preview.");
    // Same-origin parent capability, not a message handler or a public preview token.
    if (parent === window || parent.location.origin !== location.origin || !parent.WSInteractiveGuest) {
      throw new Error("Open this private preview from your signed-in wedding editor.");
    }
    const bundle = await parent.WSInteractiveGuest.data();
    const action = url.searchParams.get("action");
    const data = Object.hasOwn(bundle, action) ? bundle[action] : { error: "Not available in private preview." };
    return new Response(JSON.stringify(data), { status: Object.hasOwn(bundle, action) ? 200 : 404,
      headers: { "Content-Type": "application/json" } });
  };
  if (!preview) return;
  document.addEventListener("submit", event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  document.addEventListener("ws:preview-ready", async () => {
    if (parent === window || parent.location.origin !== location.origin || !parent.WSInteractiveGuest) return;
    document.body.dataset.privatePreview = "true";
    const mapping = {
      welcome: "couple", story: "couple", details: "theme", venues: "venues", prewedding: "venues",
      campaigns: "campaigns", registry: "giving", rsvp: "guests", bids: "giving",
      "sponsor-tiers": "giving", "vip-section": "giving", sponsors: "giving",
      "info-section": "extras", guestbook: "extras", ledger: "extras"
    };
    for (const [id, step] of Object.entries(mapping)) {
      const section = document.getElementById(id);
      if (!section) continue;
      section.hidden = false;
      section.dataset.editSection = step;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preview-edit";
      button.textContent = `Edit ${id === "welcome" ? "welcome" : id === "vip-section" ? "VIP" : id === "sponsor-tiers" ? "packages" : id}`;
      if (id === "welcome") section.querySelector(".hero-content").prepend(button);
      else section.prepend(button);
    }
    for (const [id, text] of [
      ["vip-display", "Your VIP offering stays here. Set your own price and actual seat inventory before offering seats."],
      ["tiers-display", "Your sponsor packages stay here. Set your own prices and benefits."],
      ["registry-list", "Your gift registry stays here. Add a goal in your wedding currency."]
    ]) {
      const element = document.getElementById(id);
      if (element && !element.children.length) element.textContent = text;
    }
    const data = await parent.WSInteractiveGuest.data();
    if (data.fundraising.draftVip && !data.fundraising.vip) {
      const target = document.getElementById("vip-display");
      target.textContent = `${data.fundraising.draftVip.title}: ${data.fundraising.draftVip.description} (Preview offering: price and actual inventory not confirmed.)`;
    }
    const defaults = {};
    for (const field of WSWeddingContent.fields) {
      const element = document.getElementById(field.section)?.querySelector(field.selector);
      if (element) defaults[field.key] = element.textContent;
    }
    parent.WSInteractiveGuest.wording(defaults);
    const dateButton = document.createElement("button");
    dateButton.type = "button";
    dateButton.className = "preview-edit";
    dateButton.dataset.editStep = "date";
    dateButton.textContent = "Edit wedding date & location";
    document.getElementById("wedding-date-display")?.after(dateButton);
    const sampleNote = document.createElement("p");
    sampleNote.className = "notice";
    sampleNote.textContent = "Private preview: fictional showcase wording and sample venues are editable placeholders, not confirmed facts. Real activity is empty. Replace sample details and review your content before publishing.";
    document.getElementById("welcome").before(sampleNote);
    for (const id of ["seating", "ecard", "share-section"]) {
      const section = document.getElementById(id);
      if (!section) continue;
      section.hidden = false;
      const note = document.createElement("p");
      note.className = "notice";
      note.textContent = "System-managed preview. Sharing, seat lookup and guest passes activate only on the published site for actual guests. No seat is assigned and no valid pass or QR ticket exists here.";
      section.prepend(note);
    }
    document.getElementById("qrcode").textContent = "Preview only - not valid for entry";
    document.getElementById("ecard-guest-name").textContent = "A guest's pass will appear here after their actual RSVP.";
    document.getElementById("reuse-wedding-style").hidden = true;
    document.querySelectorAll("input, select, textarea, form button, [data-buy], [data-song-bid], #no-bids-cta, #ics-download, [data-ws-copy], [data-ws-share], [data-ws-ics]").forEach(input => { input.disabled = true; });
    document.querySelectorAll(".ws-share-block a").forEach(anchor => {
      anchor.setAttribute("aria-disabled", "true");
      anchor.tabIndex = -1;
    });
    document.addEventListener("click", event => {
      const section = event.target.closest("[data-edit-section]");
      if (section) {
        event.preventDefault();
        event.stopImmediatePropagation();
        parent.WSInteractiveGuest.edit(event.target.closest("[data-edit-step]")?.dataset.editStep || section.dataset.editSection, section.id);
      } else if (event.target.closest("button, a")) {
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
})();
