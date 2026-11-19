import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png" };

test("facilitator guide is responsive and its links and copy buttons work", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
      if (path.includes("..")) throw new Error("Invalid path");
      res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(await readFile(new URL(path, root)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.goto(`http://127.0.0.1:${server.address().port}/facilitator.html`);
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.locator(".facilitator-steps > li").count(), 5);
    assert.equal(await page.locator("a[href='/signin.html?next=%2Freferrals.html']").count(), 4);
    assert.ok(await page.locator("a[href='https://showcase-wedding.joinourwedding.site/']").count() >= 2);
    assert.equal(await page.locator(".facilitator-art svg[role=img]").count(), 1);
    const text = await page.locator("main").innerText();
    assert.match(text, /2%/);
    assert.match(text, /paid manually after eligible funds clear/i);
    assert.match(text, /no in-app facilitator payout request or withdrawal/i);
    assert.match(text, /not guaranteed income or expected results/i);
    assert.doesNotMatch(text, /4-8%|92-96%|earnings are available in your dashboard/i);
    assert.equal(await page.locator("a[href^='https://wa.me/254724812413']").count(), 2);
    await page.evaluate(() => {
      window.copiedMessages = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => window.copiedMessages.push(text)
      } });
    });
    await page.locator("#copy-consent").click();
    await page.locator("#copy-referral").click();
    const copied = await page.evaluate(() => window.copiedMessages);
    assert.match(copied[0], /draft is free/i);
    assert.match(copied[0], /exact quotes together/i);
    assert.match(copied[1], /\[your referral link\]/);
    assert.match(await page.locator("#copy-status").innerText(), /copied/i);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("denied"); }
    } }));
    await page.locator("#copy-consent").click();
    assert.match(await page.locator("#copy-status").innerText(), /select and copy/i);
    await page.evaluate(() => {
      document.querySelector("#copy-status").textContent = "";
      document.querySelector("#referral-copy-status").textContent = "";
    });

    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll(".facilitator-actions .facilitator-button, .facilitator-copy-button")]
          .map(el => el.getBoundingClientRect().height)
      }));
      assert.ok(dimensions.content <= dimensions.viewport, `horizontal overflow at ${width}`);
      assert.ok(dimensions.targets.every(height => height >= 44), `small tap target at ${width}`);
      if (process.env.WEDDING_SCREENSHOTS) await page.screenshot({ path: join(process.env.WEDDING_SCREENSHOTS, `facilitator-${width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    await page.locator(".facilitator-final-cta a").click();
    assert.equal(new URL(page.url()).pathname, "/signin.html");
    assert.equal(new URL(page.url()).searchParams.get("next"), "/referrals.html");
  } finally {
    await browser?.close();
    server.close();
  }
});
