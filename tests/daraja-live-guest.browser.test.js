import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("live Daraja: uncertain 503 retains the payment, never starts a second prompt, and survives reload", async () => {
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
      wedding_date: "2099-01-01", currency: "KES", published_at: "2026-01-01", palette: ["#244b3a"] };
    const creates = [];
    await page.route("https://challenges.cloudflare.com/**", route => route.fulfill({
      contentType: "text/javascript",
      body: "window.turnstile={render(el,opts){window.qaChallenge=opts.callback; opts.callback('test-token');return 1},reset(){setTimeout(()=>window.qaChallenge('test-token'),0)}}"
    }));
    await page.route("**/api/guest**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(action === "site" ? { wedding } : action === "leaderboard" ? { bids: [] } : {}) });
    });
    await page.route("**/api/checkout**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      let data, code = 200;
      if (action === "options") data = { mode: "live", providers: [{ id: "daraja", label: "M-Pesa · Safaricom Daraja", market: "KE" }], paymentAvailable: true, turnstileSiteKey: "test" };
      else if (action === "status") data = { paymentStatus: "pending", actionStatus: "pending", action: "song_bid", provider: "daraja" };
      else {
        creates.push(route.request().postDataJSON());
        code = 503;
        data = { error: "We could not confirm the M-Pesa prompt. Do not retry; check status.", paymentId: "550e8400-e29b-41d4-a716-446655440002", paymentStatus: "pending" };
      }
      return route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
    });
    const url = `http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`;
    await page.goto(url);
    await page.locator("#song-request-form").waitFor({ state: "visible" });
    await page.fill("#song-request-title", "QA Song");
    await page.fill("#song-request-artist", "QA Artist");
    await page.fill("#song-request-amount", "10");
    await page.click('#song-request-form button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById("pay-submit").disabled);
    const note = await page.locator("#pay-mode-note").textContent();
    assert.match(note, /LIVE/);
    assert.doesNotMatch(note, /sandbox|test checkout/i);
    assert.match(await page.locator("#pay-submit").textContent(), /real money/i);
    assert.match(await page.locator("#pay-daraja-note").textContent(), /real money/i);
    await page.fill("#pay-name", "QA Guest");
    await page.fill("#pay-mpesa-phone", "254712345678");
    await page.click("#pay-submit");
    await page.waitForFunction(() => document.getElementById("pay-error").textContent.includes("Do not start another payment"));
    assert.equal(creates.length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-payment:550e8400-e29b-41d4-a716-446655440002") !== null), true);
    await page.evaluate(() => { document.getElementById("pay-submit").disabled = false; });
    await page.evaluate(() => document.getElementById("pay-form").requestSubmit());
    await page.waitForTimeout(500);
    assert.equal(creates.length, 1, "no second initiation from the same dialog");
    await page.reload();
    await page.locator("#song-request-form").waitFor({ state: "visible" });
    await page.fill("#song-request-title", "QA Song");
    await page.fill("#song-request-artist", "QA Artist");
    await page.fill("#song-request-amount", "10");
    await page.click('#song-request-form button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById("pay-submit").disabled);
    await page.fill("#pay-name", "QA Guest");
    await page.fill("#pay-mpesa-phone", "254712345678");
    await page.evaluate(() => document.getElementById("pay-form").requestSubmit());
    await page.waitForTimeout(500);
    assert.equal(creates.length, 1, "no second initiation after reload while the first is unresolved");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
