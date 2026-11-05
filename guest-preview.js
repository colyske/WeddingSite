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
  let ready = false;
  function addEditor(section, label, step, kind, primary = false) {
    if (document.querySelector(`.preview-edit[data-edit-section-id="${section.id}"][data-edit-kind="${kind}"]`)) return;
    const targets = {
      names: "#couple-names", story: "#welcome-story", palette: "#palette-preview",
      attire: "#attire-notes-display", date: "#wedding-date-display", location: "#wedding-location",
      music: "#audio-toggle", cover: ".hero-image", address: ".preview-address",
      currency: "#campaigns-display", campaigns: "#campaigns-display", registry: "#registry-list",
      packages: "#tiers-display", vip: "#vip-display", featured: "#sponsor-auction",
      rsvp: "#rsvp-form", fees: "#rsvp-form", songs: "#song-request-form",
      venues: "#venues-display", prewedding: "#prewedding-display",
      travel: "#info-section > p", faq: "#info-section details", wording: "h2"
    };
    const target = kind === "music" ? document.getElementById("audio-toggle") :
      (kind === "location" ? document.getElementById("wedding-location") :
        kind === "currency" ? document.getElementById("campaigns-display") : section.querySelector(targets[kind]));
    const anchor = target || section.querySelector("h2") || section;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-edit";
    button.dataset.editStep = step;
    button.dataset.editKind = kind;
    button.dataset.editSectionId = section.id;
    button.dataset.editTarget = targets[kind];
    button.setAttribute("aria-label", label);
    if (primary) button.dataset.primaryEditor = "true";
    button.textContent = label;
    if (kind === "cover") {
      button.classList.add("preview-cover-edit");
      section.append(button);
    } else if (kind === "address") {
      anchor.append(button);
    } else if (anchor === section) {
      section.prepend(button);
    } else {
      anchor.after(button);
    }
  }
  async function enhance() {
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
      const editors = {
        welcome: ["Edit names", "names"], story: ["Edit story", "story"], details: ["Edit colours", "palette"],
        venues: ["Edit programme", "venues"], prewedding: ["Edit activities", "prewedding"],
        campaigns: ["Edit funds", "campaigns"], registry: ["Edit registry", "registry"], rsvp: ["Edit RSVP", "rsvp"],
        bids: ["Song settings", "songs"], "sponsor-tiers": ["Edit packages", "packages"], "vip-section": ["Edit VIP", "vip"],
        sponsors: ["Edit sponsor placement", "featured"], "info-section": ["Edit travel", "travel"],
        guestbook: ["Edit guestbook wording", "wording"], ledger: ["Edit ledger wording", "wording"]
      };
      addEditor(section, editors[id][0], step, editors[id][1], true);
      if (WSWeddingContent.fields.some(field => field.section === id) && editors[id][1] !== "wording") {
        addEditor(section, "Edit section wording", step, "wording");
      }
      if (id === "details") addEditor(section, "Edit dress guidance", step, "attire");
      if (id === "info-section") addEditor(section, "Edit FAQ", step, "faq");
      if (id === "rsvp") addEditor(section, "RSVP fees & meals", step, "fees");
    }
    // Extras can arrive after the main renderer. Disable newly inserted controls synchronously.
    document.querySelectorAll("input, select, textarea, form button, [data-buy], [data-song-bid], #no-bids-cta, #ics-download, [data-ws-copy], [data-ws-share], [data-ws-ics]").forEach(input => { input.disabled = true; });
    document.querySelectorAll(".ws-share-block a").forEach(anchor => {
      anchor.setAttribute("aria-disabled", "true");
      anchor.tabIndex = -1;
    });
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
    const welcome = document.getElementById("welcome");
    addEditor(document.getElementById("campaigns"), `Currency: ${data.site.wedding.currency}`, "money", "currency");
    addEditor(welcome, "Edit cover photo", "couple", "cover");
    addEditor(welcome, "Edit date & time zone", "date", "date");
    addEditor(welcome, "Edit location", "date", "location");
    addEditor(welcome, "Background music", "date", "music");
    let address = welcome.querySelector(".preview-address");
    if (!address) {
      address = document.createElement("p");
      address.className = "preview-address";
      address.hidden = !data.site.wedding.couple_names?.trim();
      const url = document.createElement("span");
      url.textContent = `https://${data.site.wedding.slug}.joinourwedding.site`;
      address.append(url);
      welcome.querySelector('[data-edit-kind="date"]').after(address);
    }
    addEditor(welcome, "Edit wedding address", "couple", "address");
    if (!document.getElementById("private-preview-note")) {
      const sampleNote = document.createElement("p");
      sampleNote.id = "private-preview-note";
      sampleNote.className = "notice";
      sampleNote.textContent = "Private preview. Guest actions are disabled. Review your content before publishing.";
      welcome.before(sampleNote);
    }
    for (const id of ["seating", "ecard", "share-section"]) {
      const section = document.getElementById(id);
      if (!section) continue;
      section.hidden = false;
      if (section.querySelector(".preview-system-note")) continue;
      const note = document.createElement("p");
      note.className = "notice preview-system-note";
      note.textContent = "System-managed preview. Sharing, seat lookup and guest passes activate only on the published site for actual guests. No seat is assigned and no valid pass or QR ticket exists here.";
      section.prepend(note);
    }
    document.getElementById("qrcode").textContent = "Preview only - not valid for entry";
    document.getElementById("ecard-guest-name").textContent = "A guest's pass will appear here after their actual RSVP.";
    document.getElementById("reuse-wedding-style").hidden = true;
  }
  function refreshEditors() {
    if (!ready) return;
    enhance().catch(error => {
      const note = document.getElementById("private-preview-note") || document.createElement("p");
      note.id = "private-preview-note";
      note.className = "notice bad";
      note.setAttribute("role", "alert");
      note.textContent = `Private preview could not finish loading: ${error.message}`;
      if (!note.isConnected) document.body.prepend(note);
    });
  }
  document.addEventListener("ws:preview-ready", () => { ready = true; refreshEditors(); });
  document.addEventListener("ws:extras-ready", refreshEditors);
  document.addEventListener("click", event => {
      const explicit = event.target.closest("[data-edit-step]");
      const section = explicit ? document.getElementById(explicit.dataset.editSectionId) : event.target.closest("[data-edit-section]");
      if (section) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const editor = explicit || section.querySelector("[data-primary-editor]");
        parent.WSInteractiveGuest.edit(editor?.dataset.editStep || section.dataset.editSection, section.id, editor?.dataset.editKind);
      } else if (event.target.closest("button, a")) {
        const anchor = event.target.closest('a[href^="#"]');
        if (anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
  }, true);
})();
