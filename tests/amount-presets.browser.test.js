import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("guests choose contribution amounts while existing minimums and fixed prices remain intact", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" })
        .end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    for (const currency of ["KES", "USD"]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
      await page.route("https://**", route => route.fulfill({ body: "" }));
      await page.route("https://open.er-api.com/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        result: "success", base_code: "USD", time_last_update_utc: new Date().toUTCString(), rates: { USD: 1, KES: 125 }
      }) }));
      const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
        wedding_date: "2099-01-01", currency, palette: ["#244b3a"],
        revenue_features: { giving: true, sponsors: true, featured_sponsors: true, song_requests: true, vip_seating: true },
        registry: [{ id: "registry-item", name: "Home fund", target_amount_minor: 9000000 }] };
      await page.route("**/api/guest**", route => {
        const action = new URL(route.request().url()).searchParams.get("action");
        const body = action === "site" ? { wedding } : action === "leaderboard" ? { bids: [
          { song_title: "Sample Song", artist_name: "Sample Artist", bid_amount_minor: 10000, bid_count: 1 }
        ] } : action === "fundraising" ? {
          campaigns: [{ id: "celebration", name: "Celebration fund", goal_minor: 9000000, raised_minor: 0,
            milestones: [{ id: "milestone", name: "Garden", target_minor: 500000 }] }],
          tiers: [{ id: "fixed-tier", name: "Fixed package", min_amount_minor: 76500, perks: "Package" }],
          vip: { id: "fixed-seat", title: "Fixed seat", price_minor: 65400, seats_total: 20, seats_sold: 0 }
        } : {};
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.route("**/api/checkout**", route => {
        assert.equal(new URL(route.request().url()).searchParams.get("action"), "options", "never initiate payment");
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Fixture checkout unavailable"}' });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`);
      await page.locator("#leaderboard-body [data-song-bid]").first().waitFor();
      assert.equal(await page.locator("#song-request-presets, [data-new-song-amount]").count(), 0);
      assert.equal(await page.locator("[data-song-bid][data-amount]").count(), 0);
      await page.fill("#song-request-title", "A Song");
      await page.fill("#song-request-artist", "An Artist");
      await page.fill("#song-request-amount", "3.25");
      await page.locator("#song-request-form button[type=submit]").click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "3.25", "a new song request uses the guest-entered amount");
      await page.locator("#pay-cancel").click();
      await page.locator("[data-song-bid]").first().click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "");
      assert.equal(await page.locator("#pay-amount").getAttribute("min"), "1", "existing song bids keep their minimum");
      await page.fill("#pay-amount", "4.75");
      assert.equal(await page.locator("[data-pay-preset]").count(), 0, "payment dialog has no amount suggestions");
      await page.locator("#pay-cancel").click();
      for (const kind of ["registry", "fund"]) {
        const buttons = page.locator(`[data-buy="${kind}"]`);
        await buttons.first().waitFor();
        await buttons.first().click();
        assert.equal(await page.locator("#pay-amount").inputValue(), "");
        assert.equal(await page.locator("#pay-amount").getAttribute("readonly"), null);
        assert.equal(await page.locator("[data-pay-preset]").count(), 0);
        await page.fill("#pay-amount", "2.75");
        await page.locator("#pay-cancel").click();
      }
      await page.locator("[data-milestone]").click();
      assert.equal(await page.locator("[data-pay-preset]").count(), 0);
      assert.equal(await page.locator("#pay-amount").inputValue(), "");
      await page.fill("#pay-amount", "5.25");
      await page.locator("#pay-cancel").click();
      await page.locator('[data-buy="sponsor"]').click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "", "sponsor amount is entered by the guest");
      assert.equal(await page.locator("#pay-amount").getAttribute("min"), "765", "sponsor minimum remains the required floor");
      assert.equal(await page.locator("#pay-amount").getAttribute("readonly"), null);
      await page.fill("#pay-amount", "800");
      await page.locator("#pay-cancel").click();
      await page.locator('[data-buy="vip"]').click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "654");
      assert.equal(await page.locator("[data-pay-preset]").count(), 0);
      assert.notEqual(await page.locator("#pay-amount").getAttribute("readonly"), null);
      await page.locator("#pay-cancel").click();
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
