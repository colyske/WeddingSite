(() => {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icons = { facebook: "f", instagram: "◎", x: "X", youtube: "▶", tiktok: "♪", linkedin: "in" };
  function website(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function render(sponsor, { currency = "USD", featured = "" } = {}) {
    let socials;
    try { socials = WSSocialLinks.parse(sponsor.social_links); }
    catch {
      console.warn("Sponsor social profiles failed validation.");
      socials = null;
    }
    const name = sponsor.company_name || "Wedding sponsor";
    const email = sponsor.public_contact === true && /^[^\s@<>:"?]+@[^\s@<>:"?]+\.[^\s@<>:"?]+$/.test(sponsor.contact_email || "")
      ? sponsor.contact_email : "";
    const phone = sponsor.public_contact === true && /^\+?[0-9 ()-]{7,25}$/.test(sponsor.contact_phone || "")
      ? sponsor.contact_phone : "";
    const url = website(sponsor.website);
    return `<article class="sponsor-ad">
      <div class="sponsor-ad-art" aria-hidden="true"><span>${esc(name.trim().slice(0, 1))}</span></div>
      <div class="sponsor-ad-copy">
        <p class="eyebrow">${esc(featured || (sponsor.in_kind ? "Historical supporter" : "Celebration partner"))}</p>
        <h3>${esc(name)}</h3>
        ${sponsor.offer ? `<p class="sponsor-ad-offer">${esc(sponsor.offer)}</p>` : ""}
        ${sponsor.location ? `<p class="fine">${esc(sponsor.location)}</p>` : ""}
        <p class="sponsor-ad-support">${sponsor.in_kind ? "Historical non-cash support" : esc(WS.money(sponsor.amount_minor, currency, false)) + " in support"}</p>
        ${socials ? `<div class="sponsor-socials">${Object.entries(socials).map(([platform, href]) =>
          `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(name)} on ${esc(WSSocialLinks.labels[platform])}" title="${esc(WSSocialLinks.labels[platform])}"><span aria-hidden="true">${icons[platform]}</span><span class="sr-only">${esc(WSSocialLinks.labels[platform])}</span></a>`).join("")}</div>`
          : '<p class="fine">Social profiles unavailable.</p>'}
        <div class="sponsor-ad-contact">
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Visit website <span aria-hidden="true">&#8599;</span></a>` : ""}
          ${email ? `<a href="mailto:${esc(email)}" aria-label="Email ${esc(name)}">${esc(email)}</a>` : ""}
          ${phone ? `<a href="tel:${esc(phone.replace(/[^+0-9]/g, ""))}" aria-label="Call ${esc(name)}">${esc(phone)}</a>` : ""}
        </div>
      </div>
    </article>`;
  }
  window.WSSponsorCards = { render };
})();
