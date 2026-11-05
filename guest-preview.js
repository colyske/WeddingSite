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
  document.addEventListener("ws:preview-ready", () => {
    if (parent === window || parent.location.origin !== location.origin || !parent.WSInteractiveGuest) return;
    document.body.dataset.privatePreview = "true";
    const mapping = {
      welcome: "couple", story: "couple", details: "theme", venues: "venues", prewedding: "venues",
      campaigns: "campaigns", registry: "giving", rsvp: "guests", bids: "giving",
      "sponsor-tiers": "giving", "vip-section": "giving", sponsors: "giving",
      "faq-section": "extras", "travel-section": "extras"
    };
    for (const [id, step] of Object.entries(mapping)) {
      const section = document.getElementById(id);
      if (!section) continue;
      section.hidden = false;
      section.dataset.editSection = step;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preview-edit";
      button.textContent = `Edit ${section.querySelector("h2")?.textContent || (step === "couple" ? "couple & welcome" : step)}`;
      section.prepend(button);
    }
    for (const [id, text] of [
      ["vip-display", "Your VIP offering stays here. Set your own price and actual seat inventory before offering seats."],
      ["tiers-display", "Your sponsor packages stay here. Set your own prices and benefits."],
      ["registry-list", "Your gift registry stays here. Add a goal in your wedding currency."]
    ]) {
      const element = document.getElementById(id);
      if (element && !element.children.length) element.textContent = text;
    }
    const dateButton = document.createElement("button");
    dateButton.type = "button";
    dateButton.className = "preview-edit";
    dateButton.dataset.editStep = "date";
    dateButton.textContent = "Edit wedding date & location";
    document.getElementById("wedding-date-display")?.after(dateButton);
    for (const id of ["seating", "ecard", "share-section", "reuse-wedding-style"]) {
      const section = document.getElementById(id);
      if (section) section.hidden = true;
    }
    document.querySelectorAll("input, select, textarea").forEach(input => { input.disabled = true; });
    document.addEventListener("click", event => {
      const section = event.target.closest("[data-edit-section]");
      if (section) {
        event.preventDefault();
        event.stopImmediatePropagation();
        parent.WSInteractiveGuest.edit(event.target.closest("[data-edit-step]")?.dataset.editStep || section.dataset.editSection);
      } else if (event.target.closest("button, a")) {
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
})();
