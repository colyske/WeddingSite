/* The public aggregate is the only input; never add overlapping UI totals. */
(function (root) {
  "use strict";
  const sources = [
    { key: "gifts", label: "Gifts & fundraisers", color: "#b86f7b" },
    { key: "songs", label: "Song bids", color: "#9184b3" },
    { key: "registry", label: "Registry gifts", color: "#81a794" },
    { key: "sponsors", label: "Sponsorship", color: "#d2ae66" },
    { key: "vip", label: "VIP", color: "#82a6bc" }
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
        <div class="giving-total"><span><small>Raised together</small><strong>${totalText}</strong></span><span class="giving-percent">${m.completion}<small>% of goal</small></span></div>
      </div>
      <div class="cake-layout">
        <figure class="fund-cake">
          <div role="progressbar" aria-label="Celebration Fund progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, m.completion)}" aria-valuetext="${description}">
            <svg viewBox="0 0 320 290" aria-hidden="true" focusable="false">
              <ellipse cx="160" cy="266" rx="125" ry="12" fill="#293a31" opacity=".09"/>
              <ellipse cx="160" cy="260" rx="129" ry="10" fill="#eee8d9" stroke="#cec4ad"/>
              ${[18, 12, 6].map((depth, i) => paths.map(row => `<path d="${row.path}" transform="translate(0 ${depth})" fill="${row.color}" stroke="#fffcf6" stroke-width="1"/><path d="${row.path}" transform="translate(0 ${depth})" fill="${i === 1 ? "#fffcf6" : "#513f39"}" opacity="${i === 1 ? ".32" : ".17"}"/>`).join("")).join("")}
              <circle cx="160" cy="140" r="102" fill="#fffcf6" stroke="#928a79" stroke-width="1.5" stroke-dasharray="4 5"/>
              ${paths.map(row => `<path data-source="${row.key}" d="${row.path}" fill="${row.color}" stroke="#fffcf6" stroke-width="2" stroke-linejoin="round"/>`).join("")}
              ${remaining.amount && m.total ? `<path d="${wedge(remaining.start, remaining.end)}" fill="#fffcf6" stroke="#928a79" stroke-width="1.5" stroke-dasharray="4 5"/>` : ""}
              <g transform="translate(30 45)" fill="#f3c9c5" stroke="#b86f7b" stroke-width=".7"><ellipse cy="-8" rx="6" ry="10"/><ellipse cy="8" rx="6" ry="10"/><ellipse cx="-8" rx="10" ry="6"/><ellipse cx="8" rx="10" ry="6"/><circle r="4" fill="#d2ae66"/></g>
              <path d="M279 232c-21-13-15-26-5-21l5 5 5-5c10-5 16 8-5 21Z" fill="#b86f7b"/>
              <path d="M29 70q-5 18 10 27-1-20-10-27Zm246 176q-13-1-17 10 15 2 17-10Z" fill="#81a794"/>
            </svg>
          </div>
          <figcaption>${m.total >= m.goal ? "A full cake, made possible together." : m.total ? "Little by little, we make it whole." : "The first slice starts with you."}</figcaption>
        </figure>
        <div class="cake-details">
          <dl class="cake-goal"><div><dt>Our goal</dt><dd>${goalText}</dd></div><div><dt>Remaining</dt><dd>${remainingText}</dd></div></dl>
          <p class="cake-legend-heading">Slices by source <span>(% of ${m.basis})</span></p>
          <ul class="cake-legend">${m.rows.map(row => `<li><span class="cake-key ${row.key === "remaining" ? "cake-key-empty" : ""}" style="--slice:${row.color}" aria-hidden="true"></span><span>${row.label}</span><strong>${esc(money(row.amount, currency, false))}</strong><span class="cake-share">${row.percent.toFixed(1)}%</span></li>`).join("")}</ul>
        </div>
      </div>
      ${m.over ? `<p class="cake-over">Together, ${esc(money(m.total - m.goal, currency, false))} beyond our goal. The full cake shows each source's share of the actual total.</p>` : ""}
      <p class="cake-note">Verified contributions across this celebration, counted once. Refunded, disputed or held portions are excluded; withdrawals do not reduce raised.${sample ? " Illustrative sample." : ""}</p>
    </div>`;
  }
  root.WSCelebrationFund = { model, render, wedge };
})(globalThis);
