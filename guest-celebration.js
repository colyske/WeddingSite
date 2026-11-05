/* Shared public-wedding presentation. Illustrations never contain guest or payment data. */
(function () {
  "use strict";
  const flower = (x, y, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})"><g fill="var(--petal)"><ellipse cy="-13" rx="9" ry="15"/><ellipse cy="13" rx="9" ry="15"/><ellipse cx="-13" rx="15" ry="9"/><ellipse cx="13" rx="15" ry="9"/></g><circle r="7" fill="var(--honey)"/></g>`;
  const heart = (x, y, scale = 1) => `<path transform="translate(${x} ${y}) scale(${scale})" d="M0 8C-22-8-16-26-5-22L0-17 5-22C16-26 22-8 0 8Z" fill="var(--rose)"/>`;
  const leaves = '<g fill="var(--leaf)"><path d="M55 203C16 178 23 146 23 146c29 2 39 28 32 57ZM60 188c-5-35 22-51 22-51 15 27 2 45-22 51ZM254 192c-8-34 20-55 20-55 17 26 6 46-20 55ZM264 203c18-35 45-34 45-34-1 26-21 38-45 34Z"/></g>';
  const bow = '<g fill="var(--rose)" stroke="var(--rose-ink)" stroke-width="1.5"><path d="M160 112c-76-65-84 25 0 0Zm0 0c76-65 84 25 0 0Z"/><path d="m153 116-21 51 18-9 10 14 5-55m0 0 31 43-18-3-7 14-14-55"/><ellipse cx="160" cy="112" rx="8" ry="6"/></g>';
  const illustrations = {
    bouquet: `<path d="m151 227-43-109m43 109 40-115m-40 115 1-142m0 119-68-46m72 44 66-52" stroke="var(--leaf)" stroke-width="4" fill="none"/>${leaves}${flower(105, 105, 1.1)}${flower(188, 100, 1.25)}${flower(151, 62, 1.15)}${flower(216, 144, .8)}${flower(80, 146, .75)}<g transform="translate(-8 76) scale(1 .8)">${bow}</g>${heart(252, 66, .55)}`,
    cake: `<ellipse cx="160" cy="237" rx="123" ry="9" fill="var(--leaf)" opacity=".12"/>${leaves}<g stroke="var(--gold)" stroke-width="2"><path d="M72 172h176v55H72z" fill="var(--petal)"/><path d="M95 120h130v52H95z" fill="var(--paper)"/><path d="M118 74h84v46h-84z" fill="var(--petal)"/><path d="M72 182q22 28 44 0 22 28 44 0 22 28 44 0 22 28 44 0M95 129q22 25 44 0 22 25 43 0 22 25 43 0M118 83q21 24 42 0 21 24 42 0" fill="none"/><path d="M58 229h204m-102 0v12m-45 0h90"/></g>${flower(219, 169, .6)}${flower(97, 119, .55)}${heart(160, 60, .75)}<path d="M160 65v9" stroke="var(--gold)" stroke-width="3"/>`,
    gifts: `<ellipse cx="160" cy="240" rx="130" ry="9" fill="var(--rose)" opacity=".14"/>${leaves}<g stroke="var(--gold)" stroke-width="1.5"><path d="M56 143h113v90H56z" fill="var(--petal)"/><path d="M48 132h129v24H48z" fill="var(--paper)"/><path d="M191 151h78v82h-78z" fill="var(--honey)"/><path d="M184 142h92v22h-92z" fill="var(--paper)"/></g><path d="M104 132h18v101h-18zm119 10h14v91h-14z" fill="var(--rose)"/><g transform="translate(-47 20) scale(1 .97)">${bow}</g><g transform="translate(126 64) scale(.65 .7)">${bow}</g>${heart(240, 68, .75)}${heart(74, 62, .4)}${flower(172, 214, .55)}`,
    music: `<circle cx="158" cy="135" r="100" fill="var(--green-deep)"/><g fill="none" stroke="var(--paper)" opacity=".25"><circle cx="158" cy="135" r="87"/><circle cx="158" cy="135" r="78"/><circle cx="158" cy="135" r="68"/></g><circle cx="158" cy="135" r="42" fill="var(--petal)"/><circle cx="158" cy="135" r="5" fill="var(--green-deep)"/>${heart(158, 125, .6)}${flower(72, 209, .95)}${flower(252, 61, .8)}<path d="m264 144 21-7v47m-21-40v47m-9-1c-12 0-13 14-2 14 10 0 16-14 2-14Zm21-7c-12 0-13 14-2 14 10 0 16-14 2-14Z" fill="var(--honey)" stroke="var(--honey)" stroke-width="3"/>`,
    letter: `${leaves}<g stroke="var(--gold)" stroke-width="2"><path d="m56 112 104-75 104 75v112H56Z" fill="var(--petal)"/><path d="M83 51h154v148H83z" fill="var(--paper)"/><path d="M108 87h103m-103 15h82m-66 16h67" stroke="var(--leaf)" opacity=".5"/><path d="m56 112 104 67 104-67v112H56z" fill="var(--petal)"/><path d="m56 224 104-69 104 69" fill="var(--paper)"/></g>${heart(160, 176, .8)}${flower(63, 209, .6)}${heart(268, 55, .4)}`,
    balloons: `<g stroke="var(--gold)" stroke-width="2" fill="none"><path d="M113 126c-20 54 70 53 47 125m48-105c27 46-68 57-48 105m0-153v153"/></g><ellipse cx="113" cy="79" rx="43" ry="53" fill="var(--rose)"/><ellipse cx="208" cy="105" rx="40" ry="49" fill="var(--honey)"/><path d="m113 131-8 9h16zm95 23-8 9h16z" fill="var(--rose-ink)"/><path d="M94 51q-12 10-10 28m105 4q-10 10-9 23" stroke="var(--paper)" stroke-width="6" fill="none" stroke-linecap="round"/>${heart(164, 37, .7)}${flower(249, 218, .7)}`,
    ribbon: `<path d="M47 148h226M75 199h170" stroke="var(--gold)" opacity=".35"/><g transform="translate(-48 -5) scale(1.3)">${bow}</g>${flower(60, 193, .8)}${flower(259, 176, .65)}${heart(162, 48, .65)}`,
    garden: `<path d="M72 231V112a88 88 0 0 1 176 0v119M88 231V112a72 72 0 0 1 144 0v119" fill="none" stroke="var(--gold)" stroke-width="2"/>${leaves}${flower(86, 82, .9)}${flower(119, 43, .65)}${flower(242, 154, .7)}<path d="M105 231h110" stroke="var(--gold)" stroke-width="2"/>${heart(160, 139, 1.2)}`
  };
  const artFor = {
    welcome: "garden", story: "bouquet", details: "bouquet", venues: "cake", prewedding: "balloons", campaigns: "garden",
    registry: "gifts", rsvp: "letter", bids: "music", ledger: "ribbon",
    "sponsor-tiers": "ribbon", "vip-section": "garden", sponsors: "bouquet",
    seating: "ribbon", "share-section": "balloons", "info-section": "garden",
    guestbook: "letter", ecard: "letter"
  };
  function decorate() {
    for (const [id, name] of Object.entries(artFor)) {
      const section = document.getElementById(id);
      if (!section || section.querySelector(".celebration-art")) continue;
      const art = document.createElement("div");
      art.className = "celebration-art";
      art.setAttribute("aria-hidden", "true");
      art.innerHTML = `<svg viewBox="0 0 320 260" focusable="false">${illustrations[name]}</svg>`;
      section.append(art);
    }
  }
  function orderSections() {
    const main = document.getElementById("wedding-content");
    const active = document.activeElement;
    for (const id of [
      "welcome", "countdown-band", "past-banner", "story", "details", "venues", "prewedding", "info-section",
      "rsvp", "ecard", "campaigns", "registry", "bids", "ledger", "sponsors", "sponsor-tiers",
      "vip-section", "seating", "guestbook", "share-section"
    ]) {
      const section = document.getElementById(id);
      if (section?.parentElement === main) main.append(section);
    }
    if (active && active !== document.activeElement && main.contains(active)) active.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent("ws:sections-ordered"));
  }
  document.addEventListener("ws:preview-ready", orderSections);
  document.addEventListener("ws:extras-ready", orderSections);
  orderSections();
  decorate();
  new MutationObserver(decorate).observe(document.getElementById("wedding-content"), { childList: true });

  const nav = document.querySelector(".sticky-nav");
  const toggle = document.getElementById("wedding-nav-toggle");
  const links = document.getElementById("wedding-nav-links");
  nav.classList.add("celebration-ready");
  function closeMenu() { toggle.setAttribute("aria-expanded", "false"); }
  toggle.addEventListener("click", () => {
    toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
  });
  nav.addEventListener("keydown", event => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      closeMenu();
      toggle.focus();
    }
  });
  links.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (!link) return;
    closeMenu();
    const section = document.querySelector(link.hash);
    if (section) {
      section.tabIndex = -1;
      section.focus({ preventScroll: true });
    }
  });
  document.addEventListener("click", event => { if (!nav.contains(event.target)) closeMenu(); });

  function showcaseCta() {
    if (!document.body.dataset.showcase || document.querySelector(".showcase-create")) return;
    const cta = document.createElement("a");
    cta.className = "showcase-create";
    cta.href = WSSite.platformUrl("/signin.html?mode=register&next=" + encodeURIComponent("/dashboard.html?style=showcase-wedding#step=couple"));
    cta.setAttribute("aria-description", "Free publication eligibility is confirmed before publishing; date and account limits may apply.");
    cta.title = "Free publication eligibility is confirmed before publishing; date and account limits may apply.";
    cta.innerHTML = `<svg viewBox="0 0 36 40" aria-hidden="true">${heart(18, 30, .65)}</svg><span><strong>Create yours</strong><small>It&#8217;s free!</small></span>`;
    document.body.append(cta);
    let queued = false;
    function update() {
      queued = false;
      cta.hidden = false;
      const box = cta.getBoundingClientRect();
      cta.hidden = [...document.querySelectorAll("form, main button, main .btn, main summary, footer, #welcome-story, #reuse-wedding-style, .celebration-fund, dialog[open]")]
        .some(el => {
          const r = el.getBoundingClientRect();
          if (el.matches("footer") && r.top < innerHeight && r.bottom > 0) return true;
          return r.width > 0 && r.height > 0 && box.right > r.left && box.left < r.right && box.bottom > r.top && box.top < r.bottom;
        });
    }
    function schedule() { if (!queued) { queued = true; requestAnimationFrame(update); } }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    new ResizeObserver(schedule).observe(document.getElementById("wedding-content"));
    update();
    document.addEventListener("pointerdown", event => {
      if (event.target.closest('form, [data-buy], [data-song-bid], #sponsor-cta')) {
        WSShare.toast("Demo: payments and submissions are disabled.");
      }
    });
  }
  document.addEventListener("ws:wedding", showcaseCta);
  showcaseCta();
})();
