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
        <button type="button" data-edit-basics>Names &amp; address</button>
        <button type="button" data-edit-currency>Currency</button>
        <button type="button" data-finish>Finish setup &amp; private details</button>
        </div><iframe title="Your private wedding preview" referrerpolicy="no-referrer"></iframe>`;
      const dialog = document.createElement("dialog");
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
      $("edit-form").addEventListener("input", () => {
        status.textContent = "Unsaved changes. Save in the section editor to update your site.";
        const frame = surface.querySelector("iframe");
        if (dialog.querySelector('[data-guide-step="theme"]:not([hidden])')) {
          const palette = JSON.parse($("palette-preview").dataset.palette || "[]");
          frame.contentWindow.WSTheme?.apply(palette);
        }
      });
      // Private identity fields stay in the authenticated parent, never in the frame bundle.
      $("kyc-form").addEventListener("input", () => { $("kyc-form").dataset.unsaved = "true"; });
      document.addEventListener("ws:kyc-saved", () => { delete $("kyc-form").dataset.unsaved; });
      window.addEventListener("beforeunload", event => {
        if ($("kyc-form").dataset.unsaved) { event.preventDefault(); event.returnValue = ""; }
      });
      document.addEventListener("hashchange", () => {
        const target = document.getElementById(location.hash.slice(1));
        if (target?.closest("#edit-form")) open(target.closest("[data-guide-step]")?.dataset.guideStep || "review");
      });
      for (const id of ["feature-giving", "feature-sponsors", "feature-featured-sponsors", "feature-song-requests", "feature-vip-seating"]) {
        $(id).checked = true;
        $(id).disabled = true;
      }
      refresh();
      if (!wedding.couple_names?.trim()) open("couple");
    }
  };
})();
