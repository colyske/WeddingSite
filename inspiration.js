(() => {
  "use strict";
  const esc = value => String(value).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const art = item => `style="--inspiration-ink:${item.palette[0]};--inspiration-paper:${item.palette[3]};--inspiration-accent:${item.palette[2]}"`;
  const palette = item => `<div class="inspiration-palette">${item.palette.map((color, index) =>
    `<span><i style="background:${color}" aria-hidden="true"></i>${esc(item.paletteNames[index])}</span>`).join("")}</div>`;
  const selected = new URLSearchParams(location.search).get("style");
  const item = WSInspiration.get(selected);
  const gallery = document.getElementById("inspiration-gallery");
  if (selected && !item) {
    const error = document.getElementById("inspiration-error");
    error.hidden = false;
    error.textContent = "That style is unavailable. Choose one of the fictional examples below.";
  }
  gallery.innerHTML = WSInspiration.fixtures.map(style => `<article class="inspiration-card">
    <div class="inspiration-art" ${art(style)}><span>Fictional inspiration</span><strong>${esc(style.names)}</strong><span>${esc(style.mood)}</span></div>
    <div class="inspiration-card-copy"><h2>${esc(style.title)}</h2><p>${esc(style.mood)}</p>${palette(style)}
    <a class="btn" href="/inspiration.html?style=${encodeURIComponent(style.id)}">Preview ${esc(style.title)}</a></div>
    </article>`).join("");
  if (!item) return;
  gallery.hidden = true;
  const preview = document.getElementById("inspiration-preview");
  preview.hidden = false;
  document.title = `${item.title} - Fictional wedding inspiration`;
  preview.innerHTML = `<a href="/inspiration.html">Back to all styles</a>
    <div class="inspiration-art inspiration-preview-hero" ${art(item)}><span>${esc(item.title)} / Fictional example</span>
      <strong>${esc(item.names)}</strong><span>${esc(item.date)} / ${esc(item.location)}</span></div>
    <div class="inspiration-start"><h2>Make this style yours</h2>
      <p>Start a <strong>new private draft</strong> with these colours, event titles and editable sample event notes. Add your own names and choose your currency in the guided setup. Nothing is created until you submit that form.</p>
      <p>Fictional identities, dates, times and places are not copied. Welcome, attire, travel and FAQ text below are writing inspiration, not saved answers. No prices, payment settings, guests, sponsors or activity are copied. Existing weddings stay untouched.</p>
      <a class="btn primary" href="/dashboard.html?inspiration=${encodeURIComponent(item.id)}#step=couple">Use this style</a></div>
    <div class="inspiration-preview-columns">
      <section class="card"><h2>A note to our guests</h2><p>${esc(item.welcome)}</p><h2>Colours & attire</h2>${palette(item)}<p>${esc(item.attire)}</p></section>
      <section class="card"><h2>The sample programme</h2>${item.events.map(event => `<article class="inspiration-event">
        <h3>${esc(event.name)}</h3><p class="fine">${event.kind === "pre" ? "Before the wedding" : "Wedding day"} / ${esc(event.time)} / ${esc(event.place)}</p><p>${esc(event.description)}</p></article>`).join("")}</section>
      <section class="card"><h2>Travel notes</h2><p>${esc(item.travel)}</p><h2>Questions & answers</h2>${item.faq.map(([q, a]) =>
        `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
    </div>`;
})();
