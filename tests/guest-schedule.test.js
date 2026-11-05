import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";
import "../tz.js";
import "../guest-schedule.js";

const S = globalThis.WSSchedule;
const day = "2026-12-12";
const wedding = {
  id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
  wedding_date: day, time_zone: "Africa/Nairobi", currency: "KES",
  venues: [
    { name: "Reception", event_time: "13:00" },
    { name: "Ceremony", event_time: "10:00", is_main: true },
    { name: "Welcome", event_date: "2026-12-11", event_time: "18:00", kind: "pre" }
  ]
};
const at = time => WSTime.zonedToUtc(day, time, wedding.time_zone);

test("before/exact start, next venue and midnight use wedding-local intervals without changing order", () => {
  const original = JSON.stringify(wedding);
  assert.deepEqual(S.states(wedding, at("09:59:59")), ["upcoming", "upcoming", "completed"]);
  assert.deepEqual(S.states(wedding, at("10:00")), ["upcoming", "current", "completed"]);
  assert.deepEqual(S.states(wedding, at("12:59:59")), ["upcoming", "current", "completed"]);
  assert.deepEqual(S.states(wedding, at("13:00")), ["current", "completed", "completed"]);
  assert.deepEqual(S.states(wedding, at("23:59:59")), ["current", "completed", "completed"]);
  assert.deepEqual(S.states(wedding, Date.parse("2026-12-12T21:00:00Z")), ["completed", "completed", "completed"]);
  assert.equal(JSON.stringify(wedding), original);
});

test("equal starts share the interval, even across the two rendered sections", () => {
  const w = { ...wedding, venues: [
    { event_time: "10:00" }, { event_time: "10:00", kind: "pre", event_date: day }, { event_time: "13:00" }
  ] };
  assert.deepEqual(S.states(w, at("10:00")), ["current", "current", "upcoming"]);
  assert.deepEqual(S.states(w, at("13:00")), ["completed", "completed", "current"]);
});

test("missing and invalid dates/times are not normalized or guessed", () => {
  const w = { ...wedding, wedding_date: null, venues: [
    {}, { event_time: "10:00" }, { event_date: "2026-02-30", event_time: "10:00" },
    { event_date: day }, { event_date: day, event_time: "25:00" },
    { event_date: day, event_time: "10:00junk" }, { event_date: "2026-12-11" }
  ] };
  assert.deepEqual(S.states(w, at("13:00")), ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "completed"]);
  assert.deepEqual(S.states({ ...wedding, venues: [{ kind: "pre", event_time: "10:00" }] }, at("13:00")), ["unknown"]);
  assert.deepEqual(S.states({ ...wedding, time_zone: "Invalid/Zone" }, at("13:00")), ["unknown", "unknown", "unknown"]);
  assert.equal(S.instant("2026-03-08", "02:30", "America/New_York"), null, "DST gaps are not guessed");
});

test("optional explicit ends take precedence; invalid ends cannot imply current activity", () => {
  const w = { ...wedding, venues: [
    { event_time: "10:00", event_end_time: "11:00" }, { event_time: "13:00", event_end_time: "14:00" }
  ] };
  assert.deepEqual(S.states(w, at("10:00")), ["current", "upcoming"]);
  assert.deepEqual(S.states(w, at("11:00")), ["completed", "upcoming"]);
  assert.deepEqual(S.states(w, at("14:00")), ["completed", "completed"]);
  for (const end of ["09:00", "25:00", "not a time"]) {
    assert.deepEqual(S.states({ ...w, venues: [{ event_time: "10:00", event_end_time: end }] }, at("13:00")), ["unknown"]);
  }
});

test("configured timezone controls the date boundary including DST and date-line zones", () => {
  const w = { wedding_date: day, time_zone: "Pacific/Kiritimati", venues: [{ event_time: "00:30" }] };
  assert.deepEqual(S.states(w, Date.parse("2026-12-11T10:29:59Z")), ["upcoming"]);
  assert.deepEqual(S.states(w, Date.parse("2026-12-11T10:30:00Z")), ["current"]);
  assert.deepEqual(S.states(w, Date.parse("2026-12-12T10:00:00Z")), ["completed"]);
  const dst = { wedding_date: "2026-11-01", time_zone: "America/New_York", venues: [{ event_time: "00:30" }] };
  const [entry] = S.timeline(dst);
  assert.equal(entry.boundary, Date.parse("2026-11-02T05:00:00Z"));
});

test("guest renderer refreshes on boundaries/resume and cleans timers/listeners; mobile stationery stays accessible", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const body = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", reducedMotion: "reduce", viewport: { width: 320, height: 800 } });
    await page.clock.install({ time: at("09:00") });
    await page.clock.pauseAt(at("09:59:59"));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/guest**", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(new URL(route.request().url()).searchParams.get("action") === "site" ? { wedding } : {})
    }));
    await page.route("**/api/checkout**", route => route.fulfill({ contentType: "application/json", body: "{}" }));
    await page.goto(`http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`);
    const rows = page.locator("#venues-display .sched-row");
    await rows.first().waitFor();
    assert.match(await rows.nth(1).textContent(), /Ceremony/);
    assert.equal(await page.locator(".schedule-current").count(), 0);
    assert.equal(await page.locator("#prewedding-display .schedule-status").textContent(), "Completed");
    await page.clock.runFor(1000);
    assert.equal(await rows.nth(1).getAttribute("aria-current"), "time");
    assert.equal(await rows.nth(1).locator(".schedule-status").textContent(), "Current in schedule");

    await page.clock.fastForward(3 * 3600000);
    assert.equal(await rows.first().getAttribute("aria-current"), "time");
    assert.equal(await rows.nth(1).locator(".schedule-status").textContent(), "Completed");
    const link = rows.first().locator("a");
    await link.focus();
    await page.clock.runFor(30000);
    assert.equal(await link.evaluate(el => el === document.activeElement), true, "refresh does not rebuild rows or lose focus");

    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}`);
    }
    const metrics = await rows.first().evaluate(row => {
      const badge = getComputedStyle(row.querySelector(".schedule-status"));
      const marker = getComputedStyle(row, "::before");
      const hex = color => "#" + color.match(/\d+/g).slice(0, 3).map(n => (+n).toString(16).padStart(2, "0")).join("");
      return {
        contrast: WSTheme.contrast(hex(badge.color), hex(badge.backgroundColor)),
        markerLeft: marker.left, markerTransform: marker.transform,
        animation: getComputedStyle(row).animationName, transition: getComputedStyle(row).transitionDuration
      };
    });
    assert.ok(metrics.contrast >= 4.5);
    assert.equal(metrics.markerLeft, "0px");
    assert.notEqual(metrics.markerTransform, "none", "diamond marker remains in its gutter");
    assert.equal(metrics.animation, "none");
    assert.equal(metrics.transition, "0s");

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.clock.setSystemTime(new Date("2026-12-12T21:00:00Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(await page.locator(".schedule-current").count(), 0, "tab resume recomputes local date");
    assert.equal(await rows.first().locator(".schedule-status").textContent(), "Completed");

    const cleanup = await page.evaluate(w => {
      const nativeSet = window.setTimeout, nativeClear = window.clearTimeout;
      const pending = new Set(), listeners = new Set();
      const hooks = [];
      window.setTimeout = (fn, delay) => { const id = nativeSet(fn, delay); pending.add(id); return id; };
      window.clearTimeout = id => { pending.delete(id); nativeClear(id); };
      for (const target of [window, document]) {
        const add = target.addEventListener, remove = target.removeEventListener;
        target.addEventListener = function (type, fn, ...args) { listeners.add(fn); return add.call(this, type, fn, ...args); };
        target.removeEventListener = function (type, fn, ...args) { listeners.delete(fn); return remove.call(this, type, fn, ...args); };
        hooks.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
      }
      const dispose = WSSchedule.mount(w);
      const active = pending.size;
      dispose();
      hooks.forEach(restore => restore());
      window.setTimeout = nativeSet; window.clearTimeout = nativeClear;
      return { active, timers: pending.size, listeners: listeners.size };
    }, wedding);
    assert.deepEqual(cleanup, { active: 1, timers: 0, listeners: 0 });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
