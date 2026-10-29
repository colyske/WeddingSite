import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

test("publication UI retains Turnstile, handles unresolved returns and never publishes on a return URL", async () => {
  const weddingId = "550e8400-e29b-41d4-a716-446655440000";
  const paymentId = "550e8400-e29b-41d4-a716-446655440001";
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/wedding.html") {
        return res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="stylesheet" href="/app-shell.css"><link rel="stylesheet" href="/editorial.css">
          <button id="pay-fee-btn">Pay publication fee (test mode)</button><script src="/publication-checkout.js"></script>`);
      }
      if (!["/publication-checkout.js", "/app-shell.css", "/editorial.css"].includes(path)) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/css" }).end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    await page.route("https://**", route => { throw new Error("No external challenge or provider calls are allowed in this fixture."); });
    await page.addInitScript(({ paymentId }) => {
      window.statusValue = "pending";
      window.created = 0;
      window.verified = 0;
      window.reads = 0;
      window.turnstile = { render(el, opts) { window.challengeOptions = opts; return 1; }, remove() {} };
      document.addEventListener("ws:publication-verified", () => window.verified++);
      const checkout = () => ({ id: paymentId, status: window.statusValue, amountMinor: 5000, currency: "KES", testMode: true });
      window.WS = {
        money: (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`,
        api: async (url, init) => {
          const action = new URL(url, location.origin).searchParams.get("action");
          let data;
          if (action === "publication-options") data = {
            quote: { fee_minor: 649162, usd_amount_minor: 5000, currency: "KES", reason: "Far-future fee applies." },
            methods: [{ id: "card", label: "Card", quote: { fee_minor: 649162, usd_amount_minor: 5000, currency: "KES" } },
              { id: "mpesa", label: "M-Pesa", quote: { fee_minor: 649200, usd_amount_minor: 5000, currency: "KES",
                fx_rate: 129.832372, fx_published_at: "2026-10-29T00:02:31Z", payment_unit_minor: 100 } }], turnstileSiteKey: "fixture-site"
          };
          else if (action === "publication-create") {
            const body = JSON.parse(init.body);
            if (body.captchaToken !== "human-fixture" || body.expectedAmountMinor !== 649200 || body.expectedUsdAmountMinor !== 5000) throw new Error("Missing challenge or quote");
            window.created++;
            data = { checkout: checkout() };
          } else if (action === "publication-status") { window.reads++; data = { checkout: checkout() }; }
          else throw new Error("Unexpected action: " + action);
          return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
        }
      };
    }, { paymentId });
    const base = `http://127.0.0.1:${server.address().port}/wedding.html?id=${weddingId}`;
    await page.clock.install();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator("#pay-fee-btn").click();
    await page.waitForFunction(() => window.challengeOptions);
    assert.ok(await page.locator("#publication-submit").isDisabled(), "cannot pay before human challenge");
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.locator("#publication-dialog").evaluate(el => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth;
      }), `dialog fits ${width}`);
    }
    await page.locator("#publication-method").selectOption("mpesa");
    assert.match(await page.locator("#publication-quote").innerText(), /6492\.00/);
    assert.match(await page.locator("#publication-usd").innerText(), /USD 50\.00/);
    assert.match(await page.locator("#publication-fx").innerText(), /whole KES for M-Pesa/);
    await page.locator("#publication-phone").fill("254700000001");
    await page.evaluate(() => window.challengeOptions.callback("human-fixture"));
    await page.locator("#publication-submit").click();
    assert.equal(await page.evaluate(() => window.created), 1);
    assert.ok(await page.locator("#publication-submit").isDisabled());
    await page.waitForFunction(() => window.reads >= 1 && !document.getElementById("publication-check").disabled);
    for (let expected = 2; expected <= 7; expected++) {
      await page.clock.runFor(21000);
      await page.waitForFunction(count => window.reads >= count && !document.getElementById("publication-check").disabled, expected);
    }
    await page.waitForFunction(() => document.getElementById("publication-status").textContent.includes("timed out"));
    const stoppedAt = await page.evaluate(() => window.reads);
    await page.clock.runFor(60000);
    assert.equal(await page.evaluate(() => window.reads), stoppedAt, "polling stays bounded after timeout");
    assert.equal(await page.evaluate(() => window.created), 1);
    assert.equal(await page.evaluate(() => window.verified), 0);
    await page.locator("#publication-close").click();
    await page.goto(`${base}&publicationReturn=${paymentId}`, { waitUntil: "domcontentloaded" });
    await page.locator("#publication-check").waitFor();
    assert.equal(await page.evaluate(() => window.verified), 0, "a return URL is not paid evidence");
    await page.evaluate(() => { window.statusValue = "paid"; });
    await page.locator("#publication-check").click();
    await page.waitForFunction(() => window.verified === 1);
    assert.match(await page.locator("#publication-status").innerText(), /verified in test mode/);
    assert.match(await page.locator("#publication-status").innerText(), /confirm publishing/);
    assert.equal(await page.evaluate(() => window.created), 0, "return never creates another checkout");
  } finally { await browser?.close(); server.close(); }
});
