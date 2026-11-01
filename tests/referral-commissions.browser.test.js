import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname.slice(1) || "index.html";
  try {
    if (path.includes("..")) throw new Error("Invalid path");
    const body = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("Not found"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
for (const options of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(options); break; } catch { /* try installed Chromium */ }
}
const skip = browser ? false : "Chromium unavailable";
if (!browser && process.env.CI) throw new Error(skip);
const uuid = "550e8400-e29b-41d4-a716-446655440000";
const revision = "550e8400-e29b-41d4-a716-446655440001";
const code = "a".repeat(32);
const disclosure = { intent_id: uuid, revision, terms_version: "client-referrals-v1", enabled: true,
  rate_basis_points: 100, platform_fee_basis_points: 888, platform_fixed_fee_minor: "0", platform_fixed_fee_currency: "USD" };
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
async function context(authenticated = true) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (authenticated) await ctx.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "actor-token", role: "client" })));
  const page = await ctx.newPage();
  return { ctx, page };
}
async function fillWedding(page) {
  await page.fill("#couple-names", "Local couple");
  await page.fill("#location", "Nairobi");
  await page.fill("#wedding-date", "2027-06-12");
  await page.locator('[data-venue-field="name"]').first().fill("Venue");
  await page.locator('[data-venue-field="time"]').first().fill("10:00");
  await page.locator('[data-venue-field="address"]').first().fill("Local address");
}

test("first valid client link survives sign-in and later codes cannot overwrite it", { skip }, async () => {
  const { ctx, page } = await context(false);
  const captured = [];
  await page.route("**/api/auth*", route => fulfill(route, { enabled: false }));
  await page.route("**/api/referrals*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "validate") return fulfill(route, { valid: true });
    if (action === "capture") { captured.push(JSON.parse(route.request().postData()).code); return fulfill(route, { intent_id: uuid }); }
    return fulfill(route, disclosure);
  });
  await page.route("**/api/weddings*", route => fulfill(route, { weddings: [] }));
  await page.goto(`${base}/dashboard.html?client_ref=${code}`);
  await page.waitForURL("**/signin.html");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-client-referral")), code);
  await page.evaluate(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "actor-token", role: "client" })));
  await page.goto(`${base}/dashboard.html?client_ref=${"b".repeat(32)}`);
  await page.waitForSelector("#client-referral-disclosure", { state: "visible" });
  assert.deepEqual(captured, [code]);
  assert.match(await page.textContent("#client-referral-details"), /8\.88%/);
  assert.match(await page.textContent("#client-referral-details"), /HELD and unpayable/);
  assert.equal(new URL(page.url()).search, "");
  await ctx.close();
});

test("couple declines atomically; stale disclosure requires another deliberate decision", { skip }, async () => {
  const { ctx, page } = await context();
  const creations = [];
  await page.route("**/api/referrals*", route => fulfill(route, disclosure));
  await page.route("**/api/weddings*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action !== "create") return fulfill(route, { weddings: [] });
    creations.push(JSON.parse(route.request().postData()));
    if (creations.length === 1) return fulfill(route, { error: "Referral policy changed; review again." }, 409);
    return fulfill(route, { weddingId: uuid, slug: "local-couple" });
  });
  await page.goto(`${base}/dashboard.html`);
  await page.waitForSelector("#client-referral-disclosure", { state: "visible" });
  await fillWedding(page);
  await page.click("#create-submit");
  assert.equal(creations.length, 0);
  await page.selectOption("#client-referral-decision", "decline");
  await page.click("#create-submit");
  await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("policy changed"));
  assert.equal(await page.inputValue("#couple-names"), "Local couple");
  assert.equal(await page.inputValue("#client-referral-decision"), "");
  await page.selectOption("#client-referral-decision", "decline");
  await page.click("#create-submit");
  await page.waitForFunction(() => document.querySelector("#created").textContent.includes("Local couple"));
  assert.equal(creations[1].referral.decision, "decline");
  assert.equal(creations[1].referral.revision, revision);
  await ctx.close();
});

test("referrer opt-in, exact currency-separated aggregates and withdrawal", { skip }, async () => {
  const { ctx, page } = await context();
  let account = null;
  await page.route("**/api/referrals*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "consent") {
      const body = JSON.parse(route.request().postData());
      account = { code, opted_in: body.optedIn, terms_version: body.termsVersion, consent_at: "2026-11-01T00:00:00Z" };
      return fulfill(route, account);
    }
    return fulfill(route, { account, referral_count: 1, weddings: [
      { reference: uuid, eligible: true, currency: "KES", verified_basis_minor: "100000", held_estimate_minor: "1000" },
      { reference: uuid, eligible: true, currency: "USD", verified_basis_minor: "9007199254740993", held_estimate_minor: "9" }
    ] });
  });
  await page.goto(`${base}/referrals.html`);
  await page.check("#referral-consent");
  await page.click("#referral-consent-form button");
  await page.waitForSelector("#referral-account", { state: "visible" });
  assert.match(await page.inputValue("#referral-link"), /client_ref=aaaaaaaa/);
  assert.match(await page.textContent("#referral-results"), /KES 10\.00/);
  assert.match(await page.textContent("#referral-results"), /USD 90,071,992,547,409\.93/);
  assert.match(await page.textContent("#referral-results"), /payable USD 0\.00/);
  await page.click("#referral-withdraw");
  await page.waitForFunction(() => document.querySelector("#referral-notice").textContent.includes("withdrawn"));
  assert.equal(await page.inputValue("#referral-link"), "");
  assert.equal(await page.isDisabled("#referral-copy"), true);
  await ctx.close();
});

test("Owner editing, SuperAdmin read-only and Admin exclusion", { skip }, async () => {
  for (const role of ["owner", "superadmin", "admin"]) {
    const { ctx, page } = await context();
    const writes = [];
    await page.route("**/api/admin*", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      if (action === "role") return fulfill(route, { role });
      if (action === "referral-policy") return fulfill(route, { policy: { ...disclosure, first_effective_at: null } });
      if (action === "referral-history") return fulfill(route, { history: [] });
      if (action === "referral-ledger") return fulfill(route, { entries: [], payable_minor: "0" });
      if (action === "referral-policy-save") { writes.push(JSON.parse(route.request().postData())); return fulfill(route, {}); }
      return fulfill(route, { queue: {}, adjustments: {}, cases: [], settlement: {} });
    });
    await page.goto(`${base}/admin.html`);
    await page.waitForSelector("#admin-nav button");
    if (role === "admin") {
      assert.equal(await page.locator('[data-tab="referrals"]').count(), 0);
    } else {
      await page.click('[data-tab="referrals"]');
      await page.waitForSelector("#referral-policy-form");
      if (role === "superadmin") assert.equal(await page.isDisabled('#referral-policy-form button'), true);
      else {
        await page.check('#referral-policy-form [name="confirmed"]');
        await page.fill('#referral-policy-form [name="percent"]', "1.25");
        await page.click('#referral-policy-form button');
        await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("remain held"));
        assert.equal(writes[0].rateBasisPoints, 125);
        assert.equal(writes[0].revision, revision);
      }
    }
    await ctx.close();
  }
});

test.after(async () => {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
});
