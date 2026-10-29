import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import guest from "../api/guest.js";
import checkout from "../api/checkout.js";

test("showcase is complete, read-only and compact at 320/375/768/1280px", async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    req.query = Object.fromEntries(url.searchParams);
    req.body = {};
    res.status = code => { res.statusCode = code; return res; };
    try {
      if (url.pathname === "/api/guest") return await guest(req, res);
      if (url.pathname === "/api/checkout") return await checkout(req, res);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const data = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => assert.equal(req.method(), "GET", "Showcase review never submits payments, emails or forms"));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/guest.html?slug=showcase-wedding`, { waitUntil: "domcontentloaded" });
    await page.locator("#leaderboard-body tr").first().waitFor();
    await page.locator("#ledger-body tr").first().waitFor();
    await page.locator(".field-row").first().waitFor();
    await page.locator("#guestbook").waitFor();
    assert.equal(await page.locator("#prewedding-display > *").count(), 2);
    assert.equal(await page.locator("#venues-display > *").count(), 2);
    assert.match(await page.locator("#ledger-body").innerText(), /Song bid[\s\S]*2,500[\s\S]*Sample Guest A/);
    assert.doesNotMatch(await page.locator("#ledger-body").innerText(), /NaN|\$/);
    assert.ok(await page.locator(".showcase-banner").isVisible());
    assert.ok(await page.locator("#pay-submit").isDisabled());
    const contrast = await page.evaluate(() => {
      function luminance(rgb) {
        return rgb.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; })
          .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      }
      function ratio(selector, background) {
        const foreground = getComputedStyle(document.querySelector(selector)).color.match(/\d+/g).slice(0, 3).map(Number);
        const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (hi + .05) / (lo + .05);
      }
      return {
        time: ratio("#prewedding .sched-time", [252, 251, 248]),
        text: ratio("#prewedding .sched-body p", [252, 251, 248]),
        date: ratio("#prewedding .sched-date", [252, 251, 248]),
        advert: ratio(".sponsor-sample .fine", [73, 104, 79])
      };
    });
    for (const [label, value] of Object.entries(contrast)) assert.ok(value >= 4.5, `${label} contrast ${value}`);
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const metrics = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        palette: [...document.querySelectorAll("#palette-preview > *")].map(el => el.getBoundingClientRect().top),
        paletteCaptionsFit: [...document.querySelectorAll("#palette-preview figure")].every(figure => {
          const caption = figure.querySelector("figcaption");
          return caption.getBoundingClientRect().width <= figure.getBoundingClientRect().width &&
            caption.scrollWidth <= caption.clientWidth;
        }),
        field: [...document.querySelectorAll("#rsvp-form .field-row")].map(row => {
          const [label, input] = row.children; return label.getBoundingClientRect().right <= input.getBoundingClientRect().left;
        }),
        songFields: [...document.querySelectorAll(".song-request-fields > label")].map(row => {
          const caption = row.firstElementChild, input = row.querySelector("input");
          return caption.getBoundingClientRect().right <= input.getBoundingClientRect().left &&
            input.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1;
        }),
        songCells: [...document.querySelectorAll("#leaderboard-body tr:first-child :is(.lb-song, .lb-artist, .lb-total)")]
          .map(cell => Math.round(cell.getBoundingClientRect().top)),
        surfaces: ["details", "story", "rsvp", "bids"].map(id => getComputedStyle(document.getElementById(id)).backgroundColor)
      }));
      assert.ok(metrics.scroll <= width, JSON.stringify({ width, ...metrics }));
      assert.equal(metrics.palette.length, 4);
      assert.equal(new Set(metrics.palette.map(Math.round)).size, 1, "all four swatches align in one row");
      assert.ok(metrics.paletteCaptionsFit, "palette captions cannot overlap neighbouring colours");
      assert.ok(metrics.field.every(Boolean), "labels beside fields");
      assert.equal(metrics.songFields.length, 3);
      assert.ok(metrics.songFields.every(Boolean), "song request labels remain beside their inputs");
      assert.equal(new Set(metrics.songCells).size, 1, "song title, artist and paid total share one row");
      assert.ok(new Set(metrics.surfaces).size >= 3, "sections are visually differentiated");
      if (process.env.WEDDING_SCREENSHOTS) await page.screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `showcase-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    // Exercise local input validation without enabling or submitting sample actions.
    const message = await page.locator("#song-request-title").evaluate(el => {
      el.disabled = false;
      el.value = "call +254700000001";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return el.validationMessage;
    });
    assert.match(message, /designated contact fields/);
  } finally {
    await browser?.close();
    server.close();
  }
});
