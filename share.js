/* Share-link panel: prominent URL + Copy / Open / Share / WhatsApp. Click handling is delegated, so panels can be injected anywhere. */
(function (root) {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  function guestUrl(slug, origin) {
    return (origin || root.location.origin) + "/guest.html?slug=" + encodeURIComponent(slug || "");
  }
  function toast(message) {
    var el = document.getElementById("ws-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ws-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#203a31;color:#fff;border:1px solid #be9b52;padding:.7rem 1.2rem;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.3);z-index:9999;font:600 .95rem system-ui,sans-serif;transition:opacity .25s;opacity:0;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = "0"; }, 2400);
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copy(text) {
    var done = function (ok) { toast(ok ? "Link copied" : "Could not copy - select the link and copy it manually"); return ok; };
    if (root.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return done(true); }, function () { return done(fallbackCopy(text)); });
    }
    return Promise.resolve(done(fallbackCopy(text)));
  }
  function whatsappLink(url, title) {
    return "https://wa.me/?text=" + encodeURIComponent((title ? title + " - " : "") + url);
  }
  function panelHTML(url, opts) {
    opts = opts || {};
    var title = opts.title || "Our wedding";
    var note = opts.published === false ? '<p class="fine ws-share-note">Not published yet: guests will see this page only after you publish.</p>' : "";
    return '<div class="ws-share" data-ws-share-panel>' +
      '<p class="ws-share-label">Your guest site link</p>' +
      '<input class="ws-share-url" type="text" readonly value="' + esc(url) + '" aria-label="Guest site link" onclick="this.select()">' + note +
      '<div class="ws-share-actions">' +
      '<button type="button" data-ws-copy="' + esc(url) + '">Copy link</button>' +
      '<a class="btn secondary" data-ws-open href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open</a>' +
      '<button type="button" class="secondary" data-ws-share="' + esc(url) + '" data-title="' + esc(title) + '">Share</button>' +
      '<a class="btn secondary" data-ws-whatsapp href="' + esc(whatsappLink(url, title)) + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' +
      '</div></div>';
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest("[data-ws-copy]");
    if (c) { e.preventDefault(); copy(c.getAttribute("data-ws-copy")); return; }
    var s = e.target.closest && e.target.closest("[data-ws-share]");
    if (s) {
      e.preventDefault();
      var url = s.getAttribute("data-ws-share"), title = s.getAttribute("data-title") || "Our wedding";
      if (navigator.share) {
        navigator.share({ title: title, text: title, url: url }).catch(function (err) { if (err && err.name !== "AbortError") copy(url); });
      } else { copy(url); }
    }
  });
  root.WSShare = { guestUrl: guestUrl, copy: copy, toast: toast, whatsappLink: whatsappLink, panelHTML: panelHTML };
})(window);
