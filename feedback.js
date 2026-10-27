/* Shared submit feedback: toast + scroll-to-result. Loaded on every interactive page. */
(function (root) {
  "use strict";
  var lastToast = 0, timer;
  function el() {
    var t = document.getElementById("ws-fb-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ws-fb-toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
      t.style.cssText = "position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:2147483000;max-width:90vw;padding:.8rem 1.3rem;border-radius:10px;color:#fff;font:600 .9rem/1.3 'DM Sans',system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.28);border-left:4px solid #BE9B52;transition:opacity .25s;opacity:0";
      document.body.appendChild(t);
    }
    return t;
  }
  function toast(msg, bad) {
    if (!msg || !document.body) return;
    var t = el();
    t.textContent = (bad ? "" : "\u2713 ") + msg;
    t.style.background = bad ? "#8a2a2a" : "#203a31";
    t.style.opacity = "1"; lastToast = Date.now();
    clearTimeout(timer); timer = setTimeout(function () { t.style.opacity = "0"; }, 4500);
  }
  function scrollTo(target) {
    var n = typeof target === "string" ? document.getElementById(target) : target;
    if (!n || n.hidden) return;
    var reduce = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    n.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    if (!n.hasAttribute("tabindex")) n.setAttribute("tabindex", "-1");
    try { n.focus({ preventScroll: true }); } catch (_) {}
  }
  function done(msg, target, bad) { toast(msg, bad); if (target) setTimeout(function () { scrollTo(target); }, 60); }

  // Fallback acknowledgement for any successful write when the page showed no message of its own.
  var origFetch = root.fetch;
  if (origFetch) {
    root.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var p = origFetch.apply(this, arguments);
      if (method !== "GET" && /\/api\//.test(url) && !/action=(visit|og)\b/.test(url)) {
        p.then(function (res) {
          setTimeout(function () {
            if (Date.now() - lastToast < 2500) return;
            if (res.ok) toast("Saved \u2014 we\u2019ve noted your input.");
            else if (res.status !== 401) toast("That didn\u2019t go through. Please check the form and try again.", true);
          }, 700);
        }).catch(function () {});
      }
      return p;
    };
  }
  root.WSFeedback = { toast: toast, scrollTo: scrollTo, done: done };
})(window);
