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
    assert.equal(await page.locator("#prewedding-display > *").count(), 5);
    assert.equal(await page.locator("#sponsor-enquiry-link").count(), 0);
    assert.equal(await page.locator(".sponsor-ad .sponsor-socials a").count(), 2);
    assert.match(await page.locator(".sponsor-ad").innerText(), /studio@example\.com/);
    assert.equal(await page.locator("#campaigns-display [data-preset], #leaderboard-body [data-amount]").count(), 0);
    assert.equal(await page.locator("#song-request-presets").count(), 0);
    assert.equal(await page.locator("#demo-contribution-amount").count(), 0, "the public wedding site has no organizer demo controls");
    assert.equal(await page.locator("#venues-display > *").count(), 2);
    assert.match(await page.locator("#ledger-body").innerText(), /Song bid[\s\S]*2,500[\s\S]*A friend/);
    assert.doesNotMatch(await page.locator("#ledger-body").innerText(), /NaN|\$/);
    assert.ok(await page.locator(".showcase-banner").isVisible());
    assert.equal(await page.locator(".showcase-banner").innerText(), "Demo");
    assert.doesNotMatch(await page.locator("#welcome-story").innerText(), /sample|fictional/i);
    assert.match(await page.locator("#welcome-story").innerText(), /borrowed watering can/);
    assert.equal(await page.locator("#wedding-content section.card").count(), await page.locator("section.card").count(),
      "every content band belongs to the main landmark");
    for (const id of ["welcome", "story", "details", "venues", "prewedding", "campaigns", "registry", "rsvp",
      "bids", "ledger", "sponsor-tiers", "vip-section", "sponsors", "seating", "share-section", "info-section", "guestbook", "ecard"]) {
      assert.equal(await page.locator(`#${id} > .celebration-art svg`).count(), 1, `${id} has a single bespoke illustration`);
    }
    assert.equal(await page.locator("#campaigns [role=progressbar]").getAttribute("aria-valuenow"), "36");
    assert.equal(await page.locator("#registry [role=progressbar]").getAttribute("aria-valuenow"), "30");
    assert.match(await page.locator("#registry [role=progressbar]").getAttribute("aria-valuetext"), /60,000.*200,000.*illustrative/);
    assert.match(await page.locator(".showcase-create").getAttribute("href"), /dashboard\.html\?style=showcase-wedding#step=couple$/);
    await page.locator("#reuse-wedding-style a").waitFor();
    assert.equal(await page.locator("#reuse-wedding-style a").getAttribute("href"), "/dashboard.html?style=showcase-wedding#step=couple");
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
      if (width > 640) assert.equal(new Set(metrics.songCells).size, 1, "desktop song title, artist and paid total align");
      else {
        assert.equal(metrics.songCells[0], metrics.songCells[2], "song title and paid total align on mobile");
        assert.ok(metrics.songCells[1] > metrics.songCells[0], "mobile artist has its own readable line");
      }
      assert.ok(new Set(metrics.surfaces).size >= 3, "sections are visually differentiated");
      if (width <= 768) {
        assert.ok(await page.locator(".sticky-nav").evaluate(nav => nav.getBoundingClientRect().height <= 90), "compact closed mobile header");
        const toggle = page.locator("#wedding-nav-toggle");
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-expanded"), "true");
        await page.keyboard.press("Escape");
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.ok(await toggle.evaluate(el => el === document.activeElement));
        await toggle.click();
        await page.locator('#wedding-nav-links a[href="#bids"]').click();
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(await page.evaluate(() => document.activeElement.id), "bids");
      }
      if (process.env.WEDDING_SCREENSHOTS) await page.screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `showcase-${width}.png`), fullPage: true });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".wedding-skip").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "wedding-content", "skip link transfers keyboard focus to main");
    assert.equal(await page.locator(".hero .celebration-art").evaluate(el => getComputedStyle(el).animationName), "none");
    await page.locator("#rsvp-form").scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    assert.ok(await page.locator(".showcase-create").isHidden(), "floating CTA never obscures the form");
    await page.locator(".ws-promo").scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    assert.ok(await page.locator(".showcase-create").isHidden(), "floating CTA never obscures the footer");
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
