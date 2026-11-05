(function () {
  "use strict";
  let mounted = false;
  window.WSInteractiveWedding = {
    mount(guide, weddingId, wedding) {
      if (mounted || wedding.interactive_creation !== true) return;
      mounted = true;
      document.body.dataset.interactiveEditor = "true";
      const $ = id => document.getElementById(id);
      const surface = document.createElement("section");
      surface.className = "interactive-surface";
      surface.innerHTML = `<div class="interactive-toolbar">
        <p><strong>Your wedding, as you build it</strong><br><span id="interactive-state" role="status" aria-live="polite">Private preview. Guest actions and visit tracking are disabled.</span></p>
        <button type="button" data-edit-basics aria-label="Edit couple names">Names</button>
        <button type="button" data-edit-currency>Currency</button>
        <button type="button" data-finish aria-label="Finish setup, private identity details and publication review">Finish setup</button>
        </div><iframe title="Your private wedding preview" referrerpolicy="no-referrer"></iframe>`;
      const dialog = document.createElement("dialog");
      surface.id = "interactive-surface";
      dialog.className = "interactive-dialog";
      dialog.setAttribute("aria-labelledby", "interactive-editor-title");
      dialog.innerHTML = `<header><h2 id="interactive-editor-title">Edit your wedding</h2><button type="button" data-close-editor>Back to your site</button></header>
        <p data-close-warning role="alert" hidden>Unsaved changes are still here. Save before returning to your site.</p>
        <p data-editor-notice role="status" aria-live="polite" hidden></p>`;
      const edit = $("edit-section");
      edit.before(surface);
      dialog.append(edit, $("publish-section"));
      document.body.append(dialog);
      new MutationObserver(() => {
        const notice = $("notice"), mirror = dialog.querySelector("[data-editor-notice]");
        mirror.hidden = notice.hidden;
        mirror.className = notice.className;
        mirror.textContent = notice.textContent;
      }).observe($("notice"), { attributes: true, childList: true, characterData: true, subtree: true });
      const status = $("interactive-state");
      const addressStatus = document.createElement("p");
      addressStatus.id = "address-availability";
      addressStatus.className = "fine";
      addressStatus.setAttribute("role", "status");
      addressStatus.setAttribute("aria-live", "polite");
      $("slug-preview").after(addressStatus);
      $("wedding-slug").setAttribute("aria-describedby", `${$("wedding-slug").getAttribute("aria-describedby")} address-availability`);
      let addressRevision = 0, addressTimer;
      function checkAddress() {
        const revision = ++addressRevision;
        clearTimeout(addressTimer);
        const slug = $("wedding-slug").value.trim().toLowerCase();
        addressStatus.hidden = !$("couple-names").value.trim();
        if (addressStatus.hidden) { addressStatus.textContent = ""; return; }
        if (!WSSite.isSubdomainSlug(slug)) {
          addressStatus.dataset.state = "invalid";
          addressStatus.textContent = "Choose an unreserved address with 3-63 letters, numbers or hyphens, beginning and ending with a letter or number.";
          return;
        }
        addressStatus.dataset.state = "checking";
        addressStatus.textContent = "Checking address availability…";
        addressTimer = setTimeout(async () => {
          try {
            const response = await WS.api(`/api/weddings?action=address-availability&weddingId=${encodeURIComponent(weddingId)}&slug=${encodeURIComponent(slug)}`);
            const data = await response.json();
            if (revision !== addressRevision) return;
            if (!response.ok) throw new Error(data.error || "Address availability could not be checked.");
            if (!["current", "available", "taken", "reserved", "invalid"].includes(data.state) || data.slug !== slug) {
              throw new Error("The address check returned an invalid response.");
            }
            addressStatus.dataset.state = data.state;
            addressStatus.textContent = data.state === "current" ? "This is your current saved address."
              : data.state === "available" ? "Available now. Saving still checks for conflicts; this does not reserve the address."
              : data.state === "taken" ? "That address is taken. Choose a different one."
              : data.message || "Choose a valid, unreserved address.";
          } catch (error) {
            if (revision !== addressRevision) return;
            addressStatus.dataset.state = "error";
            addressStatus.textContent = `Could not check availability: ${error.message} Your address is unchanged; saving still checks it.`;
          }
        }, 350);
      }
      $("couple-names").addEventListener("input", checkAddress);
      $("wedding-slug").addEventListener("input", checkAddress);
      checkAddress();
      const pageContent = { ...(wedding.page_content || {}) };
      const wordingSeeded = new Set();
      const sectionSteps = {
        welcome: "couple", story: "couple", details: "theme", venues: "venues", prewedding: "venues",
        campaigns: "campaigns", registry: "giving", rsvp: "guests", bids: "giving", ledger: "extras",
        "sponsor-tiers": "giving", "vip-section": "giving", sponsors: "giving", "info-section": "extras", guestbook: "extras"
      };
      for (const field of WSWeddingContent.fields) {
        const group = document.createElement("label");
        group.dataset.pageSection = field.section;
        group.dataset.guideSegment = `page-wording:${field.key}`;
        group.append(document.createTextNode(`Page ${field.selector.includes("h2") ? "heading" : "wording"} (optional; clear to remove)`));
        const input = document.createElement("textarea");
        input.dataset.pageContent = field.key;
        input.maxLength = 2000;
        input.rows = 2;
        input.value = pageContent[field.key] || "";
        input.addEventListener("input", () => { pageContent[field.key] = input.value; });
        group.append(input);
        document.querySelector(`[data-guide-step="${sectionSteps[field.section]}"]`).append(group);
      }
      const review = document.createElement("label");
      review.innerHTML = '<input type="checkbox" id="creation-content-reviewed"> I have replaced sample partner and venue details, chosen our own date and time zone, and reviewed the story, programme, guest guidance and offerings. No demo activity belongs to us.';
      review.querySelector("input").checked = wedding.creation_content_reviewed === true;
      document.querySelector('[data-guide-step="review"]').append(review);
      window.WSInteractiveWedding.contentPatch = () => ({
        pageContent, creationContentReviewed: review.querySelector("input").checked
      });
      guide.saved(true);
      let dataPromise, activeEditor;
      function refresh() {
        dataPromise = (async () => {
          const response = await WS.api(`/api/weddings?action=preview&weddingId=${encodeURIComponent(weddingId)}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not load your private preview.");
          return data;
        })();
        dataPromise.catch(error => { status.textContent = `Preview unavailable: ${error.message}`; });
        const frame = surface.querySelector("iframe");
        frame.src = `/guest.html?preview=1&revision=${Date.now()}`;
      }
      function open(step, section, kind) {
        if (!section && !kind && dialog.open && activeEditor?.step === step) {
          ({ section, kind } = activeEditor);
        }
        const tasks = {
          welcome: "names", story: "story", details: "palette", venues: "venues", prewedding: "prewedding",
          registry: "registry", "sponsor-tiers": "packages", "vip-section": "vip", sponsors: "featured",
          rsvp: "rsvp", bids: "songs", campaigns: "campaigns", "info-section": "travel", ledger: "wording", guestbook: "wording"
        };
        const task = kind || tasks[section] || ({ couple: "names", money: "currency", theme: "palette", guests: "rsvp" })[step];
        const scopes = {
          names: ["Edit names", '[data-edit-part="names"]'],
          address: ["Edit wedding address", "#wedding-address"],
          story: ["Edit your story", '[data-edit-part="story"]'],
          cover: ["Edit cover photo", '[data-edit-part="cover"]'],
          date: ["Wedding date & time zone", '[data-edit-part="date"]'],
          location: ["Edit location", '[data-edit-part="location"]'],
          music: ["Background music", '[data-edit-part="music"]'],
          currency: ["Wedding currency", '[data-edit-part="currency"]'],
          receiving: ["Receiving preference", '[data-edit-part="receiving"]'],
          palette: ["Wedding colours & lookbook", '[data-edit-part="palette"]'],
          attire: ["Dress guidance", "#attire-description"],
          registry: ["Registry gifts", "#registry-block"],
          packages: ["Sponsor packages", "#tiers-block"],
          vip: ["VIP offering", "#vip-block"],
          featured: ["Featured sponsor placement", "#featured-sponsor-block"],
          songs: ["Song bidding is always included", "#song-requests-block"],
          rsvp: ["Guest capacity & welcome", '[data-edit-part="rsvp"]'],
          fees: ["RSVP fees & meal options", "#rsvp-fees-fieldset"],
          travel: ["Travel & accommodation", '#travel-info, label[for="travel-info"]'],
          faq: ["Guest questions", "#faq-rows, #faq-add, #faq-label"],
          campaigns: ["Celebration funds & milestones", "#campaign-list, #add-campaign, #campaign-status"],
          prewedding: ["Pre-wedding activities", "#pre-events-list, #add-pre-event, #pre-events-title"],
          venues: ["Wedding-day programme", "#wedding-day-events-list, #add-venue-btn, #wedding-day-events-title"]
        };
        activeEditor = { step, section, kind };
        if (!dialog.open) dialog.showModal();
        dialog.querySelector("[data-close-warning]").hidden = true;
        const target = document.querySelector(`[data-guide-step="${step}"]`);
        guide.reveal(target);
        dialog.querySelectorAll(".editor-filter-hidden").forEach(element => element.classList.remove("editor-filter-hidden"));
        dialog.querySelectorAll("[data-page-section]").forEach(group => { group.hidden = false; });
        if (task && target) {
          dialog.dataset.task = task;
          $("interactive-editor-title").textContent = scopes[task]?.[0] || "Edit section wording";
          const selected = task === "wording"
            ? [...target.querySelectorAll("[data-page-section]")].filter(group => group.dataset.pageSection === section)
            : [...target.querySelectorAll(scopes[task][1])];
          function filter(element) {
            for (const child of element.children) {
              const direct = selected.includes(child);
              const ancestor = selected.some(item => child.contains(item));
              child.classList.toggle("editor-filter-hidden", !direct && !ancestor);
              if (!direct && ancestor) filter(child);
            }
          }
          filter(target);
        } else {
          delete dialog.dataset.task;
          $("interactive-editor-title").textContent = "Finish setup & private details";
        }
        [...(target?.querySelectorAll("input:not([disabled]), select:not([disabled]), textarea:not([disabled])") || [])]
          .find(element => element.getClientRects().length)?.focus();
      }
      window.WSInteractiveWedding.revealField = target => {
        target = target?.querySelector("input:invalid, select:invalid, textarea:invalid") || target;
        if (!target || target.getClientRects().length) return;
        const step = target.closest("[data-guide-step]")?.dataset.guideStep;
        const product = [
          ["#registry-block", "registry"], ["#tiers-block", "packages"], ["#vip-block", "vip"],
          ["#featured-sponsor-block", "featured"], ["#song-requests-block", "songs"],
          ["#rsvp-fees-fieldset", "fees"], ["#campaign-list", "campaigns"],
          ["#pre-events-list", "prewedding"], ["#venues-list", "venues"], ["#faq-rows", "faq"]
        ].find(([selector]) => target.closest(selector));
        const kind = target.closest("[data-edit-part]")?.dataset.editPart || product?.[1] ||
          (target.id === "travel-info" ? "travel" : undefined);
        if (step && kind) open(step, undefined, kind);
      };
      window.WSInteractiveWedding.revealInvalid = () => {
        window.WSInteractiveWedding.revealField($("edit-form").querySelector("input:invalid, select:invalid, textarea:invalid"));
      };
      function close() {
        if (guide.isSaving() || guide.dirty()) {
          dialog.querySelector("[data-close-warning]").hidden = false;
          return;
        }
        dialog.close();
      }
      window.WSInteractiveGuest = {
        data: () => dataPromise,
        edit: (step, section, kind) => {
          if (["couple", "date", "money", "venues", "guests", "theme", "giving", "campaigns", "extras"].includes(step)) open(step, section, kind);
        },
        wording: defaults => {
          for (const input of dialog.querySelectorAll("[data-page-content]")) {
            const key = input.dataset.pageContent;
            if (!Object.hasOwn(pageContent, key) && Object.hasOwn(defaults, key) && !wordingSeeded.has(key)) {
              input.value = defaults[key];
              wordingSeeded.add(key);
              guide.adoptSaved(input.parentElement.dataset.guideSegment);
            }
          }
        }
      };
      dialog.querySelector("[data-close-editor]").addEventListener("click", close);
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      surface.querySelector("[data-edit-basics]").addEventListener("click", () => open("couple"));
      surface.querySelector("[data-edit-currency]").addEventListener("click", () => open("money"));
      surface.querySelector("[data-finish]").addEventListener("click", () => {
        document.body.dataset.finishing = "true";
        const workspace = $("wedding-workspace");
        if (workspace) workspace.open = true;
        open("review");
      });
      document.addEventListener("ws:wedding-saved", () => {
        status.textContent = "Saved. Your private preview reflects your saved wedding.";
        refresh();
        if (!guide.dirty()) dialog.close();
      });
      function liveInput(event) {
        status.textContent = "Unsaved changes. Save in the section editor to update your site.";
        const frame = surface.querySelector("iframe");
        if (dialog.querySelector('[data-guide-step="theme"]:not([hidden])')) {
          if (event.target.closest("#color-inputs")) $("apply-colors-btn").click();
          const palette = JSON.parse($("palette-preview").dataset.palette || "[]");
          frame.contentWindow.WSTheme?.apply(palette);
        }
        const document = frame.contentDocument;
        if (event.target.dataset.pageContent && document) WSWeddingContent.apply(document, pageContent);
        if (document?.getElementById("couple-names") && event.target.id === "couple-names") {
          document.getElementById("couple-names").textContent = event.target.value || "Wedding";
        }
        if (document?.getElementById("welcome-story") && event.target.id === "welcome-story") {
          document.getElementById("welcome-story").textContent = event.target.value;
        }
      }
      $("edit-form").addEventListener("input", liveInput);
      $("edit-form").addEventListener("change", liveInput);
      // Private identity fields stay in the authenticated parent, never in the frame bundle.
      $("kyc-form").addEventListener("input", () => { $("kyc-form").dataset.unsaved = "true"; });
      document.addEventListener("ws:kyc-saved", () => { delete $("kyc-form").dataset.unsaved; });
      window.addEventListener("beforeunload", event => {
        if ($("kyc-form").dataset.unsaved) { event.preventDefault(); event.returnValue = ""; }
      });
      function fromLocation() {
        const step = [...$("edit-form").querySelectorAll("[data-guide-step]")]
          .find(section => location.hash === `#step=${section.dataset.guideStep}`);
        if (step) {
          if (["review", "publication", "team"].includes(step.dataset.guideStep)) document.body.dataset.finishing = "true";
          open(step.dataset.guideStep);
          return;
        }
        const target = document.getElementById(location.hash.slice(1));
        if (target?.closest("#edit-form")) open(target.closest("[data-guide-step]")?.dataset.guideStep || "review");
        else if (target?.closest("#wedding-workspace") && !guide.dirty()) {
          document.body.dataset.finishing = "true";
          $("wedding-workspace").open = true;
          dialog.close();
          target.scrollIntoView();
        }
      }
      window.addEventListener("hashchange", fromLocation);
      for (const id of ["feature-giving", "feature-sponsors", "feature-featured-sponsors", "feature-song-requests", "feature-vip-seating"]) {
        $(id).checked = true;
        $(id).disabled = true;
      }
      refresh();
      if (!wedding.couple_names?.trim()) open("couple");
      else if (location.hash && location.hash !== "#step=couple") fromLocation();
    }
  };
})();
