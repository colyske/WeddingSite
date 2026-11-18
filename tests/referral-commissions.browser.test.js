import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { publicWeddingStyle } from "../server/wedding-style.js";

const showcaseStyle = await publicWeddingStyle("showcase-wedding");

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
  await page.route("**/api/guest?action=style*", route => fulfill(route, { style: showcaseStyle }));
  await page.route("**/api/referrals*", route => fulfill(route, { recipients: [] }));
  return { ctx, page };
}
async function fillWedding(page) {
  await page.fill("#couple-names", "Local couple");
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
  await page.waitForURL(url => url.pathname === "/signin.html");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-client-referral")), code);
  await page.evaluate(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "actor-token", role: "client" })));
  await page.goto(`${base}/dashboard.html?client_ref=${"b".repeat(32)}`);
  await page.waitForSelector("#client-referral-disclosure", { state: "visible" });
  assert.deepEqual(captured, [code]);
  assert.match(await page.textContent("#client-referral-details"), /8\.88%/);
  assert.match(await page.textContent("#client-referral-details"), /paid after funds are cleared/i);
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
  await page.waitForFunction(() =>
    document.querySelector("#notice")?.textContent.includes("policy changed") ||
    location.pathname.includes("wedding.html") || location.pathname.includes("signin.html"));
  const retryState = await page.evaluate(() => ({
    path: location.pathname,
    notice: document.querySelector("#notice")?.textContent,
    created: document.querySelector("#created")?.textContent
  }));
  assert.match(retryState.notice || "", /policy changed/i,
    `stale disclosure should preserve the form and show its error: ${JSON.stringify({ retryState, creations })}`);
  assert.equal(await page.inputValue("#couple-names"), "Local couple");
  assert.equal(await page.inputValue("#client-referral-decision"), "");
  await page.selectOption("#client-referral-decision", "decline");
  await page.click("#create-submit");
  await page.waitForURL(`**/wedding.html?id=${uuid}#step=couple`);
  assert.equal(creations.length, 2, "one stale attempt and one confirmed retry create exactly one draft");
  assert.equal(creations[1].referral.decision, "decline");
  assert.equal(creations[1].referral.revision, revision);
  assert.equal(creations[1].requestKey, creations[0].requestKey, "stale referral retry retains the creation key");
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
      { reference: uuid, eligible: true, excluded_by_account_link: true, currency: "KES", verified_basis_minor: "100000", held_estimate_minor: "0" },
      { reference: uuid, eligible: true, currency: "USD", verified_basis_minor: "9007199254740993", held_estimate_minor: "9" }
    ] });
  });
  await page.goto(`${base}/referrals.html`);
  await page.check("#referral-consent");
  await page.click("#referral-consent-form button");
  await page.waitForSelector("#referral-account", { state: "visible" });
  assert.match(await page.inputValue("#referral-link"), /client_ref=aaaaaaaa/);
  assert.match(await page.textContent("#referral-results"), /tracked 2% commission KES 0\.00/);
  assert.match(await page.textContent("#referral-results"), /not eligible \(account is connected to this wedding\)/);
  assert.match(await page.textContent("#referral-results"), /USD 90,071,992,547,409\.93/);
  assert.match(await page.textContent("#referral-results"), /tracked 2% commission USD 0\.09/);
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

test("Owner records platform funding evidence without claiming a payout", { skip }, async () => {
  const { ctx, page } = await context();
  const writes = [];
  await page.route("**/api/admin*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "role") return fulfill(route, { role: "owner" });
    if (action === "referral-policy") return fulfill(route, { policy: { ...disclosure, first_effective_at: null } });
    if (action === "referral-history") return fulfill(route, { history: [] });
    if (action === "referral-ledger") return fulfill(route, { entries: [], payable_minor: "0" });
    if (action === "referral-funding-reviews") return fulfill(route, { reviews: [] });
    if (action === "referral-funding-create") {
      writes.push(JSON.parse(route.request().postData()));
      return fulfill(route, { id: uuid });
    }
    return fulfill(route, { queue: {}, adjustments: {}, cases: [], settlement: {} });
  });
  await page.goto(`${base}/admin.html`);
  await page.click('[data-tab="referrals"]');
  await page.waitForSelector("#referral-funding-form");
  for (const [name, value] of Object.entries({ contribution: uuid, settled: "8880", cost: "2000",
    losses: "0", holds: "0", commitments: "0", reference: revision, sha256: "a".repeat(64) })) {
    await page.fill(`#referral-funding-form [name="${name}"]`, value);
  }
  await page.check('#referral-funding-form [name="confirmed"]');
  await page.click("#referral-funding-form button");
  await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("no payout was authorized"), null,
    { timeout: 10000 }).catch(async error => {
    const notice = await page.locator("#notice").textContent();
    await ctx.close();
    throw new Error(`${error.message}; notice: ${notice}; writes: ${JSON.stringify(writes)}`);
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].settled, 8880);
  assert.equal(writes[0].cost, 2000);
  assert.match(await page.locator("body").textContent(), /Payable: zero/);
  await ctx.close();
});

test("Leadership reviews the exact facilitator recipient revision", { skip }, async () => {
  const { ctx, page } = await context();
  const writes = [];
  let evidenceId = null, checked = false;
  await page.route("**/api/admin*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "role") return fulfill(route, { role: "owner" });
    if (action === "referral-policy") return fulfill(route, { policy: { ...disclosure, first_effective_at: null } });
    if (action === "referral-history") return fulfill(route, { history: [] });
    if (action === "referral-ledger") return fulfill(route, { entries: [] });
    return fulfill(route, { records: [], reviews: [], queue: {}, adjustments: {}, cases: [], settlement: {} });
  });
  await page.route("**/api/referrals*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "recipient-workspace") return fulfill(route, { recipients: [{
      user_id: uuid, revision, full_name: "Fixture Facilitator", phone: "254700000003",
      status: checked ? "verified" : evidenceId ? "review_pending" : "evidence_required",
      evidence_id: evidenceId, evidence_reference: uuid, evidence_sha256: "a".repeat(64),
      evidence_submitted_by: uuid, checked_by: checked ? uuid : null, owner_solo: checked
    }] });
    writes.push({ action, body: JSON.parse(route.request().postData()) });
    if (action === "recipient-evidence") { evidenceId = uuid; return fulfill(route, { evidence_id: uuid }); }
    if (action === "recipient-verify") { checked = true; return fulfill(route, { verified: true }); }
    return fulfill(route, {});
  });
  await page.goto(`${base}/admin.html`);
  await page.click('[data-tab="referrals"]');
  await page.waitForSelector("[data-recipient-evidence]");
  await page.fill('[data-recipient-evidence] [name="reference"]', uuid);
  await page.fill('[data-recipient-evidence] [name="sha256"]', "a".repeat(64));
  await page.check('[data-recipient-evidence] [name="confirmed"]');
  await page.click("[data-recipient-evidence] button");
  await page.waitForSelector("[data-recipient-verify]");
  await page.check('[data-recipient-verify] [name="ownerSolo"]');
  await page.check('[data-recipient-verify] [name="confirmed"]');
  await page.click("[data-recipient-verify] button");
  await page.waitForFunction(() => document.body.textContent.includes("Checked by"));
  assert.deepEqual(writes.map(item => item.action), ["recipient-evidence", "recipient-verify"]);
  assert.equal(writes[1].body.revision, revision);
  assert.equal(writes[1].body.ownerSolo, true);
  await ctx.close();
});

test.after(async () => {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
});
