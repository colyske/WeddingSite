import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

const id = "550e8400-e29b-41d4-a716-446655440000";
const readyWedding = () => ({
  id, slug: "amina-and-joseph", couple_names: "Amina & Joseph", wedding_date: "2027-03-20", currency: "USD",
  welcome_story: "We are making plans together.", time_zone: "UTC", palette: [], palette_names: [], tiers: [],
  registry: [{ id: "registry-1", name: "Honeymoon", target_amount_minor: 50000 }], published_at: null,
  payout: { method: "bank" }, venues: [{ id: "00000000-0000-0000-0000-000000000001", name: "Garden Hall", event_date: "2027-03-20",
    event_time: "14:00", address: "1 Garden Road", kind: "ceremony", is_main: true }]
});

test("guide renders before secondary panels finish and isolates their failures", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const body = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" })
        .end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const base = `http://127.0.0.1:${server.address().port}`;

    async function open({ hold = [], fail = [] }) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [], calls = [], releases = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
      await page.route("https://**", route => route.fulfill({ body: "" }));
      await page.route("**/api/**", async route => {
        const action = new URL(route.request().url()).searchParams.get("action");
        calls.push(action);
        if (hold.includes(action)) await new Promise(resolve => releases.push(resolve));
        if (fail.includes(action)) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
        let data = {};
        if (action === "get") data = { wedding: readyWedding(), amountPresetMaxMinor: 100000000 };
        if (action === "collection-capabilities") data = { currencies: [{ code: "USD", name: "US Dollar", methods: [{ name: "Card", markets: ["United States"] }] }] };
        if (action === "payout-methods") data = { methods: [{ value: "bank", label: "Bank transfer" }] };
        if (action === "quote") data = { quote: { fee_minor: 0, currency: "USD", reason: "Fixture allowance." } };
        if (action === "campaigns") data = { currency: "USD", campaigns: [], summary: [], rows: [] };
        if (action === "extras-get") data = { faq: [], travel: "" };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      });
      await page.goto(`${base}/wedding.html?id=${id}`);
      return { context, page, errors, calls, release: () => releases.splice(0).forEach(resolve => resolve()) };
    }

    const held = await open({ hold: ["campaigns", "extras-get", "collection-capabilities"] });
    await held.page.locator("#edit-section").waitFor({ state: "visible" });
    assert.equal(await held.page.inputValue("#couple-names"), "Amina & Joseph", "saved core answers render before secondary panels load");
    assert.ok(await held.page.locator(".guide-nav button").count() > 0, "the guide is ready before secondary panels load");
    assert.equal(await held.page.locator("#add-campaign").isDisabled(), true, "campaign controls wait for saved campaigns");
    assert.equal(await held.page.locator("#travel-info").isDisabled(), true, "travel notes wait for saved extras");
    assert.equal(await held.page.locator("#currency").isDisabled(), true, "currency waits for supported capabilities");
    assert.equal(await held.page.locator("#publish-btn").isVisible(), false, "publishing waits for capabilities");
    for (const action of ["campaigns", "extras-get", "collection-capabilities", "payout-methods", "sponsor-enquiries"])
      assert.ok(held.calls.includes(action), `${action} is requested concurrently with the visible guide`);
    held.release();
    await held.page.locator("#add-campaign:not([disabled])").waitFor({ state: "attached" });
    await held.page.locator("#travel-info:not([disabled])").waitFor({ state: "attached" });
    await held.page.locator("#publish-btn").waitFor({ state: "visible" });
    assert.equal(await held.page.locator("#currency").isDisabled(), false);
    assert.equal(await held.page.locator(".guide-nav button[aria-current], .guide-nav button").first().isVisible(), true);
    assert.deepEqual(held.errors, []);
    await held.context.close();

    const payoutDown = await open({ fail: ["payout-methods"] });
    await payoutDown.page.locator("#edit-section").waitFor({ state: "visible" });
    await payoutDown.page.locator("#add-campaign:not([disabled])").waitFor({ state: "attached" });
    assert.equal(await payoutDown.page.locator("#payout-method").isDisabled(), true, "an unavailable payout list cannot overwrite the saved preference");
    assert.equal(await payoutDown.page.locator("#payout-method").inputValue(), "bank", "the saved payout preference is still shown");
    assert.deepEqual(payoutDown.errors, [], "a payout list failure never breaks the editor");
    await payoutDown.context.close();

    const capabilitiesDown = await open({ fail: ["collection-capabilities"] });
    await capabilitiesDown.page.locator("#edit-section").waitFor({ state: "visible" });
    await capabilitiesDown.page.locator("#add-campaign:not([disabled])").waitFor({ state: "attached" });
    await capabilitiesDown.page.waitForTimeout(100);
    assert.equal(await capabilitiesDown.page.locator("#publish-btn").isVisible(), false, "publishing stays hidden without authoritative capabilities");
    assert.equal(await capabilitiesDown.page.locator("[data-guide-publish]").isVisible(), false);
    await capabilitiesDown.context.close();
  } finally {
    await browser?.close();
    server.close();
  }
});
