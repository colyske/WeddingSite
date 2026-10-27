// Dashboard front-end: one state object, render functions, delegated events.
// The create form is never submitted natively; values live in `state` and are only
// cleared after the API confirms success.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const HEX = /^#[0-9a-f]{6}$/i;
  const DEFAULT_PALETTE = ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"];
  const DEFAULT_FIELDS = { names: "", date: "", timeZone: window.WSTime ? window.WSTime.browserZone() : "Africa/Nairobi", location: "", currency: "USD", capacity: "150" };

  let nextVenueId = 1;
  const newVenue = () => ({ id: nextVenueId++, name: "", time: "", eventDate: "", address: "", map: "", description: "" });

  const state = {
    fields: { ...DEFAULT_FIELDS },
    palette: [...DEFAULT_PALETTE],
    paletteOpen: false,
    venues: [newVenue()],
    mainVenueId: 1,
    submitting: false,
    notice: null,
    created: null,
    weddings: null,
    weddingsError: ""
  };

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeColor = (c) => (HEX.test(c) ? c : "#cccccc");
  const setNotice = (text, kind, target) => { state.notice = text ? { text, bad: kind === "bad" } : null; renderNotice(); if (text && window.WSFeedback) { WSFeedback.toast(text, kind === "bad"); WSFeedback.scrollTo(target || (kind === "bad" ? "notice" : "created")); } };

  function renderNotice() {
    const el = $("notice");
    el.hidden = !state.notice;
    el.textContent = state.notice ? state.notice.text : "";
    el.className = "notice" + (state.notice && state.notice.bad ? " bad" : "");
  }

  function renderFields() {
    const map = { "couple-names": "names", "wedding-date": "date", "wedding-timezone": "timeZone", location: "location", currency: "currency", "max-capacity": "capacity" };
    for (const [id, key] of Object.entries(map)) {
      const el = $(id);
      if (el.value !== state.fields[key]) el.value = state.fields[key];
    }
  }

  function renderPalette() {
    state.palette.forEach((color, i) => {
      $(`swatch-${i + 1}`).style.background = safeColor(color);
      const input = $(`color-${i + 1}`);
      if (input.value !== color) input.value = color;
    });
    $("palette-editor").hidden = !state.paletteOpen;
    $("edit-palette").setAttribute("aria-expanded", String(state.paletteOpen));
    $("edit-palette").textContent = state.paletteOpen ? "✕ Close colours" : "✎ Edit colours";
  }

  function renderVenues() {
    $("venues-container").innerHTML = state.venues.map((v, i) => `
      <div class="venue-item" data-venue-id="${v.id}">
        <label class="venue-main-label">
          <input type="radio" name="main-venue" data-action="set-main" data-id="${v.id}" ${v.id === state.mainVenueId ? "checked" : ""}>
          <span>Main venue</span>
        </label>
        <input type="text" data-venue-field="name" data-id="${v.id}" placeholder="${i === 0 ? "e.g. Church service" : "e.g. Reception, photo shoot, procession meeting point"}" maxlength="100" value="${esc(v.name)}" aria-label="Venue ${i + 1} name" required>
        <input type="date" data-venue-field="eventDate" data-id="${v.id}" value="${esc(v.eventDate || state.fields.date)}" aria-label="Event ${i + 1} date" required>
        <input type="time" data-venue-field="time" data-id="${v.id}" value="${esc(v.time)}" aria-label="Venue ${i + 1} time" required>
        <input type="text" data-venue-field="address" data-id="${v.id}" placeholder="Street address" maxlength="200" value="${esc(v.address)}" aria-label="Venue ${i + 1} address" required>
        <input type="url" data-venue-field="map" data-id="${v.id}" placeholder="Map link (Google Maps, Apple Maps, etc.)" maxlength="500" value="${esc(v.map)}" aria-label="Venue ${i + 1} map link">
        <textarea data-venue-field="description" data-id="${v.id}" placeholder="Notes (address, parking, dress code)" maxlength="500" aria-label="Venue ${i + 1} notes">${esc(v.description)}</textarea>
        <button type="button" class="remove-venue" data-action="remove-venue" data-id="${v.id}">✕ Remove venue</button>
      </div>`).join("");
  }

  function renderSubmit() {
    const btn = $("create-submit");
    btn.disabled = state.submitting;
    btn.textContent = state.submitting ? "⏳ Creating..." : "✨ Create wedding";
  }

  function renderCreated() {
    const el = $("created");
    const c = state.created;
    el.hidden = !c;
    el.innerHTML = c
      ? `<h3>🎉 Wedding created</h3><p><strong>${esc(c.names)}</strong>${c.location ? " · 📍 " + esc(c.location) : ""}</p>` +
        window.WSShare.panelHTML(window.WSShare.guestUrl(c.slug), { title: c.names, published: false }) +
        `<a class="btn" href="/wedding.html?id=${encodeURIComponent(c.weddingId)}&slug=${encodeURIComponent(c.slug)}">Open ${esc(c.names)} →</a>`
      : "";
  }

  function renderWeddings() {
    const list = state.weddings;
    $("empty").hidden = list !== null && list.length > 0;
    $("empty").textContent = state.weddingsError || (list === null ? "Loading your weddings…" : "No weddings yet. Create your first one above.");
    $("weddings-container").hidden = !list || list.length === 0;
    if (!list) return;
    $("weddings-grid").innerHTML = list.map((w) => `
      <div class="card">
        <div class="top" style="margin-bottom: .5rem;">
          <span class="tag ${w.published_at && !w.archived_at ? "live" : ""}">${statusLabel(w)}</span>
          <span class="fine">${esc(new Date(w.created_at).toLocaleDateString())}</span>
        </div>
        <h3>${esc(w.couple_names)}</h3>
        <p class="fine" style="margin: .5rem 0;">
          ${w.wedding_date ? "📅 " + esc(new Date(w.wedding_date).toLocaleDateString()) : "(Date required - open to set)"}
          ${w.public_location ? " • 📍 " + esc(w.public_location) : ""}
        </p>
        <p class="fine" style="margin: .5rem 0;">👥 Max ${esc(w.max_guest_capacity)} guests • ${esc(w.currency)}</p>
        <div class="swatches">${(w.palette || []).map((c) => `<span style="background: ${esc(safeColor(c))};"></span>`).join("")}</div>
        <div class="card" data-setup-progress="${esc(w.id)}" style="margin-top:1rem;padding:1rem;"></div>
        ${window.WSShare.panelHTML(window.WSShare.guestUrl(w.slug), { title: w.couple_names, published: !!w.published_at })}
        <div class="row" style="margin-top: 1.5rem;">
          <a class="btn" href="/wedding.html?id=${encodeURIComponent(w.id)}&slug=${encodeURIComponent(w.slug)}">✎ Edit</a>
          ${w.published_at ? `<a class="btn" href="/guest.html?slug=${encodeURIComponent(w.slug)}" target="_blank" rel="noopener">👁 View</a>` : ""}
        </div>
      </div>`).join("");
    for (const w of list) {
      const target = document.querySelector(`[data-setup-progress="${CSS.escape(String(w.id))}"]`);
      if (target && window.WSSetupProgress) {
        window.WSSetupProgress.render(target, w, {
          compact: true,
          editorUrl: `/wedding.html?id=${encodeURIComponent(w.id)}&slug=${encodeURIComponent(w.slug)}`
        });
      }
    }
  }

  const renderAll = () => { renderNotice(); renderFields(); renderPalette(); renderVenues(); renderSubmit(); renderCreated(); renderWeddings(); };

  function readFieldsFromDom() {
    state.fields = {
      names: $("couple-names").value,
      date: $("wedding-date").value,
      timeZone: $("wedding-timezone").value,
      location: $("location").value,
      currency: $("currency").value,
      capacity: $("max-capacity").value
    };
  }

  function validate() {
    const f = state.fields;
    const errors = [];
    const errorFields = [];
    
    if (!f.names.trim()) {
      errors.push("Couple names (required)");
      $("couple-names").setAttribute("aria-invalid", "true");
      errorFields.push($("couple-names"));
    } else {
      $("couple-names").removeAttribute("aria-invalid");
    }

    if (!f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
      errors.push("Wedding date (required)");
      $("wedding-date").setAttribute("aria-invalid", "true");
      errorFields.push($("wedding-date"));
    } else {
      $("wedding-date").removeAttribute("aria-invalid");
    }
    
    if (!f.location.trim()) {
      errors.push("Location (required)");
      $("location").setAttribute("aria-invalid", "true");
      errorFields.push($("location"));
    } else {
      $("location").removeAttribute("aria-invalid");
    }
    
    if (!f.currency || !/^[A-Z]{3}$/.test(f.currency)) {
      errors.push("Currency (required)");
      $("currency").setAttribute("aria-invalid", "true");
      errorFields.push($("currency"));
    } else {
      $("currency").removeAttribute("aria-invalid");
    }
    
    const cap = Number(f.capacity);
    if (!f.capacity.trim() || !Number.isInteger(cap) || cap < 1) {
      errors.push("Guest capacity (required, must be 1 or more)");
      $("max-capacity").setAttribute("aria-invalid", "true");
      errorFields.push($("max-capacity"));
    } else {
      $("max-capacity").removeAttribute("aria-invalid");
    }
    
    if (!state.palette.every((c) => HEX.test(c))) errors.push("Each colour must be valid");
    
    for (const [index, v] of state.venues.entries()) {
      const requiredVenueFields = [
        ["name", v.name.trim()], ["eventDate", v.eventDate || f.date],
        ["time", v.time], ["address", v.address.trim()]
      ];
      for (const [field, value] of requiredVenueFields) {
        const input = document.querySelector(`[data-venue-field="${field}"][data-id="${v.id}"]`);
        if (!value) {
          input?.setAttribute("aria-invalid", "true");
          errorFields.push(input);
        } else {
          input?.removeAttribute("aria-invalid");
        }
      }
      if (requiredVenueFields.some(([, value]) => !value)) {
        errors.push(`Event ${index + 1} needs a name, date, start time and street address`);
      }
      if (v.map.trim() && !/^https?:\/\//i.test(v.map.trim())) errors.push("Venue map links must start with http:// or https://");
    }
    
    if (errors.length) {
      const firstErrorField = errorFields[0] || $("couple-names");
      firstErrorField?.focus?.();
      return { message: "Please fix these required fields: " + errors.join(", "), field: firstErrorField };
    }
    return null;
  }

  function buildPayload() {
    const f = state.fields;
    const venues = state.venues
      .filter((v) => v.name.trim() || v.time || v.map.trim() || v.address.trim() || v.description.trim())
      .map((v) => ({
        name: v.name.trim(), time: v.time, eventDate: v.eventDate || state.fields.date,
        address: v.address.trim(), map: v.map.trim(), description: v.description.trim(),
        isMain: v.id === state.mainVenueId
      }));
    return {
      coupleNames: f.names.trim(),
      weddingDate: f.date || null,
      timeZone: f.timeZone,
      location: f.location.trim(),
      currency: f.currency,
      maxCapacity: Number(f.capacity),
      palette: [...state.palette],
      venues
    };
  }

  async function submitCreate() {
    if (state.submitting) return;
    readFieldsFromDom();
    setNotice("");
    state.created = null;
    renderCreated();

    const problem = validate();
    if (problem) return setNotice(problem.message, "bad", problem.field);
    if (!window.WS.token()) return setNotice("Your session has expired. Please sign in again; what you entered will be kept until you leave this page.", "bad");

    state.submitting = true;
    renderSubmit();
    setNotice("✨ Creating your wedding...");
    const payload = buildPayload();
    try {
      const res = await window.WS.api("/api/weddings?action=create", { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("Create wedding failed:", res.status, data);
        const msg = res.status === 401
          ? "Your session has expired. Please sign in again; what you entered is kept on this page."
          : data.error || `The server could not create the wedding (HTTP ${res.status}). Your details are kept; please try again.`;
        return setNotice(msg, "bad");
      }
      if (!data.weddingId) return setNotice("The server replied without a wedding id. Your details are kept; please try again.", "bad");

      state.created = { weddingId: data.weddingId, slug: data.slug, names: payload.coupleNames, location: payload.location };
      state.fields = { ...DEFAULT_FIELDS };
      state.palette = [...DEFAULT_PALETTE];
      state.paletteOpen = false;
      state.venues = [newVenue()];
      state.mainVenueId = state.venues[0].id;
      setNotice(`✨ ${payload.coupleNames} created successfully! Redirecting...`, "good");
      renderAll();
      
      // Auto-navigate to the newly created wedding after a brief delay
      setTimeout(() => {
        location.href = `/wedding.html?id=${encodeURIComponent(data.weddingId)}&slug=${encodeURIComponent(data.slug)}`;
      }, 2500);
    } catch (err) {
      console.error("Create wedding error:", err);
      setNotice(`Could not reach the server (${err.message}). Your details are kept; please check your connection and try again.`, "bad");
    } finally {
      state.submitting = false;
      renderSubmit();
    }
  }

  async function loadWeddings() {
    try {
      const res = await window.WS.api("/api/weddings?action=list");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        state.weddingsError = data.error || "Could not load your weddings.";
        state.weddings = null;
      } else {
        state.weddingsError = "";
        state.weddings = data.weddings || [];
      }
    } catch (err) {
      state.weddingsError = "Could not load your weddings (network error).";
    }
    renderWeddings();
  }

  const findVenue = (id) => state.venues.find((v) => v.id === Number(id));

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "sign-out") { window.WS.clear(); location.replace("/signin.html"); }
    else if (action === "toggle-palette") { state.paletteOpen = !state.paletteOpen; renderPalette(); }
    else if (action === "save-palette") { state.paletteOpen = false; renderPalette(); }
    else if (action === "reset-palette") { state.palette = [...DEFAULT_PALETTE]; renderPalette(); }
    else if (action === "add-venue") { const v = newVenue(); state.venues.push(v); renderVenues(); }
    else if (action === "remove-venue") {
      readVenuesFromDom();
      state.venues = state.venues.filter((v) => v.id !== Number(el.dataset.id));
      if (state.venues.length === 0) state.venues = [newVenue()];
      if (!findVenue(state.mainVenueId)) state.mainVenueId = state.venues[0].id;
      renderVenues();
    }
  });

  function readVenuesFromDom() {
    document.querySelectorAll("[data-venue-field]").forEach((el) => {
      const v = findVenue(el.dataset.id);
      if (v) v[el.dataset.venueField] = el.value;
    });
  }

  document.addEventListener("change", (e) => {
    if (e.target.dataset && e.target.dataset.action === "set-main") state.mainVenueId = Number(e.target.dataset.id);
  });

  $("create-form").addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.venueField) { const v = findVenue(t.dataset.id); if (v) v[t.dataset.venueField] = t.value; return; }
    if (t.dataset.colorIndex !== undefined) { state.palette[Number(t.dataset.colorIndex)] = t.value; renderPalette(); return; }
    readFieldsFromDom();
    if (t.id === "wedding-date") {
      state.venues.forEach(v => { if (!v.eventDate) v.eventDate = t.value; });
      renderVenues();
    }
  });

  $("create-form").addEventListener("submit", (e) => { e.preventDefault(); submitCreate(); });

  // Account menu
  $("account-menu-btn").addEventListener("click", (e) => {
    const menu = $("account-menu");
    menu.style.display = menu.style.display === "none" ? "block" : "none";
    e.stopPropagation();
  });

  document.addEventListener("click", () => {
    $("account-menu").style.display = "none";
  });

  const handleSignOut = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    window.WS.clear();
    location.replace("/signin.html");
  };

  $("sign-out").addEventListener("click", handleSignOut);
  $("account-sign-out").addEventListener("click", handleSignOut);

  $("change-password").addEventListener("click", async (e) => {
    e.preventDefault();
    // For now, show a placeholder message
    alert("Password change feature coming soon. Contact support to reset your password.");
  });

  // Set up role-based navigation
  const role = window.WS.role();
  if (role) {
    $("role-display").textContent = `Role: ${role.charAt(0).toUpperCase() + role.slice(1)}`;
    
    // Show admin dashboard if user is admin or superadmin or owner
    if (role === "admin" || role === "superadmin" || role === "owner") {
      $("admin-dashboard").style.display = "block";
    }
    
    // Show owner profile only if user is owner (never show owner to other roles)
    if (role === "owner") {
      $("owner-profile").style.display = "block";
      $("owner-profile").textContent = "Owner Profile (You)";
      $("owner-profile").href = "#"; // TODO: create owner profile page
      $("owner-profile").addEventListener("click", (e) => {
        e.preventDefault();
        alert("Owner profile coming soon");
      });
    }
  }

  // Error boundaries: surface anything unexpected instead of failing silently.
  window.addEventListener("error", (e) => { console.error(e.error || e.message); setNotice("Something went wrong on this page. Your entries are kept; please try again.", "bad"); });
  window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); setNotice("Something went wrong. Your entries are kept; please try again.", "bad"); });

  if (!window.WS.token()) {
    location.replace("/signin.html");
  } else {
    window.WSTime.fillSelect($("wedding-timezone"), state.fields.timeZone);
    renderAll();
    loadWeddings();
  }
})();
function statusLabel(w) {
  const past = w.wedding_date && String(w.wedding_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (w.archived_at) return "Archived";
  if (w.published_at) return past ? "Completed / Past" : "Published";
  if (w.unpublished_at) return "Unpublished";
  return past ? "Past (draft)" : "Draft";
}
