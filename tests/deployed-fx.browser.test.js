import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const deployment = process.env.WEDDING_DEPLOYMENT_URL;

test("deployed staff scripts render fresh USD/KES and explicit unavailable/stale states",
  { skip: !deployment, timeout: 180000 }, async () => {
    let browser;
    try {
      try { browser = await chromium.launch({ channel: "msedge" }); }
      catch { browser = await chromium.launch(); }
      for (const state of ["fresh", "stale", "unavailable"]) {
        const context = await browser.newContext();
        try {
          await context.addInitScript(() => {
            localStorage.clear();
            sessionStorage.setItem("ws-session", JSON.stringify({
              a: "fixture-token", r: "owner", user: { email: "sample@example.com" }
            }));
          });
          await context.route("https://open.er-api.com/**", route => state === "unavailable"
            ? route.fulfill({ status: 503, body: "Fixture rate outage" })
            : route.fulfill({ contentType: "application/json", body: JSON.stringify({
              result: "success", base_code: "USD", rates: { USD: 1, KES: 130 },
              time_last_update_utc: new Date(Date.now() - (state === "stale" ? 48 * 3600000 : 0)).toUTCString()
            }) }));
          await context.route("**/api/**", route => {
            assert.equal(route.request().method(), "GET", "deployed regression must never submit a write");
            const action = new URL(route.request().url()).searchParams.get("action");
            const data = action === "role" ? { role: "owner" }
              : action === "overview" ? {
                weddings: 1, collected_by_currency: { KES: 13000, USD: 100 }, settlement: {}
              } : {};
            return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
          });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          for (const surface of ["admin.html", "owner.html"]) {
            const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/fx.js");
            await page.goto(new URL(surface, deployment).href, { waitUntil: "domcontentloaded" });
            const asset = await loaded;
            assert.equal(asset.status(), 200, "real deployed FX asset must load successfully");
            assert.match(asset.headers()["content-type"], /javascript/);
            await page.waitForFunction(() => typeof window.WeddingSiteFX?.convertBetween === "function");
            await page.waitForFunction(expected => {
              const status = window.WeddingSiteFX.statusText();
              return expected === "fresh" ? status.includes("Latest published rate")
                : expected === "stale" ? status.includes("STALE FX") : status.includes("FX unavailable");
            }, state);
            await page.waitForFunction(() => document.getElementById("panel").textContent.includes("KES"));
            const panel = await page.locator("#panel").textContent();
            assert.match(panel, /USD|US\$/);
            assert.match(panel, /KES|Ksh/);
            if (state === "fresh") {
              assert.match(panel, /≈/);
              assert.match(panel, /ExchangeRate-API/);
              assert.match(panel, /dated/);
              assert.doesNotMatch(panel, /conversion unavailable or stale/);
              assert.equal(await page.evaluate(() => window.WeddingSiteFX.convertBetween(130, "KES", "USD")), 1);
            } else {
              assert.match(panel, /conversion unavailable or stale/);
              assert.doesNotMatch(panel, /≈/);
              assert.equal(await page.evaluate(() => window.WeddingSiteFX.convertBetween(130, "KES", "USD")), null);
            }
          }
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); }
  });
