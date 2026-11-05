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
        <button type="button" data-edit-basics aria-label="Edit couple names and wedding address">Names</button>
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
      let dataPromise;
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
      function open(step) {
        if (!dialog.open) dialog.showModal();
        dialog.querySelector("[data-close-warning]").hidden = true;
        const target = document.querySelector(`[data-guide-step="${step}"]`);
        guide.reveal(target);
        target?.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), h2")?.focus();
      }
      function close() {
        if (guide.isSaving() || guide.dirty()) {
          dialog.querySelector("[data-close-warning]").hidden = false;
          return;
        }
        dialog.close();
      }
      window.WSInteractiveGuest = {
        data: () => dataPromise,
        edit: step => {
          if (["couple", "date", "money", "venues", "guests", "theme", "giving", "campaigns", "extras"].includes(step)) open(step);
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
