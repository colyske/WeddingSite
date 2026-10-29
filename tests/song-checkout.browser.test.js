import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("empty and populated DJ lists open verified checkout and preserve requests on failure", async () => {
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
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
      wedding_date: "2099-01-01", currency: "KES", published_at: "2026-01-01", palette: ["#244b3a"] };
    let bids = [];
    let status = "pending";
    let failCheckout = true;
    let payload;
    await page.route("https://challenges.cloudflare.com/**", route => route.fulfill({
      contentType: "text/javascript",
      body: "window.turnstile={render(el,opts){window.qaChallenge=opts.callback; opts.callback('test-token');return 1},reset(){setTimeout(()=>window.qaChallenge('test-token'),0)}}"
    }));
    await page.route("**/api/guest**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      const data = action === "site" ? { wedding } : action === "leaderboard" ? { bids } : {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.route("**/api/checkout**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      let data, code = 200;
      if (action === "options") data = { providers: [{ id: "daraja", name: "Daraja Sandbox", market: "KE" }], paymentAvailable: true, turnstileSiteKey: "test" };
      else if (action === "status") {
        data = { paymentStatus: status, actionStatus: status === "paid" ? "completed" : "pending", action: "song_bid" };
      } else {
        payload = route.request().postDataJSON();
        if (failCheckout) { data = { error: "Test provider unavailable" }; code = 503; }
        else data = { provider: "daraja", paymentId: "550e8400-e29b-41d4-a716-446655440002", paymentStatus: "pending" };
      }
      return route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
    });
    const url = `http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`;
    await page.goto(url);
    await page.locator("#song-request-form").waitFor({ state: "visible" });
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator("#song-request-form").isVisible(), true, "new-song request is visible on desktop");
    await page.setViewportSize({ width: 375, height: 900 });
    assert.equal(await page.locator("#song-request-form").isVisible(), true, "new-song request is visible on mobile");
    await page.click("#no-bids-cta");
    assert.equal(await page.locator("#song-request-title").evaluate(el => el === document.activeElement), true);
    await page.fill("#song-request-title", "QA Song");
    await page.fill("#song-request-artist", "QA Artist");
    await page.fill("#song-request-amount", "10");
    await page.click('#song-request-form button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById("pay-submit").disabled);
    assert.equal(await page.locator("#pay-amount").inputValue(), "10");
    await page.fill("#pay-name", "QA Test");
    await page.fill("#pay-mpesa-phone", "254708374149");
    await page.click("#pay-submit");
    await page.waitForFunction(() => document.getElementById("pay-error").textContent.includes("unavailable"));
    assert.equal(payload.songTitle, "QA Song");
    assert.equal(payload.artist, "QA Artist");
    assert.equal(payload.purchaseAction, "song_bid");
    assert.equal(payload.amountMinor, 1000);
    assert.equal(await page.locator("#song-request-title").inputValue(), "QA Song");
    assert.equal(await page.locator("#pay-name").inputValue(), "QA Test");
    assert.equal(await page.locator("#leaderboard-body tr").count(), 0);

    failCheckout = false;
    await page.click("#pay-submit");
    await page.waitForFunction(() => document.getElementById("pay-submit").textContent.includes("Waiting"));
    assert.equal(await page.locator("#leaderboard-body tr").count(), 0, "pending STK acceptance creates no leaderboard entry");
    status = "cancelled";
    await page.waitForFunction(() => document.getElementById("pay-error").textContent.includes("unsuccessful M-Pesa"));
    assert.equal(await page.locator("#leaderboard-body tr").count(), 0, "declined payments create no entry");
    bids = [{ song_title: "QA Song", artist_name: "QA Artist", bid_amount_minor: 1000, bid_count: 1 }];
    status = "paid";
    await page.click("#pay-submit");
    await page.waitForFunction(() => !document.getElementById("pay-dialog").open);
    await page.locator("#leaderboard-body tr").waitFor();
    assert.equal(await page.locator("#leaderboard-body tr").count(), 1, "verified new request appears once");
    assert.equal(await page.locator("#leaderboard-body tr.song-highlight").count(), 1, "new paid song is highlighted");
    assert.equal(payload.songTitle, "QA Song");
    await page.reload();
    await page.locator("#leaderboard-body summary").first().click();
    await page.getByRole("button", { name: "Custom amount", exact: true }).click();
    await page.click("#pay-cancel");
    assert.equal(await page.locator("#leaderboard-body summary").evaluate(el => el === document.activeElement), true);
    await page.getByRole("button", { name: "Custom amount", exact: true }).click();
    assert.match(await page.locator("#pay-summary").textContent(), /QA Song/);
    assert.equal(await page.locator("#pay-amount").getAttribute("readonly"), null);
    await page.fill("#pay-amount", "25");
    await page.fill("#pay-mpesa-phone", "254708374149");
    await page.waitForFunction(() => !document.getElementById("pay-submit").disabled);
    status = "paid";
    bids = [{ song_title: "QA Song", artist_name: "QA Artist", bid_amount_minor: 3500, bid_count: 2 }];
    await page.click("#pay-submit");
    await page.waitForFunction(() => !document.getElementById("pay-dialog").open);
    assert.equal(payload.songTitle, "QA Song");
    assert.equal(payload.artist, "QA Artist");
    assert.equal(payload.amountMinor, 2500);
    assert.equal(await page.locator("#leaderboard-body tr").count(), 1);
    assert.match(await page.locator("#leaderboard-body").textContent(), /2 bids/);
    await page.reload();
    assert.equal(await page.locator("#song-request-title").inputValue(), "");
    await page.locator("#leaderboard-body tr").waitFor();
    assert.equal(await page.locator("#leaderboard-body tr").count(), 1);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
