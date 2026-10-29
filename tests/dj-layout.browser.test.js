import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

test("DJ song list precedes the request form, fits 320/375px and highlights a paid song", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const data = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
      wedding_date: "2099-01-01", currency: "KES", published_at: "2026-01-01",
      palette: ["#ffffff", "#ffff00", "#00ffff"], attire_notes: "Traditional or casual; feel comfortable.",
      venues: [{ name: "Ceremony", event_date: "2099-01-01", event_time: "10:00", is_main: true }] };
    const bids = [{ song_title: "A Very Long Song Title That Should Wrap Neatly Without Overflow", artist_name: "Artist With A Long Name", bid_amount_minor: 150000, bid_count: 3 }];
    await page.route("https://challenges.cloudflare.com/**", route => route.fulfill({ contentType: "text/javascript", body: "window.turnstile={render(){return 1},reset(){}}" }));
    await page.route("**/api/guest**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(action === "site" ? { wedding } : action === "leaderboard" ? { bids } : {}) });
    });
    await page.route("**/api/checkout**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      const data = action === "status" ? { paymentStatus: "paid", actionStatus: "completed", action: "song_bid" }
        : { providers: [{ id: "daraja", name: "Daraja Sandbox", market: "KE", label: "M-Pesa" }], paymentAvailable: true, turnstileSiteKey: "t" };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const pid = "550e8400-e29b-41d4-a716-446655440002";
    await page.addInitScript(([id, title, artist]) => {
      if (location.search.includes("paymentReturn")) sessionStorage.setItem(`ws-payment:${id}`, JSON.stringify({ action: "song_bid", provider: "daraja", songTitle: title, artist }));
    }, [pid, "  a very long song title that should wrap neatly without overflow ", "artist with a long name"]);
    const base = `http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`;
    await page.goto(base);
    await page.locator("#leaderboard-body tr").first().waitFor();

    for (const width of [320, 375, 768, 820, 1024, 1280]) {
      await page.setViewportSize({ width, height: 700 });
      const metrics = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        navH: document.querySelector("nav.sticky-nav").getBoundingClientRect().height,
        listTop: document.getElementById("leaderboard-table").getBoundingClientRect().top + scrollY,
        formTop: document.getElementById("song-request-form").getBoundingClientRect().top + scrollY,
        navLinks: [...document.querySelectorAll(".sticky-nav .nav-links a")].map(a => { const r = a.getBoundingClientRect(); return { l:r.left, r:r.right }; }),
        buttons: [...document.querySelectorAll("#leaderboard-body summary")].map(b => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; })
      }));
      assert.ok(metrics.scrollW <= metrics.clientW, `no horizontal page overflow at ${width}px`);
      assert.ok(metrics.navH < 125, `compact nav at ${width}px (${metrics.navH})`);
      assert.ok(metrics.listTop < metrics.formTop, "song list comes before the request form");
      for (const b of metrics.buttons) {
        assert.ok(b.l >= 0 && b.r <= width, "bid buttons stay inside the viewport");
        assert.ok(b.h >= 36, "bid buttons remain tappable");
      }
      for (const link of metrics.navLinks) assert.ok(link.l >= 0 && link.r <= width, `all nav links visible at ${width}`);
      assert.equal(await page.locator("#leaderboard-body [data-song-bid]").first().isVisible(), false);
      await page.locator("#leaderboard-body summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("#leaderboard-body [data-song-bid]").first().isVisible(), true);
      const amountsFit = await page.locator("#leaderboard-body .song-bid-amounts").evaluate(el => el.scrollWidth <= el.clientWidth);
      assert.ok(amountsFit);
      const expandedControls = await page.locator("#leaderboard-body summary, #leaderboard-body button").evaluateAll(els =>
        els.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; }));
      assert.ok(expandedControls.every(r => r.left >= 0 && r.right <= r.width), `expanded controls fit at ${width}: ${JSON.stringify(expandedControls)}`);
      if (process.env.WEDDING_SCREENSHOTS && [320, 375, 1280].includes(width)) {
        await page.locator("#bids").screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `refinement-bids-open-${width}.png`) });
      }
      await page.keyboard.press("Space");
      if (process.env.WEDDING_SCREENSHOTS && [320, 375, 1280].includes(width)) {
        await page.screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `refinement-guest-${width}.png`), fullPage: true });
      }
    }
    assert.equal(await page.locator("#palette-preview figure").count(), 3);
    assert.equal(await page.locator("#attire-palette-preview").count(), 0, "one shared palette, no duplicate attire section");
    assert.match(await page.locator("#attire-notes-display").textContent(), /Traditional or casual/);
    const ratios = await page.evaluate(() => ["--green", "--gold", "--sage"].map(name =>
      WSTheme.contrast(getComputedStyle(document.documentElement).getPropertyValue(name).trim(), "#ebe7da")));
    assert.ok(ratios.every(ratio => ratio >= 4.5), "light custom palettes still produce readable UI ink");
    const venueContrast = await page.locator("#venues").evaluate(section => {
      const rgbHex = color => "#" + color.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, "0")).join("");
      return [...section.querySelectorAll("small, .sec-label span")].map(el =>
        WSTheme.contrast(rgbHex(getComputedStyle(el).color), getComputedStyle(document.documentElement).getPropertyValue("--green").trim()));
    });
    assert.ok(venueContrast.length && venueContrast.every(ratio => ratio >= 4.5), "venue labels remain readable on dark custom surfaces");

    await page.goto(`${base}&paymentReturn=${pid}`);
    await page.waitForFunction(() => document.querySelector("#leaderboard-body tr.song-highlight"));
    assert.equal(await page.locator("#pay-dialog").evaluate(d => d.open), false);
  } finally {
    await browser?.close();
    server.close();
  }
});
