/* Decorative wedding-mood graphics: inline SVG + CSS only, no network, no images. */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var G = "var(--gold,#be9b52)";
  var shapes = {
    rings: '<svg viewBox="0 0 80 48" aria-hidden="true"><circle cx="30" cy="26" r="16" fill="none" stroke="' + G + '" stroke-width="3.5"/><circle cx="50" cy="26" r="16" fill="none" stroke="var(--sage,#a9b5a2)" stroke-width="3.5"/><path d="M30 10a16 16 0 0 1 8 2.2" fill="none" stroke="' + G + '" stroke-width="3.5"/><path d="M40 6l3 4-3 4-3-4z" fill="' + G + '"/></svg>',
    bell: '<svg viewBox="0 0 48 56" aria-hidden="true"><path d="M24 6c-9 0-14 7-14 17 0 8-3 12-6 16h40c-3-4-6-8-6-16C38 13 33 6 24 6z" fill="none" stroke="' + G + '" stroke-width="2.5" stroke-linejoin="round"/><circle cx="24" cy="46" r="4" fill="' + G + '"/><circle cx="24" cy="5" r="2.5" fill="' + G + '"/></svg>',
    balloon: '<svg viewBox="0 0 40 80" aria-hidden="true"><ellipse cx="20" cy="24" rx="16" ry="20" fill="currentColor" opacity=".85"/><path d="M20 44l-3 5h6z" fill="currentColor"/><path d="M20 49c-6 8 6 14 0 28" fill="none" stroke="' + G + '" stroke-width="1.5"/><ellipse cx="13" cy="15" rx="3.5" ry="6" fill="#fff" opacity=".35" transform="rotate(25 13 15)"/></svg>',
    flower: '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M2 2C2 60 30 100 118 118" fill="none" stroke="var(--sage,#a9b5a2)" stroke-width="2"/><g transform="translate(34 34)"><g fill="' + G + '" opacity=".9"><ellipse cx="0" cy="-13" rx="6" ry="12"/><ellipse cx="0" cy="13" rx="6" ry="12"/><ellipse cx="-13" cy="0" rx="12" ry="6"/><ellipse cx="13" cy="0" rx="12" ry="6"/></g><circle r="6" fill="var(--ivory,#f6f1e4)"/></g><g fill="var(--sage,#a9b5a2)"><ellipse cx="66" cy="70" rx="14" ry="5" transform="rotate(35 66 70)"/><ellipse cx="22" cy="84" rx="14" ry="5" transform="rotate(75 22 84)"/><ellipse cx="88" cy="96" rx="12" ry="4.5" transform="rotate(20 88 96)"/></g></svg>',
    petal: '<svg viewBox="0 0 20 28" aria-hidden="true"><path d="M10 1C20 9 20 22 10 27 0 22 0 9 10 1z" fill="currentColor"/></svg>'
  };

  var L = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  var props = {
    ringsLine: '<svg viewBox="0 0 90 60" aria-hidden="true" ' + L + '><circle cx="34" cy="36" r="18"/><circle cx="56" cy="36" r="18"/><path d="M34 18l-5-8 6-5 6 5-3 6M30 11h10"/></svg>',
    cake: '<svg viewBox="0 0 80 90" aria-hidden="true" ' + L + '><rect x="12" y="62" width="56" height="18" rx="2"/><rect x="20" y="42" width="40" height="20" rx="2"/><rect x="28" y="26" width="24" height="16" rx="2"/><path d="M12 70c7 4 11-4 17 0s11-4 17 0 11-4 17 0M20 50c5 3 8-3 13 0s8-3 13 0 8-3 14 0M40 26v-8M40 18c-3-4 0-8 0-10 0 2 3 6 0 10z"/><circle cx="40" cy="84" r="0"/><path d="M6 80h68"/></svg>',
    bouquet: '<svg viewBox="0 0 80 100" aria-hidden="true" ' + L + '><path d="M40 98L28 60M40 98l12-38M40 98V62"/><circle cx="28" cy="50" r="9"/><circle cx="52" cy="50" r="9"/><circle cx="40" cy="36" r="10"/><path d="M24 46c3 2 6 2 8 0M48 46c3 2 6 2 8 0M36 32c2 3 6 3 8 0M30 70c-12-4-16-12-14-20M50 70c12-4 16-12 14-20"/><path d="M32 82l16 0M30 88l20 0" /></svg>',
    couple: '<svg viewBox="0 0 150 200" aria-hidden="true" fill="currentColor" stroke="none"><path d="M52 14c-9 0-14 7-13 15 1 7 5 12 9 14-3 3-6 8-6 15l-6 22c-2 8-1 16 3 24L16 188c-1 4 2 8 6 8h74c4 0 7-4 6-8L82 104c4-8 5-16 3-24l-6-22c0-7-3-12-6-15 4-2 8-7 9-14 1-8-4-15-13-15-5 0-9 2-11 5-2-3-4-5-6-5z" opacity=".92"/><path d="M52 6c-14 2-24 12-26 28 4-6 12-10 26-10z" opacity=".5"/><circle cx="112" cy="30" r="12"/><path d="M98 50c-4 3-6 8-6 14v60h12l2 72h18l2-72h10V64c0-6-2-11-6-14l-9 8-4-8-4 8z"/><path d="M84 92c8-4 14-2 18 4l-4 6c-4-3-8-3-12-1z" opacity=".95"/></svg>',
    dove: '<svg viewBox="0 0 90 60" aria-hidden="true" ' + L + '><path d="M10 38c10 6 22 4 30-4 6 4 14 4 20-2 8 2 16-4 20-12-8 2-14 0-18-4-4-8-14-10-22-6-8 4-8 14-14 18-6 2-12 2-16 10z"/><path d="M40 34c-6-14 0-24 10-30 0 10 4 16 10 20M72 14l8-4-6 8"/><circle cx="68" cy="16" r=".8"/></svg>',
    bell2: '<svg viewBox="0 0 70 70" aria-hidden="true" ' + L + '><path d="M22 14c-8 0-12 8-12 18 0 8-3 12-5 16h28c-2-4-5-8-5-16 0-10-4-18-6-18"/><circle cx="22" cy="54" r="3"/><path d="M58 20c-8 0-12 8-12 18 0 8-3 12-5 16h28c-2-4-5-8-5-16 0-10-4-18-6-18" transform="translate(-10 4) scale(.8)"/><path d="M30 8c4-6 10-6 14 0"/></svg>',
    ribbon: '<svg viewBox="0 0 120 50" aria-hidden="true" ' + L + '><path d="M60 22c-14-14-34-14-38-6s8 14 38 6zM60 22c14-14 34-14 38-6s-8 14-38 6z"/><circle cx="60" cy="22" r="4"/><path d="M56 26L40 48l12-6 4 8M64 26l16 22-12-6-4 8"/></svg>',
    balloons: '<svg viewBox="0 0 90 120" aria-hidden="true" ' + L + '><ellipse cx="30" cy="30" rx="18" ry="22"/><ellipse cx="62" cy="38" rx="16" ry="20"/><path d="M30 52l-3 5h6zM62 58l-3 5h6zM30 57c-6 18 14 28 12 60M62 63c8 18-14 28-18 54"/></svg>',
    petals: '<svg viewBox="0 0 90 60" aria-hidden="true" ' + L + '><path d="M15 12c8 4 10 14 2 20-8-4-10-14-2-20zM48 28c9 3 12 13 4 20-9-3-12-13-4-20zM72 8c7 4 8 12 1 17-7-3-8-12-1-17z"/></svg>',
    floralCorner: '<svg viewBox="0 0 100 100" aria-hidden="true" ' + L + '><path d="M4 4c0 40 20 70 92 92"/><circle cx="26" cy="26" r="10"/><path d="M26 16c-3 4-3 6 0 10 3-4 3-6 0-10zM16 26c4-3 6-3 10 0-4 3-6 3-10 0zM36 26c-4-3-6-3-10 0 4 3 6 3 10 0zM26 36c-3-4-3-6 0-10 3 4 3 6 0 10z"/><path d="M52 52c8-6 14-4 16 2-6 2-12 2-16-2zM30 62c-2-8 2-12 8-12 0 6-2 10-8 12zM74 76c8-2 12 2 12 8-6 0-10-2-12-8z"/></svg>'
  };
  Object.keys(props).forEach(function (k) { shapes[k] = props[k]; });

  function propRow(list) {
    var r = document.createElement("div");
    r.className = "prop-row";
    r.setAttribute("aria-hidden", "true");
    list.split(",").forEach(function (k, i) {
      if (!shapes[k.trim()]) return;
      var e = svg(k.trim(), "prop-float");
      e.style.animationDelay = "-" + (i * 1.3) + "s";
      r.appendChild(e);
    });
    return r;
  }

  function announcement() {
    if (document.querySelector(".announcement") || document.body.hasAttribute("data-no-announcement")) return;
    var a = document.createElement("div");
    a.className = "announcement";
    a.innerHTML = '<i></i><span>A celebration of love, family &amp; home</span><span aria-hidden="true">&middot;</span><span id="announce-date">WeddingSite</span>';
    document.body.insertBefore(a, document.body.firstChild);
  }
  function svg(name, cls) {
    var s = document.createElement("span");
    s.className = "orn " + (cls || "");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = shapes[name];
    return s;
  }

  function divider() {
    var d = document.createElement("div");
    d.className = "orn-divider";
    d.setAttribute("aria-hidden", "true");
    d.innerHTML = '<i></i><svg viewBox="0 0 80 48" width="44" height="26"><circle cx="30" cy="26" r="14" fill="none" stroke="' + G + '" stroke-width="3"/><circle cx="50" cy="26" r="14" fill="none" stroke="' + G + '" stroke-width="3"/></svg><i></i>';
    return d;
  }

  function init() {
    if (document.querySelector(".orn-layer")) return;
    var layer = document.createElement("div");
    layer.className = "orn-layer";
    layer.setAttribute("aria-hidden", "true");
    ["tl", "br"].forEach(function (p) { layer.appendChild(svg("flower", "orn-corner orn-" + p)); });
    var colors = ["var(--gold,#be9b52)", "var(--sage,#a9b5a2)", "#e9d9b0", "var(--gold,#be9b52)", "var(--sage,#a9b5a2)", "#e9d9b0", "var(--gold,#be9b52)"];
    colors.forEach(function (c, i) {
      var p = svg("petal", "orn-petal");
      p.style.cssText = "left:" + (6 + i * 14) + "%;color:" + c + ";animation-duration:" + (14 + (i % 4) * 4) + "s;animation-delay:-" + (i * 3) + "s;";
      layer.appendChild(p);
    });
    document.body.insertBefore(layer, document.body.firstChild);

    announcement();
    document.querySelectorAll("[data-props]").forEach(function (el) { el.appendChild(propRow(el.getAttribute("data-props"))); });
    document.querySelectorAll("[data-corners]").forEach(function (el) {
      ["tl", "tr", "bl", "br"].forEach(function (c) { var o = svg("floralCorner", "prop-corner " + c); el.appendChild(o); });
    });
    document.querySelectorAll("[data-prop-hero]").forEach(function (el) {
      var o = svg(el.getAttribute("data-prop-hero"), "prop-hero prop-float");
      el.appendChild(o);
    });
    var bal = document.querySelector("[data-balloons]");
    if (bal) {
      ["#244b3a", "#be9b52", "#a9b5a2"].forEach(function (c, i) {
        var b = svg("balloon", "orn-balloon");
        b.style.color = c;
        b.style.animationDelay = "-" + i * 1.7 + "s";
        bal.appendChild(b);
      });
    }
    document.querySelectorAll("[data-orn]").forEach(function (el) {
      var k = el.getAttribute("data-orn");
      if (k === "divider") el.appendChild(divider());
      else if (shapes[k]) el.appendChild(svg(k, "orn-inline"));
    });
    document.querySelectorAll("main h1, .wrap > h1, .card > h1, .hero h1").forEach(function (h) {
      if (h.nextElementSibling && h.nextElementSibling.classList.contains("orn-divider")) return;
      if (h.closest("[data-no-divider]")) return;
      h.insertAdjacentElement("afterend", divider());
    });
  }

  window.WSOrn = { svg: svg, divider: divider, propRow: propRow, shapes: shapes };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
