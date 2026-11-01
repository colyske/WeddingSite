import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" };
const weddings = [
  { slug: "forest-pair", couple_names: "Wanjiru & Otieno", wedding_date: "2099-05-02", public_location: "Nairobi", time_zone: "Africa/Nairobi", palette: ["#244b3a", "#be9b52", "#a9b5a2", "#f6f1e4"], is_past: false },
  { slug: "light-pair", couple_names: "Light Palette", wedding_date: "2099-06-02", public_location: "Mombasa", palette: ["#ffffff", "#ffff00"], is_past: false },
  { slug: "mixed-pair", couple_names: "Mixed Contrast", wedding_date: "2099-07-02", palette: ["#000000", "#ffffff"], is_past: false },
  { slug: "no-palette", couple_names: "<img src=x onerror=alert(1)>", wedding_date: null, palette: ["red", "javascript:x"], is_past: false },
  { slug: "past-pair", couple_names: "Past Couple", wedding_date: "2020-01-01", palette: ["#1d2440", "#e4cf9b"], is_past: true }
];

test("landing page is responsive, themed per wedding, accessible and honest", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://x").pathname;
      const file = path === "/" ? "index.html" : path.slice(1);
      if (file.includes("..")) throw new Error("bad path");
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }).end(await readFile(new URL(file, root)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), "GET");
      if (url.searchParams.get("action") === "browse") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ weddings }) });
      return route.fulfill({ contentType: "application/json", body: "{}" });
    });
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#weddings-grid .wedding-card");

    assert.equal(await page.locator("#weddings-grid .wedding-card").count(), 4);
    assert.equal(await page.locator("#past-grid .wedding-card").count(), 1);
    assert.equal(await page.locator("#weddings-grid img, #past-grid img").count(), 0, "names are escaped");
    const cards = await page.$$eval(".wedding-card", els => els.map(a => {
      const h = a.querySelector(".wedding-card-header");
      const s = getComputedStyle(h);
      const v = n => s.getPropertyValue(n).trim();
      const c1 = v("--c1"), c2 = v("--c2"), on = v("--on");
      const scrim = h.classList.contains("scrim");
      const min = Math.min(WSTheme.contrast(on, c1), WSTheme.contrast(on, c2));
      return { href: a.getAttribute("href"), source: a.dataset.paletteSource, bg: s.backgroundImage, c1, c2, on, scrim,
        textColor: getComputedStyle(h.querySelector("h3")).color, contrast: scrim ? WSTheme.contrast(on, "#e0e0e0") : min,
        motif: h.querySelector("use").getAttribute("href") };
    }));
    assert.equal(new Set(cards.map(c => c.bg)).size, cards.length, "each wedding card uses its own palette");
    assert.deepEqual(cards.map(c => c.source), ["wedding", "wedding", "wedding", "fallback", "wedding"]);
    assert.equal(cards[0].c1, "#244b3a", "saved palette is used unchanged");
    assert.ok(cards[2].scrim, "black-to-white gradient gets a readable scrim");
    for (const c of cards) {
      assert.ok(c.contrast >= 4.5, `card text contrast ${JSON.stringify(c)}`);
      assert.match(c.href, /guest\.html\?slug=|joinourwedding\.site/);
    }
    assert.ok(new Set(cards.map(c => c.motif)).size > 1, "motifs vary between weddings");

    const links = await page.$$eval("a", els => els.map(a => a.getAttribute("href")));
    assert.ok(links.filter(h => h === "/signin.html").length >= 3, "repeated create-site CTAs");
    assert.ok(links.includes("https://showcase-wedding.joinourwedding.site/"));
    assert.ok(links.includes("/terms.html"));
    await page.waitForSelector("footer a[href*='privacy']");
    const text = await page.locator("body").innerText();
    assert.doesNotMatch(text, /\d+(\.\d+)?\s?%|18 months|free allowance/i, "no exact fee figures in landing copy");
    assert.match(text, /fees apply/i);
    assert.match(await page.locator("#hero-title").innerText(), /budget/i, "hero leads with fundraising");
    assert.ok((await page.locator(".lp-fab h3").allTextContents()).slice(0, 4).every(t => /fundrais|gift|song|sponsor/i.test(t)), "money features lead");
    assert.doesNotMatch(text, /free forever|testimonial|\b\d[\d,]* (couples|users|weddings created)|in minutes|AI assistant|B2C|guaranteed (income|funding)|fully funded|automatic payout/i, "no invented claims");

    const faq = page.locator(".lp-faq summary").first();
    await faq.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".lp-faq details").first().getAttribute("open"), "");

    await page.setViewportSize({ width: 1280, height: 900 });
    for (const el of await page.$$(".lp-reveal")) await el.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll(".lp-reveal")].every(el => el.classList.contains("lp-in")));
    for (const width of [320, 375, 768, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const m = await page.evaluate(() => ({
        width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
        header: [...document.querySelectorAll(".site-header a")].filter(el => el.getClientRects().length).map(el => {
          const r = el.getBoundingClientRect(); return { text: el.textContent, left: r.left, right: r.right, h: r.height };
        }),
        smallTargets: [...document.querySelectorAll(".lp-ctas .btn, .lp-faq summary, #pagination button")]
          .filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 44).map(el => el.textContent)
      }));
      assert.ok(m.scroll <= m.width, `no horizontal overflow at ${width}: ${JSON.stringify(m)}`);
      for (const l of m.header) assert.ok(l.left >= 0 && l.right <= width, `${l.text} visible at ${width}`);
      assert.deepEqual(m.smallTargets, [], `tap targets at ${width}`);
      if (process.env.WEDDING_SCREENSHOTS) await page.screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `landing-${width}.png`), fullPage: true });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    for (const el of await page.$$(".lp-reveal")) await el.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll(".lp-reveal")].every(el => el.classList.contains("lp-in")));

    const reduced = await browser.newPage({ reducedMotion: "reduce" });
    await reduced.route("https://**", route => route.fulfill({ body: "" }));
    await reduced.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ weddings: [] }) }));
    await reduced.goto(base, { waitUntil: "domcontentloaded" });
    await reduced.waitForFunction(() => /No upcoming weddings/.test(document.getElementById("weddings-grid").textContent));
    assert.ok(await reduced.evaluate(() => [...document.querySelectorAll(".lp-reveal")].every(el => getComputedStyle(el).opacity === "1")));
    assert.equal(await reduced.evaluate(() => getComputedStyle(document.querySelector(".lp-float")).animationName), "none");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.close();
  }
});
