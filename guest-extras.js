/* Guest-site extras: sharing, calendar links, referral tracking, guestbook, FAQ/travel.
   Listens for "ws:wedding" (site loaded) and "ws:pass" (RSVP pass shown) dispatched by guest.html. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var params = new URLSearchParams(location.search);
  var slug = params.get("slug");
  var REF = /^[a-f0-9]{8}$/;
  var wedding = null, myRef = "", state = { shared: false };

  // Referral code of the person who invited this visitor (random short code, no PII).
  var incoming = params.get("ref");
  try {
    if (incoming && REF.test(incoming)) localStorage.setItem("ws-ref:" + slug, incoming);
    myRef = (JSON.parse(localStorage.getItem("ws-pass:" + slug) || "null") || {}).refCode || "";
  } catch (_) {}

  function toast(t, bad) { if (window.WSShare) window.WSShare.toast(t); else alert(t); }

  function shareUrl() {
    return location.origin + "/w/" + encodeURIComponent(slug) + (myRef ? "?ref=" + myRef : "");
  }
  function names() { return (wedding && wedding.couple_names) || "our wedding"; }
  function when() {
    if (!wedding || !wedding.wedding_date || !window.WSTime) return "";
    try { var ms = WSTime.weddingStart(wedding), z = wedding.time_zone || WSTime.DEFAULT_ZONE; return WSTime.formatDate(ms, z); } catch (_) { return String(wedding.wedding_date).slice(0, 10); }
  }
  function message() {
    return "You are invited to the wedding of " + names() + (when() ? " (" + when() + ")" : "") + ". RSVP and see the details here:";
  }
  function googleCalUrl() {
    var ms = window.WSTime && WSTime.weddingStart(wedding);
    if (ms == null) return "";
    var f = function (t) { return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    var q = new URLSearchParams({ action: "TEMPLATE", text: names() + " - Wedding", dates: f(ms) + "/" + f(ms + 4 * 3600 * 1000), details: "RSVP and details: " + location.origin + "/w/" + slug, location: wedding.public_location || "" });
    return "https://calendar.google.com/calendar/render?" + q.toString();
  }

  function shareBlock(id) {
    var url = shareUrl(), msg = message(), full = msg + " " + url, e = encodeURIComponent;
    var gcal = googleCalUrl();
    var h = '<div class="ws-share-block" id="' + id + '">' +
      '<div class="ws-share-actions">' +
      '<button type="button" data-ws-copy="' + esc(url) + '">Copy link</button>' +
      '<button type="button" class="secondary" data-ws-share="' + esc(url) + '" data-title="' + esc(names()) + '">Share&hellip;</button>' +
      '<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="https://wa.me/?text=' + e(full) + '">WhatsApp</a>' +
      '<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/sharer/sharer.php?u=' + e(url) + '">Facebook</a>' +
      '<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="https://twitter.com/intent/tweet?text=' + e(msg) + '&url=' + e(url) + '">X</a>' +
      '<a class="btn secondary" href="mailto:?subject=' + e("Wedding invitation: " + names()) + '&body=' + e(full) + '">Email</a>' +
      '<a class="btn secondary" href="sms:?&body=' + e(full) + '">SMS</a>' +
      '</div>' +
      '<div class="ws-share-actions"><button type="button" class="secondary" data-ws-ics>Save the date (.ics)</button>' +
      (gcal ? '<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="' + esc(gcal) + '">Add to Google Calendar</a>' : "") + '</div>' +
      '<p class="fine">' + (myRef ? "This is your personal invite link: the couple can see how many visits and RSVPs came through it (counts only; no IP addresses or contact details are stored)." : "RSVP to get your own personal invite link.") + '</p></div>';
    return h;
  }

  function renderShare() {
    var section = $("share-section");
    if (!section) {
      section = document.createElement("section");
      section.id = "share-section"; section.className = "card"; section.setAttribute("data-corners", "");
      var anchor = $("ecard") || document.querySelector("footer.ws-promo");
      anchor.parentNode.insertBefore(section, anchor);
    }
    section.innerHTML = "<h2>Share the celebration</h2>" + shareBlock("share-main");
    section.hidden = false;
    var ec = $("ecard-share");
    if (!ec && $("ecard")) { ec = document.createElement("div"); ec.id = "ecard-share"; $("ecard").appendChild(ec); }
    if (ec) ec.innerHTML = '<h3 style="margin-top:1.2rem">Invite others</h3>' + shareBlock("share-pass");
    var rs = $("rsvp-share");
    if (rs) rs.innerHTML = "";
    // Hero + footer quick links
    if (!$("hero-share-link")) {
      var hero = $("ics-download");
      if (hero && hero.parentNode) {
        var a = document.createElement("a");
        a.id = "hero-share-link"; a.className = "btn secondary"; a.href = "#share-section"; a.textContent = "Share";
        a.addEventListener("click", function (ev) { ev.preventDefault(); $("share-section").scrollIntoView({ behavior: "smooth" }); });
        hero.parentNode.insertBefore(a, hero.nextSibling);
      }
      var foot = document.querySelector("footer.ws-promo");
      if (foot) {
        var f = document.createElement("a");
        f.id = "footer-share-link"; f.href = "#share-section"; f.textContent = "Share this wedding";
        f.style.marginRight = "1rem";
        f.addEventListener("click", function (ev) { ev.preventDefault(); $("share-section").scrollIntoView({ behavior: "smooth" }); });
        foot.insertBefore(f, foot.firstChild);
      }
    }
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-ws-ics]")) {
      e.preventDefault();
      var b = $("ics-download");
      if (b) b.click();
    }
  });

  function setMeta(sel, attr, value) {
    var el = document.head.querySelector(sel);
    if (!el) { el = document.createElement("meta"); var m = sel.match(/\[(name|property)="([^"]+)"\]/); el.setAttribute(m[1], m[2]); document.head.appendChild(el); }
    el.setAttribute("content", value);
  }
  function renderMeta() {
    var t = names() + " are getting married";
    var d = "You are invited" + (when() ? " - " + when() : "") + ". RSVP, send wishes and save the date.";
    var img = "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80";
    [["property", "og:title", t], ["property", "og:description", d], ["property", "og:image", img], ["property", "og:url", location.origin + "/w/" + slug], ["property", "og:type", "website"],
     ["name", "twitter:card", "summary_large_image"], ["name", "twitter:title", t], ["name", "twitter:description", d], ["name", "twitter:image", img], ["name", "description", d]]
      .forEach(function (x) { setMeta("meta[" + x[0] + '="' + x[1] + '"]', x[0], x[2]); });
  }

  function trackVisit() {
    var key = "ws-visit:" + slug;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch (_) {}
    var ref = ""; try { ref = localStorage.getItem("ws-ref:" + slug) || ""; } catch (_) {}
    fetch("/api/guest?action=visit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: slug, ref: ref }) }).catch(function () {});
  }

  function renderExtras(data) {
    var before = $("ecard") || document.querySelector("footer.ws-promo");
    if (!$("info-section") && ((data.faq && data.faq.length) || data.travel)) {
      var s = document.createElement("section");
      s.id = "info-section"; s.className = "card";
      var h = "<h2>Travel &amp; FAQ</h2>";
      if (data.travel) h += "<h3>Travel &amp; accommodation</h3><p style=\"white-space:pre-wrap\">" + esc(data.travel) + "</p>";
      if (data.faq && data.faq.length) h += "<h3>Questions guests ask</h3>" + data.faq.map(function (f) { return "<details><summary>" + esc(f.q) + "</summary><p>" + esc(f.a) + "</p></details>"; }).join("");
      s.innerHTML = h;
      before.parentNode.insertBefore(s, before);
    }
    var g = $("guestbook");
    if (!g) {
      g = document.createElement("section");
      g.id = "guestbook"; g.className = "card";
      before.parentNode.insertBefore(g, before);
    }
    var wishes = (data.wishes || []).map(function (w) { return '<blockquote class="wish"><p>' + esc(w.message) + "</p><footer>&mdash; " + esc(w.author_name) + "</footer></blockquote>"; }).join("");
    g.innerHTML = "<h2>Guestbook</h2><p class=\"fine\">Leave a wish for the couple. Wishes appear after the couple approves them.</p>" +
      '<form id="wish-form"><label for="wish-name">Your name *</label><input id="wish-name" maxlength="80" required>' +
      '<label for="wish-text">Your wish *</label><textarea id="wish-text" rows="3" maxlength="500" required></textarea>' +
      '<button type="submit">Send wish</button></form><div id="wish-items">' + (wishes || '<p class="fine">Be the first to leave a wish.</p>') + "</div>";
    $("wish-form").addEventListener("submit", function (e) {
      e.preventDefault();
      fetch("/api/guest?action=wish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: slug, name: $("wish-name").value, message: $("wish-text").value }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) { toast(x.ok ? x.d.message : (x.d.error || "Could not send your wish."), !x.ok); if (x.ok) $("wish-form").reset(); })
        .catch(function () { toast("Network error.", true); });
    });
  }

  document.addEventListener("ws:wedding", function (e) {
    wedding = e.detail;
    renderMeta();
    renderShare();
    trackVisit();
    fetch("/api/guest?action=extras&slug=" + encodeURIComponent(slug)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) { renderExtras(d); renderShare(); } }).catch(function () {});
  });
  document.addEventListener("ws:pass", function (e) {
    if (e.detail && e.detail.refCode) myRef = e.detail.refCode;
    if (wedding) renderShare();
  });
})();
