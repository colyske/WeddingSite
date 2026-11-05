// Wedding drafts are created here; the shared editor guide handles all setup.
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const DEFAULT_PALETTE = ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"];
  const legacyAnswersKey = "ws-create-answers";
  const createKey = "ws-create-request-key";
  const state = { submitting: false, created: null, weddings: null, weddingsError: "", notice: null };
  let referralDisclosure = null;
  let referralReady = false;
  let legacyAnswers = null;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const setNotice = (text, kind, target) => {
    state.notice = text ? { text, bad: kind === "bad" } : null;
    renderNotice();
    if (text && window.WSFeedback) WSFeedback.toast(text, kind === "bad");
    if (text && window.WSFeedback) WSFeedback.scrollTo(target || (kind === "bad" ? "notice" : "created"));
  };
  function renderNotice() {
    const element = $("notice");
    element.hidden = !state.notice;
    element.textContent = state.notice?.text || "";
    element.className = "notice" + (state.notice?.bad ? " bad" : "");
  }

  function readLegacyAnswers() {
    try {
      const saved = sessionStorage.getItem(legacyAnswersKey);
      if (!saved) return null;
      const draft = JSON.parse(saved);
      if (!draft.fields || !["names", "date", "timeZone", "location", "currency", "capacity"]
        .every(key => typeof draft.fields[key] === "string") ||
          !Array.isArray(draft.palette) || draft.palette.length !== 4 ||
          !draft.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) ||
          !Array.isArray(draft.venues) || !draft.venues.length ||
          draft.venues.some(venue => !venue || !["name", "time", "eventDate", "address", "map", "description"]
            .every(key => typeof venue[key] === "string"))) {
        throw new Error("The earlier saved answers have an unexpected format.");
      }
      return draft;
    } catch (error) {
      console.error("Could not read earlier wedding answers:", error);
      $("legacy-answer-notice").hidden = false;
      $("legacy-answer-notice").textContent =
        "This tab contains older setup answers that could not be read. They have not been deleted; keep this tab open while you decide how to continue.";
      return null;
    }
  }

  function prepareLegacyAnswerChoice() {
    legacyAnswers = readLegacyAnswers();
    if (!legacyAnswers) return;
    if (!$("couple-names").value && legacyAnswers.fields.names) $("couple-names").value = legacyAnswers.fields.names;
    const notice = $("legacy-answer-notice");
    notice.hidden = false;
    const venueCount = legacyAnswers.venues.filter(venue =>
      venue.name || venue.time || venue.eventDate || venue.address || venue.map || venue.description).length;
    notice.innerHTML = `We found setup answers saved in this tab: ${esc(legacyAnswers.fields.date || "no date yet")}, ` +
      `${esc(legacyAnswers.fields.location || "no location yet")}, and ${venueCount} event(s). ` +
      `They stay here unless you choose to carry them into this wedding draft.`;
    const label = document.createElement("label");
    label.className = "legacy-answer-choice";
    label.innerHTML = '<input id="include-legacy-answers" type="checkbox" checked> Carry these saved answers into the new draft';
    notice.after(label);
  }

  function createRequestKey() {
    try {
      const existing = sessionStorage.getItem(createKey);
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
      const created = crypto.randomUUID();
      sessionStorage.setItem(createKey, created);
      return created;
    } catch (error) {
      console.error("Create request key could not be saved:", error);
      return crypto.randomUUID();
    }
  }
  let requestKey = createRequestKey();
  const starterKey = "ws-starter-choice";
  let selectedStarter = null, pendingStarter = null, starterLoading = false, starterFailed = false;
  let capabilitiesRequest = null, platformCurrency = null, draftCurrencies = [], draftCurrencyCheck = Promise.resolve();
  function fetchCapabilities(force = false) {
    if (force || !capabilitiesRequest) capabilitiesRequest = (async () => {
      const response = await WS.api("/api/weddings?action=collection-capabilities");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not check collection support.");
      if (!Array.isArray(data.currencies) || data.currencies.some(item =>
        !item || !WSCurrencies.supportsAccounting(item.code) || typeof item.name !== "string" ||
        !Array.isArray(item.methods) || !item.methods.length)) throw new Error("Collection currency support could not be verified.");
      return data;
    })();
    capabilitiesRequest.catch(() => { capabilitiesRequest = null; });
    return capabilitiesRequest;
  }
  // Destination defaults never select the source currency or grant collection readiness.
  function renderDraftCurrency() {
    const status = platformCurrency, note = $("create-currency-note");
    const choose = status?.configured === true && !status.supported;
    $("draft-currency-choice").hidden = false;
    $("draft-currency-retry").hidden = !(choose && !draftCurrencies.length) && !status?.unavailable;
    note.textContent = "Choose your accounting currency first. KES keeps the showcase Celebration fund goal (KES 500,000), with no raised balance. Other currencies start with an incomplete fund: enter your own positive goal before publishing. Changing currency clears affected amounts, never converts them. Collection and publication still require the existing server checks.";
  }
  async function checkDraftCurrency(force = false) {
    const selected = $("draft-currency").value;
    try {
      const data = await fetchCapabilities(force);
      draftCurrencies = data.currencies;
      platformCurrency = data.defaultCurrency && typeof data.defaultCurrency === "object" ? data.defaultCurrency : { currency: null, configured: false, supported: false };
    } catch (error) {
      console.error("Could not check the platform default currency:", error);
      draftCurrencies = [];
      platformCurrency = { currency: null, configured: null, supported: false, unavailable: true };
    }
    const names = new Intl.DisplayNames(undefined, { type: "currency" });
    $("draft-currency").replaceChildren(new Option("Choose your wedding currency", ""),
      ...WSCurrencies.accountingCodes.map(code => new Option(`${code} - ${names.of(code)}`, code)));
    $("draft-currency").value = selected || (platformCurrency?.supported ? platformCurrency.currency : "USD");
    renderDraftCurrency();
  }
  function draftCurrency() {
    return $("draft-currency").value;
  }
  function rememberStarter() {
    try { sessionStorage.setItem(starterKey, JSON.stringify({
      source: selectedStarter?.source, snapshot: selectedStarter,
      names: $("couple-names").value, requestKey
    })); return true; }
    catch (error) {
      setNotice(`Could not keep your starter choice in this tab: ${error.message}. Enable tab storage before creating a draft so retries stay safe.`, "bad");
      return false;
    }
  }
  function starterConfig() {
    if (!selectedStarter) return null;
    const setup = selectedStarter.inspirationId
      ? WSStarterSetup.fictional(selectedStarter.inspirationId, "USD")
      : WSStarterSetup.clone(selectedStarter.setup);
    setup.reviewed = false;
    return setup;
  }
  function renderStarterReview() {
    $("inspiration-selection").hidden = !selectedStarter && !pendingStarter;
    $("apply-inspiration").hidden = !pendingStarter;
    $("keep-current-answers").hidden = !pendingStarter;
    $("starter-review").hidden = true;
    const item = pendingStarter || selectedStarter;
    if (!item) return;
    $("inspiration-selection-copy").textContent = pendingStarter
      ? "Your existing names and saved answers have not been replaced. Choose explicitly whether to use this new starting point."
      : selectedStarter.source?.styleSlug === "showcase-wedding"
        ? "The platform's fictional showcase wording, programme and offering descriptions start as editable placeholders. Replace sample details before publishing; no guests, payments, sponsor identities, accounts or valid passes are copied."
      : selectedStarter.inspirationId
        ? "Author-owned fictional inspiration, not customers, donations or paid sponsorships. Examples are illustrative and editable."
        : "Public reusable configuration only: colours, event types/order, shared venue groups, RSVP choices, features and unpriced sponsor/gift/goal structures. Public visibility is not permission to copy personal content: neutral editable prompts replace original writing, identities, locations and instructions.";
    if (selectedStarter && !pendingStarter) $("inspiration-selection-copy").textContent +=
      " Your interactive private preview opens next. The Celebration fund uses only the KES showcase goal or a matching-currency template preset; otherwise enter a goal yourself. No guest activity or payment readiness is copied.";
  }
  async function chooseStarter(item, { restore = false } = {}) {
    selectedStarter = item; pendingStarter = null;
    if (!restore) {
      requestKey = crypto.randomUUID();
      try { sessionStorage.setItem(createKey, requestKey); } catch (error) { setNotice(error.message, "bad"); }
    }
    if ($("include-legacy-answers")) $("include-legacy-answers").checked = false;
    renderStarterReview();
    rememberStarter();
  }
  async function loadStarter(source) {
    if (source.inspirationId) {
      if (!WSInspiration.get(source.inspirationId)) throw new Error("That fictional inspiration style is unavailable.");
      return { source, inspirationId: source.inspirationId, ...WSInspiration.starter(source.inspirationId) };
    }
    if (typeof source.styleSlug !== "string" || !/^[a-z0-9-]{3,80}$/.test(source.styleSlug)) throw new Error("Choose an eligible public wedding.");
    const response = await fetch(`/api/guest?action=style&slug=${encodeURIComponent(source.styleSlug)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "This public wedding is unavailable for reuse.");
    return { source, ...data.style, setup: WSStarterSetup.restoreEditable(data.style.setup) };
  }
  async function initializeStarter() {
    starterLoading = true; starterFailed = false; renderSubmit();
    try {
      let saved = null;
      try {
        const text = sessionStorage.getItem(starterKey);
        if (text) saved = JSON.parse(text);
      } catch (error) { throw new Error(`Could not restore this tab's starter selection: ${error.message}`); }
      const entry = new URLSearchParams(location.search);
      if (saved?.snapshot?.completed && !entry.has("style") && !entry.has("inspiration") && !entry.has("scratch")) saved = null;
      if (saved?.source) {
        if (!$("couple-names").value && typeof saved.names === "string") $("couple-names").value = saved.names;
        if (/^[0-9a-f-]{36}$/i.test(saved.requestKey || "")) requestKey = saved.requestKey;
        const snapshot = saved.snapshot;
        if (snapshot && Array.isArray(snapshot.palette) && snapshot.palette.length === 4 &&
            snapshot.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) &&
            Array.isArray(snapshot.venues) && snapshot.venues.length <= 30) {
          if (snapshot.setup) snapshot.setup = WSStarterSetup.restoreEditable(snapshot.setup);
          await chooseStarter(snapshot, { restore: true });
        } else await chooseStarter(await loadStarter(saved.source), { restore: true });
      }
      const params = new URLSearchParams(location.search);
      const inspirationId = params.get("inspiration"), styleSlug = params.get("style");
      if (inspirationId && styleSlug) throw new Error("Choose one starter source at a time.");
      if (inspirationId || styleSlug) {
        const initialNames = $("couple-names").value;
        const source = inspirationId ? { inspirationId } : { styleSlug };
        const sameSource = selectedStarter && saved && JSON.stringify(saved.source) === JSON.stringify(source);
        // A submitted request may already own a draft even if its source is no longer public.
        if (!sameSource || !selectedStarter.submittedPayload) {
          const item = await loadStarter(source);
          if (!sameSource) {
            if (legacyAnswers || initialNames || $("couple-names").value !== initialNames) {
              pendingStarter = item; renderStarterReview();
            } else await chooseStarter(item);
          }
        }
      } else if (params.get("scratch") === "showcase" || (!selectedStarter && !legacyAnswers)) {
        const source = { styleSlug: "showcase-wedding" };
        if (!selectedStarter || JSON.stringify(selectedStarter.source) !== JSON.stringify(source)) {
          await chooseStarter(await loadStarter(source));
        }
      }
      if (!selectedStarter?.submittedPayload) draftCurrencyCheck = checkDraftCurrency();
    } catch (error) { starterFailed = true; setNotice(`${error.message} Your existing answers are kept.`, "bad"); }
    finally {
      starterLoading = false;
      const params = new URLSearchParams(location.search);
      if (!selectedStarter && !pendingStarter && !params.has("style") && !params.has("inspiration")) {
        draftCurrencyCheck = checkDraftCurrency();
      }
      renderSubmit();
    }
  }
  $("apply-inspiration").addEventListener("click", () => chooseStarter(pendingStarter));
  $("keep-current-answers").addEventListener("click", () => { pendingStarter = null; renderStarterReview(); });
  $("draft-currency-retry").addEventListener("click", () => { draftCurrencyCheck = checkDraftCurrency(true); });
  $("couple-names").addEventListener("input", () => { if (selectedStarter) rememberStarter(); });

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
        `All estimates are held and unpayable; there are no referral payouts. Owner rate changes affect new contributions only. ` +
        `Attribution is fixed when you create this wedding; you can decline it now. Terms: ${d.terms_version}.`;
    }
    referralReady = true;
    $("client-referral-dismiss").hidden = true;
  }

  $("client-referral-dismiss").addEventListener("click", async () => {
    WSReferrals.clear();
    if (!window.WS.token()) return location.replace("/signin.html");
    try {
      await loadReferralDisclosure();
      if (!window.WS.token()) location.replace("/signin.html?next=" + encodeURIComponent("/dashboard.html"));
      else setNotice("The unvalidated link was discarded. Any referral already captured still needs your accept-or-decline choice.", "good");
    } catch (error) { setNotice(error.message, "bad"); }
  });

  function renderSubmit() {
    $("create-submit").disabled = state.submitting || !!state.created || starterLoading;
    $("create-submit").textContent = state.created
      ? "Draft created" : state.submitting ? "Creating your draft…" : "Create my private preview";
  }

  function renderCreated() {
    const element = $("created");
    if (!state.created) { element.hidden = true; element.replaceChildren(); return; }
    element.hidden = false;
    element.innerHTML = `<h2>Your draft is ready</h2><p><strong>${esc(state.created.names)}</strong></p>` +
      `<p>Your answers are saved to your account. Continue in your wedding guide to add the date, venues, guest details and fundraising options.</p>` +
      `<a class="btn" href="/wedding.html?id=${encodeURIComponent(state.created.weddingId)}#step=couple">Open your wedding guide</a>`;
  }

  function renderWeddings() {
    const list = state.weddings;
    $("empty").hidden = list !== null && list.length > 0;
    $("empty").textContent = state.weddingsError ||
      (list === null ? "Loading your weddings…" : "No weddings yet. Start your first draft above.");
    $("weddings-container").hidden = !list || list.length === 0;
    if (!list) return;
    $("weddings-grid").innerHTML = list.map(wedding => `
      <div class="card">
        <div class="top" style="margin-bottom:.5rem">
          <span class="tag ${wedding.published_at && !wedding.archived_at ? "live" : ""}">${statusLabel(wedding)}</span>
          <span class="fine">${esc(new Date(wedding.created_at).toLocaleDateString())}</span>
        </div>
        <h3>${esc(wedding.couple_names)}</h3>
        <p class="fine" style="margin:.5rem 0">${wedding.wedding_date ? "📅 " + esc(new Date(wedding.wedding_date).toLocaleDateString()) : "Date can be added in your wedding guide"}
          ${wedding.public_location ? " · 📍 " + esc(wedding.public_location) : ""}</p>
        <p class="fine" style="margin:.5rem 0">👥 Up to ${esc(wedding.max_guest_capacity)} guests · ${esc(wedding.currency)}</p>
        <div class="swatches">${(wedding.palette || []).map(color =>
          `<span style="background:${esc(color)}"></span>`).join("")}</div>
        <div class="card" data-setup-progress="${esc(wedding.id)}" style="margin-top:1rem;padding:1rem"></div>
        ${wedding.couple_names?.trim() ? WSShare.panelHTML(WSShare.guestUrl(wedding.slug), { title: wedding.couple_names, published: !!wedding.published_at }) : ""}
        <div class="row" style="margin-top:1.5rem">
          <a class="btn" href="/wedding.html?id=${encodeURIComponent(wedding.id)}#step=couple">Open wedding guide</a>
          ${wedding.published_at ? `<a class="btn" href="${WSShare.guestUrl(wedding.slug)}" target="_blank" rel="noopener">View guest site</a>` : ""}
        </div>
      </div>`).join("");
    for (const wedding of list) {
      const target = document.querySelector(`[data-setup-progress="${CSS.escape(String(wedding.id))}"]`);
      if (target && window.WSSetupProgress) {
        window.WSSetupProgress.render(target, wedding, {
          compact: true,
          editorUrl: `/wedding.html?id=${encodeURIComponent(wedding.id)}`
        });
      }
    }
  }

  function makeCreatePayload(names, includeSavedAnswers) {
    const saved = includeSavedAnswers ? legacyAnswers : null;
    const fields = saved?.fields || {};
    const venues = (saved?.venues || []).filter(venue =>
      venue.name.trim() || venue.time || venue.eventDate || venue.address.trim() || venue.map.trim() || venue.description.trim())
      .map(venue => ({
        name: venue.name.trim(), time: venue.time, eventDate: venue.eventDate || fields.date || null,
        address: venue.address.trim(), map: venue.map.trim(), description: venue.description.trim(),
        isMain: venue.id === saved.mainVenueId, kind: venue.kind === "pre" ? "pre" : "main"
      }));
    const payload = {
      requestKey,
      coupleNames: names.trim(),
      weddingDate: fields.date || null,
      timeZone: fields.timeZone || window.WSTime.browserZone(),
      location: String(fields.location || "").trim(),
      currency: fields.currency || draftCurrency(),
      maxCapacity: Number(fields.capacity || 150),
      palette: saved ? [...saved.palette] : [...DEFAULT_PALETTE],
      venues
    };
    if (selectedStarter) Object.assign(payload, selectedStarter.source, {
      currency: fields.currency || draftCurrency(), palette: [...selectedStarter.palette], starterDeferred: true,
      weddingDate: null, location: "", venues: WSStarterSetup.clone(selectedStarter.venues),
      starterSetup: starterConfig(), interactiveCreation: true
    });
    return payload;
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (state.submitting || state.created || starterLoading) return;
    if (starterFailed) return setNotice("That setup could not be loaded. Your answers are kept. Retry the link or choose From scratch to load the showcase default; no empty replacement draft was created.", "bad");
    const names = $("couple-names").value.trim();
    $("couple-names").removeAttribute("aria-invalid");
    if (!names && !selectedStarter) {
      $("couple-names").setAttribute("aria-invalid", "true");
      $("couple-names").focus();
      return setNotice("What names should appear on your wedding site? You can change them later.", "bad", $("couple-names"));
    }
    if (names.length > 120) {
      $("couple-names").setAttribute("aria-invalid", "true");
      $("couple-names").focus();
      return setNotice("Please keep the names within 120 characters.", "bad", $("couple-names"));
    }
    if (!window.WS.token()) return setNotice("Your sign-in has expired. Sign in again; your answers have not been sent.", "bad");
    state.submitting = true;
    renderSubmit();
    try {
    await draftCurrencyCheck;
    if (!selectedStarter && !($("include-legacy-answers")?.checked && legacyAnswers?.fields?.currency)) {
      if (!platformCurrency) draftCurrencyCheck = checkDraftCurrency();
      await draftCurrencyCheck;
    }
    if (!referralReady) {
      try { await loadReferralDisclosure(); }
      catch (error) { return setNotice(`${error.message} Your answers are still on this page.`, "bad"); }
    }
    if (!selectedStarter?.submittedPayload && !WSCurrencies.supportsAccounting(draftCurrency())) {
      $("draft-currency").focus();
      return setNotice("Choose your wedding currency before opening your private wedding preview.", "bad");
    }
    if (referralDisclosure?.intent_id && !["accept", "decline"].includes($("client-referral-decision").value)) {
      $("client-referral-decision").focus();
      return setNotice("Please review the referral details and choose whether to accept or decline.", "bad", $("client-referral-decision"));
    }
    const payload = selectedStarter?.submittedPayload
      ? WSStarterSetup.clone(selectedStarter.submittedPayload)
      : makeCreatePayload(names, $("include-legacy-answers")?.checked === true);
    if (!selectedStarter?.submittedPayload && referralDisclosure?.intent_id) payload.referral = {
      intentId: referralDisclosure.intent_id, decision: $("client-referral-decision").value,
      revision: referralDisclosure.revision, termsVersion: referralDisclosure.terms_version
    };
    if (selectedStarter && !selectedStarter.submittedPayload) {
      selectedStarter.submittedPayload = WSStarterSetup.clone(payload);
    }
    if (selectedStarter && !rememberStarter()) return;
    setNotice("Creating your private wedding draft…");
      const response = await WS.api("/api/weddings?action=create", {
        method: "POST", body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) {
          if (data.code === "REFERRAL_CONFLICT" && selectedStarter) {
            selectedStarter.submittedPayload = null;
            rememberStarter();
          }
          $("client-referral-decision").value = "";
          await loadReferralDisclosure();
        }
        throw new Error(data.error || `We could not create your draft (HTTP ${response.status}). Your answers are still here.`);
      }
      if (!data.weddingId || !data.slug) throw new Error("The server did not return a wedding address. Your answers are still here; please retry.");
      state.created = { weddingId: data.weddingId, slug: data.slug, names };
      if (selectedStarter) {
        selectedStarter.completed = true;
        rememberStarter();
      }
      WSReferrals.clear();
      referralDisclosure = null;
      $("client-referral-disclosure").hidden = true;
      try {
        if (!selectedStarter) sessionStorage.removeItem(createKey);
        if ($("include-legacy-answers")?.checked) sessionStorage.removeItem(legacyAnswersKey);
      } catch (error) { console.error("Could not clear saved create answers:", error); }
      setNotice("Your draft is saved. Opening the wedding guide…", "good");
      renderCreated();
      renderSubmit();
      location.replace(`/wedding.html?id=${encodeURIComponent(data.weddingId)}#step=couple`);
    } catch (error) {
      console.error("Create wedding failed:", error);
      setNotice(`${error.message || "We could not reach the server."} Please try again; your answers are kept.`, "bad");
    } finally {
      state.submitting = false;
      renderSubmit();
    }
  }

  async function loadWeddings() {
    try {
      const response = await WS.api("/api/weddings?action=list");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not load your weddings.");
      state.weddings = data.weddings || [];
      state.weddingsError = "";
    } catch (error) {
      state.weddings = null;
      state.weddingsError = error.message || "Could not load your weddings (network error).";
    }
    renderWeddings();
  }

  $("create-form").addEventListener("submit", submitCreate);
  $("create-form").addEventListener("input", event => event.target.removeAttribute("aria-invalid"));
  $("sign-out").addEventListener("click", event => {
    event.preventDefault();
    WS.clear();
    location.replace("/signin.html");
  });
  $("account-sign-out").addEventListener("click", event => {
    event.preventDefault();
    WS.clear();
    location.replace("/signin.html");
  });
  $("account-menu-btn").addEventListener("click", event => {
    const menu = $("account-menu");
    const open = menu.style.display === "none";
    menu.style.display = open ? "block" : "none";
    $("account-menu-btn").setAttribute("aria-expanded", String(open));
    event.stopPropagation();
  });
  document.addEventListener("click", event => {
    if (!$("account-menu").contains(event.target) && event.target !== $("account-menu-btn")) {
      $("account-menu").style.display = "none";
      $("account-menu-btn").setAttribute("aria-expanded", "false");
    }
  });
  $("change-password").addEventListener("click", event => {
    event.preventDefault();
    location.href = "/account.html#password";
  });

  const role = WS.role();
  if (role) {
    $("role-display").textContent = `Role: ${role.charAt(0).toUpperCase() + role.slice(1)}`;
    if (["admin", "superadmin", "owner"].includes(role)) $("admin-dashboard").style.display = "block";
    if (role === "owner") {
      $("owner-profile").style.display = "block";
      $("owner-profile").textContent = "Owner profile";
      $("owner-profile").href = "/account.html";
    }
  }
  window.addEventListener("error", event => {
    console.error(event.error || event.message);
    setNotice("Something went wrong. Your answers are still here; please try again.", "bad");
  });
  window.addEventListener("unhandledrejection", event => {
    console.error(event.reason);
    setNotice("Something went wrong. Your answers are still here; please try again.", "bad");
  });

  if (!WS.token()) {
    const next = "/dashboard.html" + location.search + location.hash;
    WSReferrals.prepare().then(() => location.replace(next === "/dashboard.html" ? "/signin.html" : "/signin.html?next=" + encodeURIComponent(next)))
      .catch(error => { $("client-referral-dismiss").hidden = false; setNotice(error.message, "bad"); });
  } else {
    prepareLegacyAnswerChoice();
    loadWeddings();
    Promise.all([initializeStarter(), loadReferralDisclosure()]).then(() => {
      const sourceRequested = new URLSearchParams(location.search).has("style") || new URLSearchParams(location.search).has("inspiration") || new URLSearchParams(location.search).get("scratch") === "showcase";
      if (sourceRequested && selectedStarter && !pendingStarter && !starterFailed && !referralDisclosure?.intent_id) {
        submitCreate({ preventDefault() {} });
      }
    }).catch(error => setNotice(`${error.message} Your draft details are kept.`, "bad"));
  }
})();

function statusLabel(wedding) {
  const past = wedding.wedding_date && String(wedding.wedding_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
  if (wedding.lifecycle_admin_restricted) return "Action needed (restricted by staff)";
  if (wedding.archived_at) return "Archived";
  if (wedding.published_at) return past ? "Completed / Past" : "Published";
  if (wedding.unpublished_at) return "Unpublished";
  return past ? "Past (draft)" : "Draft";
}
