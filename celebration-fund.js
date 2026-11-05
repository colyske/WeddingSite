/* The public aggregate is the only input; never add overlapping UI totals. */
(function (root) {
  "use strict";
  const sources = [
    { key: "gifts", label: "Gifts & fundraisers", color: "#b86f7b" },
    { key: "songs", label: "Song bids", color: "#7b5144" },
    { key: "registry", label: "Registry gifts", color: "#e6d3ad" },
    { key: "sponsors", label: "Sponsorship", color: "#c58d4e" },
    { key: "vip", label: "VIP", color: "#9b4956" }
  ];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const amount = value => Number.isSafeInteger(value) && value >= 0;
  function model(data, currency) {
    if (!data || data.currency !== currency || !amount(data.goal_minor) || !amount(data.raised_minor) ||
        !Array.isArray(data.sources) || data.sources.length !== sources.length) {
      throw new Error("Celebration Fund progress is unavailable.");
    }
    const rows = sources.map(source => {
      const matches = data.sources.filter(row => row.key === source.key);
      if (matches.length !== 1 || !amount(matches[0].amount_minor)) throw new Error("Invalid Celebration Fund source.");
      return { ...source, amount: matches[0].amount_minor };
    });
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    if (!Number.isSafeInteger(total) || total !== data.raised_minor ||
        data.remaining_minor !== Math.max(0, data.goal_minor - total)) {
      throw new Error("Celebration Fund sources do not reconcile.");
    }
    const denominator = Math.max(total, data.goal_minor);
    rows.push({ key: "remaining", label: "Remaining", color: "#fffcf6", amount: data.remaining_minor });
    // Largest remainders keep the displayed legend at exactly 100.0%.
    const units = rows.map(row => denominator ? row.amount / denominator * 1000 : 0);
    const rounded = units.map(Math.floor);
    const order = units.map((value, i) => ({ i, fraction: value - rounded[i] }))
      .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
    if (denominator) {
      const remainder = 1000 - rounded.reduce((sum, value) => sum + value, 0);
      for (let i = 0; i < remainder; i++) {
        rounded[order[i].i]++;
      }
    }
    let start = -Math.PI / 2;
    rows.forEach((row, i) => {
      row.share = denominator ? row.amount / denominator : 0;
      row.percent = rounded[i] / 10;
      row.start = start;
      row.end = start + row.share * Math.PI * 2;
      start = row.end;
    });
    return {
      rows, total, goal: data.goal_minor, remaining: data.remaining_minor,
      completion: data.goal_minor ? Math.round(total / data.goal_minor * 1000) / 10 : 0,
      over: total > data.goal_minor, basis: total > data.goal_minor ? "raised" : "goal"
    };
  }
  function wedge(start, end) {
    const point = angle => `${(160 + 102 * Math.cos(angle)).toFixed(5)} ${(140 + 102 * Math.sin(angle)).toFixed(5)}`;
    // Two arcs also handle the exact full-circle case without a degenerate SVG arc.
    const middle = (start + end) / 2;
    return `M160 140L${point(start)}A102 102 0 0 1 ${point(middle)}A102 102 0 0 1 ${point(end)}Z`;
  }
  const edgePoint = (angle, depth = 0) => `${(160 + 102 * Math.cos(angle)).toFixed(5)} ${(110 + 61.2 * Math.sin(angle) + depth).toFixed(5)}`;
  function side(start, end) {
    const a = Math.max(0, start), b = Math.min(Math.PI, end);
    if (b <= a) return "";
    return `M${edgePoint(a)}A102 61.2 0 0 1 ${edgePoint(b)}L${edgePoint(b, 48)}A102 61.2 0 0 0 ${edgePoint(a, 48)}Z`;
  }
  const cut = angle => `M160 110L${edgePoint(angle)}L${edgePoint(angle, 48)}L160 158Z`;
  function render(data, currency, money, sample = false) {
    const m = model(data, currency);
    if (!m.goal) return "";
    const paid = m.rows.filter(row => row.key !== "remaining" && row.amount > 0);
    const paths = paid.map(row => ({ ...row, path: wedge(row.start, row.end) }));
    const remaining = m.rows.find(row => row.key === "remaining");
    const totalText = esc(money(m.total, currency, false));
    const goalText = esc(money(m.goal, currency, false));
    const remainingText = esc(money(m.remaining, currency, false));
    const description = `${m.completion}% of goal. Raised ${totalText} toward ${goalText}. Remaining ${remainingText}.${sample ? " Illustrative sample." : ""}`;
    return `<div class="celebration-fund">
      <div class="cake-heading"><span class="cake-eyebrow">Every gift is a little slice of joy</span>
        <div class="giving-total"><span><small>Raised together</small><strong>${totalText}</strong></span><span class="giving-percent">${m.completion}% <small>of goal</small></span></div>
      </div>
      <div class="cake-layout">
        <figure class="fund-cake">
          <div role="progressbar" aria-label="Celebration Fund progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, m.completion)}" aria-valuetext="${description}">
            <svg viewBox="0 0 320 270" aria-hidden="true" focusable="false">
              <ellipse cx="160" cy="253" rx="117" ry="9" fill="#293a31" opacity=".08"/>
              <path d="M149 226v19h22v-19" fill="#eee8d9" stroke="#cec4ad"/>
              <ellipse cx="160" cy="247" rx="59" ry="7" fill="#eee8d9" stroke="#cec4ad"/>
              <ellipse cx="160" cy="224" rx="124" ry="11" fill="#fffcf6" stroke="#cec4ad"/>
              <path d="M58 110V158A102 61.2 0 0 0 262 158V110" fill="none" stroke="#bcae98" stroke-width="1.2" stroke-dasharray="4 5" opacity=".65"/>
              ${m.total && remaining.amount ? `<path data-cake-cut="start" d="${cut(paths[0].start)}" fill="${paths[0].color}" stroke="#fffcf6" stroke-width="1"/><path data-cake-cut="end" d="${cut(paths.at(-1).end)}" fill="${paths.at(-1).color}" stroke="#fffcf6" stroke-width="1"/><path d="${cut(paths.at(-1).end)}" fill="#51362c" opacity=".18"/>` : ""}
              ${paths.map(row => {
                const face = side(row.start, row.end);
                return face ? `<g data-cake-side="${row.key}"><path d="${face}" fill="${row.color}" stroke="#fffcf6" stroke-width="1"/><path d="${face}" fill="#51362c" opacity=".18"/><path d="M${edgePoint(Math.max(0, row.start), 17)}A102 61.2 0 0 1 ${edgePoint(Math.min(Math.PI, row.end), 17)}M${edgePoint(Math.max(0, row.start), 33)}A102 61.2 0 0 1 ${edgePoint(Math.min(Math.PI, row.end), 33)}" fill="none" stroke="#fffcf6" stroke-width="3" opacity=".7"/></g>` : "";
              }).join("")}
              <g class="cake-top" transform="translate(0 26) scale(1 .6)">
                <circle cx="160" cy="140" r="102" fill="#fffcf6" stroke="#928a79" stroke-width="1.5" stroke-dasharray="4 5"/>
                ${paths.map(row => `<path data-source="${row.key}" d="${row.path}" fill="${row.color}" stroke="#fffcf6" stroke-width="2" stroke-linejoin="round"/>`).join("")}
                ${remaining.amount && m.total ? `<path d="${wedge(remaining.start, remaining.end)}" fill="#fffcf6" stroke="#928a79" stroke-width="1.5" stroke-dasharray="4 5"/>` : ""}
              </g>
              ${m.total ? Array.from({ length: 19 }, (_, i) => {
                const angle = i * Math.PI / 18;
                if (!paths.some(row => angle >= row.start && angle <= row.end)) return "";
                return `<circle cx="${(160 + 102 * Math.cos(angle)).toFixed(3)}" cy="${(110 + 61.2 * Math.sin(angle)).toFixed(3)}" r="3.8" fill="#fffcf6" stroke="#dfcba7" stroke-width=".6"/>`;
              }).join("") : ""}
              <g transform="translate(30 68)" fill="#f3c9c5" stroke="#b86f7b" stroke-width=".7"><ellipse cy="-8" rx="6" ry="10"/><ellipse cy="8" rx="6" ry="10"/><ellipse cx="-8" rx="10" ry="6"/><ellipse cx="8" rx="10" ry="6"/><circle r="4" fill="#d2ae66"/></g>
              <path d="M279 198c-21-13-15-26-5-21l5 5 5-5c10-5 16 8-5 21Z" fill="#b86f7b"/>
              <path d="M29 93q-5 18 10 27-1-20-10-27Zm270 118q-13-1-17 10 15 2 17-10Z" fill="#81a794"/>
              <g class="cake-bakery-decor">
                <ellipse cx="39" cy="247" rx="18" ry="4" fill="#7b5144" opacity=".08"/>
                <path d="M26 228C18 214 48 212 51 224 54 234 43 245 38 246 33 244 29 237 26 228Z" fill="#b85d65" stroke="#91444e" stroke-width="1"/>
                <path d="m36 219-8-7 11 3 6-7-1 10 9 2-12 3Z" fill="#6c8b68"/>
                <path d="m30 226 1 2m9-1 1 2m6-4 1 2m-11 7 1 2m5-3 1 2m-7 5 1 2" stroke="#f6d9a8" stroke-width="1.5" stroke-linecap="round"/>
                <g transform="translate(259 239) rotate(-18)" fill="none" stroke="#7b5144" stroke-width="3" stroke-linecap="round"><path d="M0 10C-9-6 10-12 13-2 16 6 6 12 3 7"/><path d="M15 15C7 2 27-3 28 6 29 13 20 17 18 12"/></g>
              </g>
            </svg>
          </div>
          <figcaption>${m.total >= m.goal ? "A full cake, made possible together." : m.total ? "Little by little, we make it whole." : "Ready for a little celebration."}</figcaption>
        </figure>
        <div class="cake-details">
          <dl class="cake-goal"><div><dt>Our goal</dt><dd>${goalText}</dd></div><div><dt>Remaining</dt><dd>${remainingText}</dd></div></dl>
          <p class="cake-legend-heading">Slices by source <span>(% of ${m.basis})</span></p>
          <ul class="cake-legend">${m.rows.map(row => `<li><span class="cake-key ${row.key === "remaining" ? "cake-key-empty" : ""}" style="--slice:${row.color}" aria-hidden="true"></span><span>${row.label}</span><strong>${esc(money(row.amount, currency, false))}</strong><span class="cake-share">${row.percent.toFixed(1)}%</span></li>`).join("")}</ul>
        </div>
      </div>
      ${m.over ? `<p class="cake-over">Together, ${esc(money(m.total - m.goal, currency, false))} beyond our goal. The full cake shows each source's share of the actual total.</p>` : ""}
      <p class="cake-note">Verified contributions, counted once. Refunded, disputed or held portions are excluded; withdrawals do not reduce raised.</p>
    </div>`;
  }
  root.WSCelebrationFund = { model, render, wedge, side };
})(globalThis);
