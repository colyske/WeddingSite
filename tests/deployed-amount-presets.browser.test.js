import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const deployment = process.env.WEDDING_DEPLOYMENT_URL;

test("deployed organizer assets render saved KES and USD suggested amounts without writes",
  { skip: !deployment, timeout: 180000 }, async () => {
    assert.match(deployment, /^https:\/\/[^/?#]+\/?$/, "Use an HTTPS deployment origin.");
    let browser;
    try {
      try { browser = await chromium.launch({ channel: "msedge" }); }
      catch { browser = await chromium.launch(); }
      for (const [currency, amountPresets] of [
        ["KES", { currency: "KES", song: [10000, 50000, 100000], gift: [50000, 100000, 500000] }],
        ["USD", { currency: "USD", song: [725, 1250], gift: [1500, 3000] }]
      ]) {
        const context = await browser.newContext();
        try {
          await context.addInitScript(() => {
            localStorage.clear();
            sessionStorage.setItem("ws-session", JSON.stringify({
              a: "fixture-token", r: "client", user: { email: "sample@example.com" }
            }));
          });
          await context.route("https://open.er-api.com/**", route => route.fulfill({ status: 503, body: "Fixture only" }));
          await context.route("**/api/**", route => {
            assert.equal(route.request().method(), "GET", "deployed regression must never submit a write");
            const action = new URL(route.request().url()).searchParams.get("action");
            const wedding = {
              id: "550e8400-e29b-41d4-a716-446655440000", slug: "fixture-wedding",
              couple_names: "Fixture Couple", wedding_date: "2099-12-12", time_zone: "UTC",
              public_location: "Nairobi", currency, amount_presets: amountPresets,
              max_guest_capacity: 100, palette: ["#244b3a"], venues: []
            };
            const data = action === "get" ? { wedding, amountPresetMaxMinor: 50000000 }
              : action === "payout-methods" ? { methods: [] }
                : action === "kyc-get" ? { kyc: {} }
                  : action === "quote" ? { quote: { fee_minor: 0, currency } } : {};
            return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
          });
          const page = await context.newPage();
          const loadedScripts = new Set();
          const errors = [];
          page.on("response", response => {
            if (response.ok() && response.request().resourceType() === "script") {
              loadedScripts.add(new URL(response.url()).pathname);
            }
          });
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(new URL("wedding.html?id=550e8400-e29b-41d4-a716-446655440000", deployment).href,
            { waitUntil: "domcontentloaded" });
          await page.locator("#preset-song").waitFor({ state: "visible" });
          await page.waitForFunction(expected => document.getElementById("preset-song").value === expected,
            amountPresets.song.map(n => n / 100).join(", "));
          assert.equal(await page.locator("#preset-gift").inputValue(), amountPresets.gift.map(n => n / 100).join(", "));
          assert.equal(await page.locator("#preset-currency").innerText(), currency);
          assert.match(await page.locator("#preset-state").innerText(), /Saved organizer choices/);
          for (const script of ["/amount-presets.js", "/amount-presets-editor.js"]) {
            assert.ok(loadedScripts.has(script), `real deployed asset loaded: ${script}`);
          }
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); }
  });
