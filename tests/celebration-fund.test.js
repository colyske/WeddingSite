import test from "node:test";
import assert from "node:assert/strict";
import "../celebration-fund.js";
import { showcaseFundraising, showcase, showcaseBids } from "../server/showcase.js";

const { model, render, wedge, cut } = globalThis.WSCelebrationFund;
const fixture = (amounts, goal = 10000) => ({
  currency: "KES", goal_minor: goal, raised_minor: amounts.reduce((a, b) => a + b, 0),
  remaining_minor: Math.max(0, goal - amounts.reduce((a, b) => a + b, 0)),
  sources: ["gifts", "songs", "registry", "sponsors", "vip"].map((key, i) => ({ key, amount_minor: amounts[i] }))
});
const money = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;

test("source amounts, true angles and displayed legend reconcile to goal", () => {
  for (const data of [fixture([2500, 1000, 500, 300, 200]), fixture([1, 1, 1, 1, 1], 7), fixture([99, 1, 0, 0, 0])]) {
    const m = model(data, "KES");
    const remaining = m.rows.at(-1);
    assert.ok(Math.abs((remaining.start + remaining.end) / 2 - Math.PI / 2) < 1e-12, "opening is centered toward the viewer");
    assert.equal(m.rows.reduce((a, b) => a + b.amount, 0), m.goal);
    assert.equal(m.rows.reduce((a, b) => a + Math.round(b.percent * 10), 0), 1000);
    assert.ok(Math.abs(m.rows.reduce((a, b) => a + b.share, 0) - 1) < 1e-12);
    for (const row of m.rows) assert.ok(Math.abs(row.end - row.start - row.amount / m.goal * 2 * Math.PI) < 1e-12);
  }
});

test("zero is a fully empty outline; exact and over goal use actual shares without clipping totals", () => {
  const zero = fixture([0, 0, 0, 0, 0]);
  assert.equal(model(zero, "KES").rows.at(-1).percent, 100);
  assert.doesNotMatch(render(zero, "KES", money), /data-source=/);
  assert.match(render(zero, "KES", money), /Ready for a little celebration/);
  for (const goal of [10000, 5000]) {
    const data = fixture([10000, 0, 0, 0, 0], goal);
    const m = model(data, "KES");
    assert.equal(m.rows[0].share, 1);
    assert.equal(m.rows.at(-1).amount, 0);
    assert.equal(m.completion, goal === 5000 ? 200 : 100);
    const html = render(data, "KES", money);
    assert.match(html, /aria-valuenow="100"/);
    assert.match(html, /KES 100.00/);
    assert.equal((wedge(m.rows[0].start, m.rows[0].end).match(/A102 102/g) || []).length, 2);
    if (goal === 5000) {
      assert.equal(m.basis, "raised");
      assert.match(html, /200.*% of goal/);
      assert.match(html, /KES 50.00 beyond our goal/);
    }
  }
  assert.equal(render(fixture([0, 0, 0, 0, 0], 0), "KES", money), "");
});

test("reject mixed currencies, malformed aggregates and overlapping or missing source amounts", () => {
  const valid = fixture([1, 2, 3, 4, 5]);
  assert.throws(() => model(valid, "USD"), /unavailable/);
  for (const change of [
    { raised_minor: 14 }, { remaining_minor: 0 }, { goal_minor: -1 }, { raised_minor: Infinity },
    { sources: valid.sources.slice(1) },
    { sources: valid.sources.map(row => ({ ...row, key: "gifts" })) },
    { sources: valid.sources.map(row => ({ ...row, amount_minor: -1 })) }
  ]) assert.throws(() => model({ ...valid, ...change }, "KES"));
});

test("accessible text carries totals, remaining, sources and unclipped completion without color alone", () => {
  const html = render(fixture([10, 20, 30, 40, 50], 100), "KES", money, true);
  assert.match(html, /role="progressbar".*aria-valuetext="150% of goal. Raised KES 1.50 toward KES 1.00. Remaining KES 0.00. Illustrative sample."/);
  assert.match(html, /svg viewBox="0 0 320 270" aria-hidden="true"/);
  assert.match(html, /class="cake-top" transform="translate\(0 26\) scale\(1 .6\)"/);
  assert.equal((html.match(/data-source=/g) || []).length, 5, "each honest circular sector is projected once, never extruded separately");
  for (const label of ["Gifts & fundraisers", "Song bids", "Registry gifts", "Sponsorship", "VIP", "Remaining"]) {
    assert.ok(html.includes(label));
  }
  assert.doesNotMatch(html, /<animate|animation:|<canvas|webgl/i);
  assert.doesNotMatch(render(fixture([1, 0, 0, 0, 0]), "KES", () => "<img onerror=alert(1)>"), /<img/);
});

test("full-depth internal cut faces follow true radial boundaries; outer frosting stays complete", () => {
  assert.equal(cut(0), "M160 110L262.00000 110.00000L262.00000 158.00000L160 158Z");
  const partial = render(fixture([2000, 1000, 1000, 500, 500]), "KES", money);
  assert.match(partial, /data-cake-shell="cream"/);
  assert.match(partial, /data-cake-cut="end"/);
  const rows = model(fixture([2000, 1000, 1000, 500, 500]), "KES").rows;
  assert.ok(partial.includes(`data-cake-cut="start" d="${cut(rows[0].start)}"`));
  assert.ok(partial.includes(`data-cake-cut="end" d="${cut(rows[4].end)}"`));
  assert.doesNotMatch(partial, /<path (?:data-source|data-cake-cut)="[^"]+"[^>]*stroke=/, "wedge colours meet without white separator strokes");
  assert.doesNotMatch(partial, /data-cake-side=/, "outer wall is never source-coloured or removed");
  const zero = render(fixture([0, 0, 0, 0, 0]), "KES", money);
  assert.doesNotMatch(zero, /data-cake-side|data-cake-cut/);
  const full = render(fixture([4000, 1000, 3000, 1000, 1000]), "KES", money);
  assert.match(full, /data-cake-shell="cream"/);
  assert.doesNotMatch(full, /data-cake-cut=/);
});

test("read-only showcase source totals match campaign, registry, song bids, sponsorship and VIP", () => {
  const data = showcaseFundraising.celebration;
  assert.equal(model(data, showcase.currency).total, showcaseFundraising.campaigns[0].raised_minor);
  const sources = Object.fromEntries(data.sources.map(row => [row.key, row.amount_minor]));
  assert.equal(sources.registry, showcase.registry.reduce((n, item) => n + item.amount_raised_minor, 0));
  assert.equal(sources.songs, showcaseBids.reduce((n, row) => n + row.bid_amount_minor, 0));
  assert.equal(sources.sponsors, showcaseFundraising.sponsors.reduce((n, row) => n + row.amount_minor, 0));
  assert.equal(sources.vip, showcaseFundraising.vip.seats_sold * showcaseFundraising.vip.price_minor);
  assert.ok(data.campaign_raised_minor <= sources.gifts);
  for (const milestone of showcaseFundraising.campaigns[0].milestones) {
    assert.equal(milestone.reached, data.campaign_raised_minor >= milestone.target_minor);
  }
});
