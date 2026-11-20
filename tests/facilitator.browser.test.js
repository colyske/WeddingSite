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
  let ratePolicy = { enabled: true, rate_basis_points: 200 };
  let rateFailure = false;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/referrals*", route => rateFailure
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) })
      : route.fulfill({ contentType: "application/json", body: JSON.stringify(ratePolicy) }));
    await page.goto(`http://127.0.0.1:${server.address().port}/facilitator.html`);
    await page.locator("#facilitator-earnings").waitFor({ state: "visible" });
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(await page.locator(".facilitator-steps > li").count(), 5);
    assert.equal(await page.locator("a[href='/signin.html?next=%2Freferrals.html']").count(), 4);
    assert.ok(await page.locator("a[href='https://showcase-wedding.joinourwedding.site/']").count() >= 2);
    assert.equal(await page.locator(".facilitator-art svg[role=img]").count(), 1);
    const text = await page.locator("main").innerText();
    assert.match(text, /2%/);
    assert.match(text, /KES 10,000/);
    assert.match(text, /KES 40,000/);
    assert.match(text, /KES 120,000/);
    assert.match(text, /commission is sent to your M-Pesa once the wedding date has passed and the funds have cleared/i);
    assert.match(text, /register as a new user through your link and publish their first wedding/i);
    assert.doesNotMatch(text, /not a promise|eligible contributions|earnings are available in your dashboard|payouts are not available|in-app facilitator payout request|\b(?:manual(?:ly)?|automatic(?:ally)?)\b/i);
    await page.evaluate(() => {
      window.copiedMessages = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => window.copiedMessages.push(text)
      } });
    });
    await page.locator("#copy-consent").click();
    const copied = await page.evaluate(() => window.copiedMessages);
    assert.match(copied[0], /starting a draft is free/i);
    assert.match(copied[0], /platform fees are shown in the payment quote/i);
    assert.match(copied[0], /\[Paste your referral link\]/i);
    assert.match(await page.locator("#copy-status").innerText(), /copied/i);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("denied"); }
    } }));
    await page.locator("#copy-consent").click();
    assert.match(await page.locator("#copy-status").innerText(), /select and copy/i);
    await page.evaluate(() => {
      document.querySelector("#copy-status").textContent = "";
    });

    ratePolicy = { enabled: true, rate_basis_points: 100 };
    await page.reload();
    await page.locator("#facilitator-earnings").waitFor({ state: "visible" });
    const updatedText = await page.locator("main").innerText();
    assert.match(updatedText, /1%/);
    assert.match(updatedText, /KES 5,000/);
    assert.match(updatedText, /KES 20,000/);
    assert.match(updatedText, /KES 60,000/);

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

    ratePolicy = { enabled: false, rate_basis_points: null };
    await page.reload();
    await page.locator("#facilitator-rate-status").waitFor({ state: "visible" });
    assert.equal(await page.locator("#facilitator-earnings").isVisible(), false);
    assert.equal(await page.locator("#facilitator-reward").isVisible(), false);
    assert.equal(await page.locator("#facilitator-example-section").isVisible(), false);
    assert.equal(await page.locator("#facilitator-general-lead").isVisible(), true);
    assert.doesNotMatch(await page.locator("main").innerText(), /KES 5,000|KES 20,000|KES 60,000/);
    ratePolicy = { enabled: true, rate_basis_points: "200" };
    await page.reload();
    await page.locator("#facilitator-rate-status").waitFor({ state: "visible" });
    assert.equal(await page.locator("#facilitator-earnings").isVisible(), false);
    assert.doesNotMatch(await page.locator("main").innerText(), /KES 5,000|KES 20,000|KES 60,000/);

    assert.deepEqual(errors, []);
    ratePolicy = { enabled: true, rate_basis_points: 200 };
    rateFailure = true;
    await page.reload();
    await page.locator("#facilitator-rate-status").waitFor({ state: "visible" });
    assert.match(await page.locator("#facilitator-rate-status").innerText(), /rate is unavailable/i);
    assert.equal(await page.locator("#facilitator-earnings").isVisible(), false);
    assert.doesNotMatch(await page.locator("main").innerText(), /KES 10,000|KES 40,000|KES 120,000/);
    await page.locator(".facilitator-final-cta a").click();
    assert.equal(new URL(page.url()).pathname, "/signin.html");
    assert.equal(new URL(page.url()).searchParams.get("next"), "/referrals.html");
  } finally {
    await browser?.close();
    server.close();
  }
});
