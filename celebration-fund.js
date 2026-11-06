/* The public aggregate is the only input; never add overlapping UI totals. */
(function (root) {
  "use strict";
  const sources = [
    { key: "gifts", label: "Gifts & fundraisers", color: "#d9849c" },
    { key: "songs", label: "Song bids", color: "#704638" },
    { key: "registry", label: "Registry gifts", color: "#e7c56e" },
    { key: "sponsors", label: "Sponsorship", color: "#90ad72" },
    { key: "vip", label: "VIP", color: "#9c87bd" }
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
    rows.push({ key: "remaining", label: "Remaining", color: "#e4e6d9", amount: data.remaining_minor });
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
    rows.forEach((row, i) => {
      row.share = denominator ? row.amount / denominator : 0;
      row.percent = rounded[i] / 10;
    });
    return {
      rows, total, goal: data.goal_minor, remaining: data.remaining_minor,
      completion: data.goal_minor ? Math.round(total / data.goal_minor * 1000) / 10 : 0,
      over: total > data.goal_minor, basis: total > data.goal_minor ? "raised" : "goal"
    };
  }
  function render(data, currency, money, sample = false) {
    const m = model(data, currency);
    if (!m.goal) return "";
    const totalText = esc(money(m.total, currency, false));
    const goalText = esc(money(m.goal, currency, false));
    const remainingText = esc(money(m.remaining, currency, false));
    const description = `${m.completion}% of goal. Raised ${totalText} toward ${goalText}. Remaining ${remainingText}.${sample ? " Illustrative sample." : ""}`;
    return `<div class="celebration-fund giving-progress">
      <div class="fund-heading">
        <div class="giving-total"><span><small>Raised together</small><strong>${totalText}</strong></span><span class="giving-percent">${m.completion}% <small>of goal</small></span></div>
      </div>
      <div class="camp-bar fund-bar" role="progressbar" aria-label="Celebration Fund progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, m.completion)}" aria-valuetext="${description}">
        ${m.rows.filter(row => row.amount > 0).map(row => `<span data-source="${row.key}" style="width:${row.share * 100}%;background:${row.color}" aria-hidden="true"></span>`).join("")}
      </div>
      <dl class="fund-goal"><div><dt>Our goal</dt><dd>${goalText}</dd></div><div><dt>Remaining</dt><dd>${remainingText}</dd></div></dl>
      <p class="fund-legend-heading">Contributions by source <span>(% of ${m.basis})</span></p>
      <ul class="fund-legend">${m.rows.map(row => `<li><span class="fund-key ${row.key === "remaining" ? "fund-key-empty" : ""}" style="--slice:${row.color}" aria-hidden="true"></span><span>${row.label}</span><strong>${esc(money(row.amount, currency, false))}</strong><span class="fund-share">${row.percent.toFixed(1)}%</span></li>`).join("")}</ul>
      ${m.over ? `<p class="fund-over">Together, ${esc(money(m.total - m.goal, currency, false))} beyond our goal. The full bar shows each source's share of the actual total.</p>` : ""}
      <p class="fund-note">${sample ? "Illustrative sample figures only; no real contributions or payments are represented." : "Verified contributions, counted once. Refunded, disputed or held portions are excluded; withdrawals do not reduce raised."}</p>
    </div>`;
  }
  root.WSCelebrationFund = { model, render };
})(globalThis);
