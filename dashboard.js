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
  let referralDisclosure = null;
  let referralReady = false;
  async function loadReferralDisclosure() {
    referralReady = false;
    try { await WSReferrals.prepare(); }
    catch (error) { $("client-referral-dismiss").hidden = false; throw error; }
    referralDisclosure = await WSReferrals.request("disclosure");
    $("client-referral-disclosure").hidden = !referralDisclosure.intent_id;
    if (referralDisclosure.intent_id) {
      const d = referralDisclosure;
      $("client-referral-details").textContent = `A referrer introduced you to Join Our Wedding. ` +
        `The current Owner referral rate is ${d.enabled ? (d.rate_basis_points / 100).toFixed(2) : "0.00"}% of verified live money raised. ` +
        `The configured platform percentage fee is ${(d.platform_fee_basis_points / 100).toFixed(2)}%` +
        (BigInt(d.platform_fixed_fee_minor) > 0n ? ` plus the applicable quoted fixed fee (${d.platform_fixed_fee_currency}). ` : ". ") +
        `Any future commission is capped by available platform revenue after costs and commitments, never deducted from your net or provider amounts. ` +
        `All estimates are HELD and unpayable; there are no payouts. Owner rate changes affect new contributions only. ` +
        `Attribution is fixed at creation; you can decline it now. Terms: ${d.terms_version}.`;
    }
    referralReady = true;
    $("client-referral-dismiss").hidden = true;
  }
  $("client-referral-dismiss").addEventListener("click", async () => {
    WSReferrals.clear();
    if (!window.WS.token()) { location.replace("/signin.html"); return; }
    try {
      await loadReferralDisclosure();
      if (!window.WS.token()) location.replace("/signin.html?next=" + encodeURIComponent("/dashboard.html"));
      else setNotice("Unvalidated link discarded. Any already captured referral still requires your accept/decline decision.", "good");
    } catch (error) { setNotice(error.message, "bad"); }
  });
  state.requestKey = crypto.randomUUID();
  state.inspirationId = null;
  state.styleSlug = null;
  state.starterSetup = null;
  let pendingInspiration = null;
  const draftKey = "ws-create-answers";
  let guide;
  let starterEditor;
  let starterCapabilities = null;
  let capabilitiesLoading = null;
  function renderStarterCurrencies() {
    if (!state.starterSetup || starterCapabilities === null) return;
    const select = $("currency"), selected = state.fields.currency;
    select.replaceChildren(new Option("Choose a currently supported collection currency", ""),
      ...starterCapabilities.map(item => new Option(`${item.code} - ${item.name}`, item.code)));
    if (starterCapabilities.some(item => item.code === selected)) select.value = selected;
    else {
      select.value = "";
      state.fields.currency = "";
      starterEditor.load(state.starterSetup, { inspirationId: state.inspirationId });
    }
  }
  async function loadStarterCapabilities() {
    if (!state.starterSetup) return;
    if (!capabilitiesLoading) capabilitiesLoading = (async () => {
      try {
        const response = await window.WS.api("/api/weddings?action=collection-capabilities");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Current collection currency support is unavailable.");
        if (!Array.isArray(data.currencies) || data.currencies.some(item =>
          typeof item.code !== "string" || !window.WSCurrencies.supportsAccounting(item.code) || typeof item.name !== "string" ||
          !Array.isArray(item.methods) || !item.methods.length)) throw new Error("Current collection currency support could not be verified.");
        starterCapabilities = data.currencies;
        if (!starterCapabilities.length) setNotice("No guest-payment collection currencies are currently ready. Your starter answers are kept; creation is paused.", "bad");
      } catch (error) {
        starterCapabilities = [];
        setNotice(error.message + " Starter creation is paused; no currency support is assumed.", "bad");
      }
      renderStarterCurrencies();
    })();
    try { await capabilitiesLoading; }
    finally { capabilitiesLoading = null; }
  }

  function restoreAnswers() {
    try {
      const text = sessionStorage.getItem(draftKey);
      if (!text) return;
      const draft = JSON.parse(text);
      if (draft.styleSlug && !/^[a-z0-9-]{3,80}$/.test(draft.styleSlug)) {
        throw new Error("The saved public style is unavailable.");
      }
      if (draft.inspirationId && !window.WSInspiration.get(draft.inspirationId)) {
        throw new Error("The saved inspiration style is unavailable.");
      }
      if (!draft.fields || !Object.keys(DEFAULT_FIELDS).every(key => typeof draft.fields[key] === "string") ||
          !Array.isArray(draft.palette) || draft.palette.length !== 4 || !draft.palette.every(color => HEX.test(color)) ||
          !Array.isArray(draft.venues) || !draft.venues.length || draft.venues.some(venue =>
            !Number.isSafeInteger(venue.id) || !["name", "time", "eventDate", "address", "map", "description"]
              .every(key => typeof venue[key] === "string"))) {
        throw new Error("The saved answers could not be read.");
      }
      const restoredStarter = draft.starterSetup ? window.WSStarterSetup.restoreEditable(draft.starterSetup) : null;
      state.fields = { ...draft.fields };
      state.inspirationId = draft.inspirationId || null;
      state.styleSlug = draft.styleSlug || null;
      state.starterSetup = restoredStarter;
      if (/^[0-9a-f-]{36}$/i.test(draft.requestKey || "")) state.requestKey = draft.requestKey;
      state.palette = [...draft.palette];
      state.venues = draft.venues;
      nextVenueId = Math.max(...state.venues.map(venue => venue.id)) + 1;
      state.mainVenueId = state.venues.some(venue => venue.id === draft.mainVenueId) ? draft.mainVenueId : state.venues[0].id;
      return true;
    } catch (error) {
      console.error("Restore wedding answers failed:", error);
      setNotice("Could not restore the answers saved in this tab. Do not close it if you still have unsaved details on another page.", "bad");
      return true;
    }
  }

  function keepAnswers() {
    if (state.created) return;
    readFieldsFromDom();
    readVenuesFromDom();
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        fields: state.fields, palette: state.palette, venues: state.venues, mainVenueId: state.mainVenueId, requestKey: state.requestKey,
        inspirationId: state.inspirationId, styleSlug: state.styleSlug, starterSetup: state.starterSetup
      }));
      guide?.setState("Before creation, answers are kept in this tab only. Create your draft to save to your account and resume on another device.");
    } catch (error) {
      console.error("Keep wedding answers failed:", error);
      guide?.setState("This browser could not keep your answers. Leave this page open until you can create your wedding.");
    }
  }

  function clearInspirationQuery() {
    const url = new URL(location.href);
    url.searchParams.delete("inspiration");
    url.searchParams.delete("style");
    history.replaceState(null, "", url);
  }

  function showInspiration() {
    const item = pendingInspiration || window.WSInspiration.get(state.inspirationId) ||
      (state.styleSlug ? { title: "Public wedding design", slug: state.styleSlug } : null);
    $("inspiration-selection").hidden = !item;
    $("apply-inspiration").hidden = !pendingInspiration;
    $("keep-current-answers").hidden = !pendingInspiration;
    if (item) $("inspiration-selection-copy").textContent = pendingInspiration
      ? `${item.title}: your existing answers in this tab have been kept. You can explicitly replace them with this ${item.slug ? "design-only starter" : "fictional style"}, or keep them. No saved wedding will be changed.`
      : item.slug
        ? "Public reusable setup: colours, package/goal structures and supported RSVP/feature settings with generic editable labels. Public visibility is not permission to copy personal content. No story, photos, identities, exact events, private settings or activity are copied. Choose your currency and review all prices in the currency section."
        : `${item.title} - fictional inspiration. Colours, event outlines and editable sponsorship, RSVP and fundraising setup are ready to customize. Choose your own currency and review illustrative amounts in the currency section. No payments or publication are activated.`;
  }

  function applyInspiration(item) {
    if (!item || state.submitting || state.created) return;
    const starter = item.slug ? item.starter : window.WSInspiration.starter(item.id);
    state.fields = { ...DEFAULT_FIELDS, currency: "" };
    state.palette = starter.palette;
    state.venues = starter.venues.map(venue => ({ ...venue, id: nextVenueId++ }));
    state.mainVenueId = state.venues.find(venue => venue.isMain).id;
    state.requestKey = crypto.randomUUID();
    state.inspirationId = item.id || null;
    state.styleSlug = item.slug || null;
    state.starterSetup = item.slug ? item.starter.setup : window.WSStarterSetup.fictional(item.id);
    starterEditor.load(state.starterSetup, { inspirationId: state.inspirationId });
    loadStarterCapabilities();
    pendingInspiration = null;
    clearInspirationQuery();
    const select = $("currency");
    if (!select.querySelector('option[value=""]')) select.prepend(new Option("Choose your own accounting currency", ""));
    renderAll();
    showInspiration();
    keepAnswers();
    guide?.reveal($("couple-names"));
  }

  async function initializeInspiration(restored) {
    const fingerprint = () => JSON.stringify([...$("create-form").querySelectorAll("input, select, textarea")]
      .map(input => [input.value, input.checked]));
    const initialAnswers = fingerprint();
    const params = new URLSearchParams(location.search);
    const id = params.get("inspiration");
    const slug = params.get("style");
    if (!id && !slug && !state.starterSetup && (state.inspirationId || state.styleSlug)) {
      try {
        let next;
        if (state.inspirationId) next = window.WSStarterSetup.fictional(state.inspirationId);
        else {
          const response = await fetch(`/api/guest?action=style&slug=${encodeURIComponent(state.styleSlug)}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not reload starter configuration.");
          next = data.style.setup;
        }
        state.starterSetup = next;
        starterEditor.load(next, { inspirationId: state.inspirationId, currency: state.fields.currency });
        if (state.fields.currency) starterEditor.currencyChanged(state.fields.currency);
      } catch (error) {
        setNotice(error.message + " Your existing answers are kept. Starter creation is unavailable until this is resolved.", "bad");
      }
    }
    if (slug) {
      try {
        if (id) throw new Error("Choose one inspiration source at a time.");
        const res = await fetch(`/api/guest?action=style&slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load this public wedding design.");
        const item = { title: "Public wedding design", slug, starter: data.style };
        // Answers entered while the design loaded must not be overwritten.
        if (state.submitting || state.created) { clearInspirationQuery(); return; }
        if (!restored && fingerprint() === initialAnswers) applyInspiration(item);
        else pendingInspiration = item;
      } catch (error) {
        setNotice(error.message + " Your current answers have not been changed.", "bad");
        clearInspirationQuery();
        return;
      }
    }
    const item = window.WSInspiration.get(id);
    if (id && !item) {
      setNotice("That inspiration style is unavailable. Your current answers have not been changed.", "bad");
      clearInspirationQuery();
    } else if (item) {
      if (!restored) applyInspiration(item);
      else pendingInspiration = item;
    }
    showInspiration();
    if (state.inspirationId || state.styleSlug) {
      const select = $("currency");
      if (!select.querySelector('option[value=""]')) select.prepend(new Option("Choose your own accounting currency", ""));
      select.value = state.fields.currency;
    }
    if (state.starterSetup) await loadStarterCapabilities();
  }

  $("apply-inspiration").addEventListener("click", () => applyInspiration(pendingInspiration));
  $("keep-current-answers").addEventListener("click", () => {
    pendingInspiration = null;
    clearInspirationQuery();
    showInspiration();
  });
  document.addEventListener("DOMContentLoaded", () => {
    if (state.inspirationId || state.styleSlug) {
      const select = $("currency");
      if (!select.querySelector('option[value=""]')) select.prepend(new Option("Choose your own accounting currency", ""));
      select.value = state.fields.currency;
      renderStarterCurrencies();
    }
  });

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
          <input type="radio" name="main-venue" data-action="set-main" data-id="${v.id}" ${v.id === state.mainVenueId ? "checked" : ""} ${v.kind === "pre" ? "disabled" : ""}>
          <span>${v.kind === "pre" ? "Pre-wedding event" : "Main venue"}</span>
        </label>
        <input type="text" data-venue-field="name" data-id="${v.id}" placeholder="${i === 0 ? "e.g. Church service" : "e.g. Reception, photo shoot, procession meeting point"}" maxlength="100" value="${esc(v.name)}" aria-label="Venue ${i + 1} name" required>
        <input type="date" data-venue-field="eventDate" data-id="${v.id}" value="${esc(v.eventDate || state.fields.date)}" aria-label="Event ${i + 1} date" required>
        <input type="time" data-venue-field="time" data-id="${v.id}" value="${esc(v.time)}" aria-label="Venue ${i + 1} time" required>
        <input type="text" data-venue-field="address" data-id="${v.id}" placeholder="Street address" maxlength="200" value="${esc(v.address)}" aria-label="Venue ${i + 1} address" required>
        <input type="url" data-venue-field="map" data-id="${v.id}" placeholder="Map link (Google Maps, Apple Maps, etc.)" maxlength="500" value="${esc(v.map)}" aria-label="Venue ${i + 1} map link">
        <textarea data-venue-field="description" data-id="${v.id}" placeholder="Notes (address, parking, dress code)" maxlength="500" aria-label="Venue ${i + 1} notes">${esc(v.description)}</textarea>
        <label>Event type<select data-venue-field="kind" data-id="${v.id}"><option value="main" ${v.kind !== "pre" ? "selected" : ""}>Wedding-day event</option><option value="pre" ${v.kind === "pre" ? "selected" : ""}>Pre-wedding activity</option></select></label>
        <button type="button" class="remove-venue" data-action="remove-venue" data-id="${v.id}">✕ Remove venue</button>
      </div>`).join("");
  }

  function renderSubmit() {
    const btn = $("create-submit");
    btn.disabled = state.submitting || !!state.created;
    $("apply-inspiration").disabled = btn.disabled;
    $("keep-current-answers").disabled = btn.disabled;
    btn.textContent = state.created ? "Wedding created" : state.submitting ? "⏳ Creating..." : "✨ Create wedding";
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
          ${w.published_at ? `<a class="btn" href="${window.WSShare.guestUrl(w.slug)}" target="_blank" rel="noopener">👁 View</a>` : ""}
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

    if (f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
      errors.push("Enter a valid wedding date, or leave it for later");
      $("wedding-date").setAttribute("aria-invalid", "true");
      errorFields.push($("wedding-date"));
    } else {
      $("wedding-date").removeAttribute("aria-invalid");
    }
    
    $("location").removeAttribute("aria-invalid");
    
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
    
    for (const v of state.venues) {
      if (v.map.trim() && !/^https?:\/\//i.test(v.map.trim())) errors.push("Venue map links must start with http:// or https://");
    }
    
    if (errors.length) {
      const firstErrorField = errorFields.find(Boolean) || $("couple-names");
      guide?.reveal(firstErrorField);
      firstErrorField?.focus?.();
      return { message: "Please fix these required fields: " + errors.join(", "), field: firstErrorField };
    }
    return null;
  }

  function buildPayload() {
    const f = state.fields;
    const venues = state.venues
      .filter((v) => v.name.trim() || v.time || v.eventDate || v.map.trim() || v.address.trim() || v.description.trim())
      .map((v) => ({
        name: v.name.trim(), time: v.time, eventDate: v.eventDate || state.fields.date,
        address: v.address.trim(), map: v.map.trim(), description: v.description.trim(),
        kind: v.kind === "pre" ? "pre" : "main",
        isMain: v.id === state.mainVenueId
      }));
    return {
      requestKey: state.requestKey,
      ...(state.inspirationId ? { inspirationId: state.inspirationId } : {}),
      ...(state.styleSlug ? { styleSlug: state.styleSlug } : {}),
      ...(state.starterSetup ? { starterSetup: state.starterSetup } : {}),
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
    if (state.submitting || state.created) return;
    state.submitting = true;
    renderSubmit();
    try {
      readFieldsFromDom();
      setNotice("");
      state.created = null;
      renderCreated();

      const problem = validate();
      if (problem) return setNotice(problem.message, "bad", problem.field);
      if (guide && !guide.validate()) return;
      if (state.starterSetup) {
        await loadStarterCapabilities();
        if (!starterCapabilities?.some(item => item.code === state.fields.currency)) {
          return setNotice("Choose a currency currently supported for guest-payment collection. Starter creation is paused until support is verified.", "bad", $("currency"));
        }
      }
      if (state.starterSetup && !starterEditor.validate(state.fields.currency)) {
        guide?.reveal($("starter-setup"));
        return;
      }
      if (!window.WS.token()) return setNotice("Your session has expired. Sign in again in this tab; your answers have not been sent to the server.", "bad");
      if (!referralReady) {
        try { await loadReferralDisclosure(); }
        catch (error) { return setNotice(error.message + " Your wedding details are kept.", "bad"); }
      }
      if (referralDisclosure?.intent_id && !["accept", "decline"].includes($("client-referral-decision").value)) {
        return setNotice("Review the client referral disclosure and choose accept or decline.", "bad", $("client-referral-decision"));
      }

      setNotice("✨ Creating your wedding...");
      const payload = buildPayload();
      if (referralDisclosure?.intent_id) payload.referral = {
        intentId: referralDisclosure.intent_id, decision: $("client-referral-decision").value,
        revision: referralDisclosure.revision, termsVersion: referralDisclosure.terms_version
      };
      const res = await window.WS.api("/api/weddings?action=create", { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          $("client-referral-decision").value = "";
          await loadReferralDisclosure();
        }
        console.error("Create wedding failed:", res.status, data);
        const msg = res.status === 401
          ? "Your session has expired. Please sign in again; what you entered is kept on this page."
          : data.error || `The server could not create the wedding (HTTP ${res.status}). Your details are kept; please try again.`;
        return setNotice(msg, "bad");
      }
      if (!data.weddingId) return setNotice("The server replied without a wedding id. Your details are kept; please try again.", "bad");

      state.created = { weddingId: data.weddingId, slug: data.slug, names: payload.coupleNames, location: payload.location };
      WSReferrals.clear();
      referralDisclosure = null;
      $("client-referral-disclosure").hidden = true;
      try { sessionStorage.removeItem(draftKey); }
      catch (error) { console.error("Clear created wedding answers failed:", error); }
      guide?.created();
      state.fields = { ...DEFAULT_FIELDS };
      state.inspirationId = null;
      state.styleSlug = null;
      state.starterSetup = null;
      starterEditor.load(null);
      showInspiration();
      state.palette = [...DEFAULT_PALETTE];
      state.paletteOpen = false;
      state.venues = [newVenue()];
      state.mainVenueId = state.venues[0].id;
      setNotice(`✨ ${payload.coupleNames} created successfully! Redirecting...`, "good");
      renderAll();
      
      // Auto-navigate to the newly created wedding after a brief delay
      setTimeout(() => {
        location.href = `/wedding.html?id=${encodeURIComponent(data.weddingId)}&slug=${encodeURIComponent(data.slug)}#step=couple`;
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
    if (e.target.dataset?.venueField === "kind") {
      readVenuesFromDom();
      if (findVenue(state.mainVenueId)?.kind === "pre") state.mainVenueId = state.venues.find(venue => venue.kind !== "pre")?.id;
      renderVenues();
    }
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
  $("currency").addEventListener("change", () => starterEditor.currencyChanged($("currency").value));

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
    sessionStorage.removeItem(draftKey);
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
      $("owner-profile").href = "/account.html";
    }
  }

  // Error boundaries: surface anything unexpected instead of failing silently.
  window.addEventListener("error", (e) => { console.error(e.error || e.message); setNotice("Something went wrong on this page. Your entries are kept; please try again.", "bad"); });
  window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); setNotice("Something went wrong. Your entries are kept; please try again.", "bad"); });

  starterEditor = window.WSStarterSetupEditor.create($("starter-setup"), {
    onChange(value) { state.starterSetup = value; keepAnswers(); },
    onError(message) { setNotice(message, "bad", $("starter-setup")); }
  });
  if (!window.WS.token()) {
    WSReferrals.prepare().then(() => location.replace("/signin.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash)))
      .catch(error => { $("client-referral-dismiss").hidden = false; setNotice(error.message, "bad"); });
  } else {
    const restored = restoreAnswers();
    starterEditor.load(state.starterSetup, { inspirationId: state.inspirationId, currency: state.fields.currency });
    window.WSTime.fillSelect($("wedding-timezone"), state.fields.timeZone);
    renderAll();
    initializeInspiration(restored);
    guide = window.WSGuidedSetup.create($("create-form"), {
      mode: "create", onKeep: keepAnswers,
      summaries: {
        couple: () => `${$("couple-names").value || "Names not answered yet"}; ${$("wedding-date").value || "Date not answered yet"}; ${$("wedding-timezone").value}`,
        venues: () => `${$("location").value || "Location not answered yet"}; ${state.venues.filter(venue => venue.name.trim()).length} event(s) entered`,
        guests: () => `${$("currency").value}; capacity ${$("max-capacity").value || "not answered yet"}`,
        theme: () => state.palette.join(", ")
      }
    });
    ["input", "change", "click"].forEach(type => $("create-form").addEventListener(type, () => queueMicrotask(keepAnswers)));
    loadWeddings();
    loadReferralDisclosure().catch(error => setNotice(error.message + " Your wedding details are kept.", "bad"));
  }
})();
function statusLabel(w) {
  const past = w.wedding_date && String(w.wedding_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (w.lifecycle_admin_restricted) return "Action needed (restricted by staff)";
  if (w.archived_at) return "Archived";
  if (w.published_at) return past ? "Completed / Past" : "Published";
  if (w.unpublished_at) return "Unpublished";
  return past ? "Past (draft)" : "Draft";
}
