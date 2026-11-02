import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const deployment = process.env.WEDDING_DEPLOYMENT_URL;

test("deployed organizer setup has no suggested-amount controls and filters to ready currencies",
  { skip: !deployment, timeout: 180000 }, async () => {
    assert.match(deployment, /^https:\/\/[^/?#]+\/?$/, "Use an HTTPS deployment origin.");
    let browser;
    try {
      try { browser = await chromium.launch({ channel: "msedge" }); }
      catch { browser = await chromium.launch(); }
      for (const currency of ["KES", "USD"]) {
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
              public_location: "Nairobi", currency,
              max_guest_capacity: 100, palette: ["#244b3a"], venues: []
            };
            const data = action === "get" ? { wedding }
              : action === "collection-capabilities" ? { currencies: [
                { code: "KES", name: "Kenyan shilling", methods: [{ name: "Mobile money", markets: ["Kenya"] }] },
                { code: "USD", name: "US dollar", methods: [{ name: "Card", markets: ["Supported markets"] }] }
              ] }
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
          await page.locator("#guide-heading-couple").waitFor();
          assert.equal(await page.locator("#preset-song, #preset-gift, #preset-currency, #preset-state").count(), 0,
            "organizers do not see suggested amount controls");
          await page.waitForFunction(() => {
            const select = document.getElementById("currency");
            return select && select.options.length === 2;
          });
          assert.deepEqual((await page.locator("#currency option").evaluateAll(options => options.map(option => option.value))).sort(),
            ["KES", "USD"], "only currencies returned as ready by the collection capability endpoint are selectable");
          assert.equal(loadedScripts.has("/amount-presets-editor.js"), false, "the deployed editor does not load amount presets");
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    } finally { await browser?.close(); }
  });
