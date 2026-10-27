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

  window.WSOrn = { svg: svg, divider: divider };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
