import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (file.includes("..")) throw new Error("Invalid path");
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" })
      .end(body);
  } catch { res.writeHead(404).end("Not found"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
for (const options of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(options); break; } catch { /* try next */ }
}
const skip = browser ? false : "No Chromium/Edge available (run: npx playwright install chromium)";
if (!browser && process.env.CI) throw new Error(skip);

async function openDashboard(handlers = {}, query = "") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "" }));
  });
  await page.route("**/api/referrals*", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ intent_id: null })
  }));
  await page.route("**/api/guest*", route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    const handler = handlers[`guest:${action}`];
    return handler ? handler(route) : route.fulfill({ status: 404, body: "{}" });
  });
  await page.route("**/api/weddings*", async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    calls.push({ action, body });
    const handler = handlers[action];
    if (action === "list" && !handler) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ weddings: [] }) });
    }
    return handler ? handler(route, body) : route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto(`${base}/dashboard.html${query}`);
  await page.waitForLoadState("networkidle");
  await page.locator("#create-submit").waitFor();
  return { page, calls, errors, close: () => context.close() };
}

const json = (status, body, delay = 0) => async route => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
};

test("dashboard opens without script errors or native form navigation", { skip }, async () => {
  const { page, errors, close } = await openDashboard();
  await page.fill("#couple-names", "Sarah & John");
  await page.click("#create-submit");
  await page.waitForTimeout(100);
  assert.equal(new URL(page.url()).search, "", "the form must not navigate natively");
  assert.deepEqual(errors, []);
  await close();
});

test("create entry makes one idempotent draft request and continues to the shared wedding guide", { skip }, async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const { page, calls, close } = await openDashboard({
    create: json(201, { weddingId: id, slug: "sarah-john" }, 100)
  });
  await page.fill("#couple-names", "Sarah & John");
  await page.evaluate(() => {
    const form = document.getElementById("create-form");
    const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    submit();
    submit();
  });
  await page.waitForURL(`**/wedding.html?id=${id}&slug=sarah-john#step=couple`);
  const creates = calls.filter(call => call.action === "create");
  assert.equal(creates.length, 1, "double submission creates only one draft");
  assert.equal(creates[0].body.coupleNames, "Sarah & John");
  assert.ok(creates[0].body.requestKey);
  assert.equal(creates[0].body.weddingDate, null);
  assert.deepEqual(creates[0].body.venues, []);
  assert.equal(Object.hasOwn(creates[0].body, "referral"), false, "no referral choice is fabricated");
  await close();
});

test("supported platform default preselects only a new names-only draft currency", { skip }, async () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const { page, calls, close } = await openDashboard({
    "collection-capabilities": json(200, {
      currencies: [{ code: "KES", name: "Kenyan Shilling", methods: [{ name: "M-Pesa", markets: ["Kenya"] }] }],
      defaultCurrency: { currency: "KES", configured: true, supported: true }
    }),
    create: json(201, { weddingId: id, slug: "default-currency" })
  });
  await page.fill("#couple-names", "Amina & Joseph");
  await page.click("#create-submit");
  await page.waitForURL(`**/wedding.html?id=${id}&slug=default-currency#step=couple`);
  const create = calls.find(call => call.action === "create");
  assert.equal(create.body.currency, "KES");
  assert.equal(create.body.starterSetup, undefined, "a default does not fabricate a priced starter");
  await close();
});

test("unavailable style entry checks the default lazily before creating a names-only draft", { skip }, async () => {
  const id = "44444444-4444-4444-4444-444444444444";
  const { page, calls, close } = await openDashboard({
    "guest:style": json(404, { error: "This wedding is not available for public setup reuse." }),
    "collection-capabilities": json(200, {
      currencies: [{ code: "KES", name: "Kenyan Shilling", methods: [{ name: "M-Pesa", markets: ["Kenya"] }] }],
      defaultCurrency: { currency: "KES", configured: true, supported: true }
    }),
    create: json(201, { weddingId: id, slug: "fallback-currency" })
  }, "?style=unavailable-style");
  await page.locator("#notice").filter({ hasText: /not available for public setup reuse/ }).waitFor();
  assert.equal(calls.filter(call => call.action === "collection-capabilities").length, 0,
    "a failed starter entry does not preflight currency before the user chooses a plain draft");
  await page.fill("#couple-names", "Amina & Joseph");
  await page.click("#create-submit");
  await page.waitForURL(`**/wedding.html?id=${id}&slug=fallback-currency#step=couple`);
  assert.equal(calls.filter(call => call.action === "collection-capabilities").length, 1);
  assert.equal(calls.find(call => call.action === "create").body.currency, "KES");
  await close();
});

for (const [label, handler, pattern] of [
  ["API 400 error", json(400, { error: "Check the couple names." }), /Check the couple names/],
  ["API 500 error", json(500, {}), /HTTP 500/],
  ["401 session expired", json(401, { error: "Your session has expired." }), /session has expired/i],
  ["non-JSON error body", route => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }), /HTTP 502/],
  ["network failure", route => route.abort("connectionrefused"), /Could not reach the server|Failed to fetch/i]
]) {
  test(`create error (${label}) keeps the couple name and allows retry`, { skip }, async () => {
    const { page, calls, close } = await openDashboard({ create: handler });
    await page.fill("#couple-names", "Amina & Joseph");
    await page.click("#create-submit");
    await page.waitForFunction(() => !document.getElementById("create-submit").disabled);
    assert.match(await page.locator("#notice").innerText(), pattern);
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    await page.click("#create-submit");
    await page.waitForFunction(() => !document.getElementById("create-submit").disabled);
    assert.equal(calls.filter(call => call.action === "create").length, 2);
    await close();
  });
}

test("client validation focuses missing names and sends no create request", { skip }, async () => {
  const { page, calls, close } = await openDashboard({ create: json(201, { weddingId: "x", slug: "x" }) });
  await page.click("#create-submit");
  assert.match(await page.locator("#notice").innerText(), /names/i);
  assert.equal(await page.locator("#couple-names").evaluate(element => element === document.activeElement), true);
  assert.equal(calls.filter(call => call.action === "create").length, 0);
  await page.fill("#couple-names", "Amina & Joseph");
  assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
  await close();
});

test("weddings list escapes couple names and reports list failures", { skip }, async () => {
  const wedding = {
    id: "22222222-2222-2222-2222-222222222222", slug: "s",
    couple_names: "<img src=x onerror=alert(1)>", currency: "USD",
    max_guest_capacity: 10, palette: ["#244b3a"], created_at: "2026-01-01T00:00:00Z"
  };
  const ok = await openDashboard({ list: json(200, { weddings: [wedding] }) });
  await ok.page.waitForSelector("#weddings-grid .card");
  assert.equal(await ok.page.locator("#weddings-grid img").count(), 0);
  await ok.close();
  const bad = await openDashboard({ list: json(500, { error: "Database unavailable" }) });
  await bad.page.waitForFunction(() => /Database unavailable/.test(document.getElementById("empty").textContent));
  await bad.close();
});

test("sign out clears the session and no session redirects to sign in", { skip }, async () => {
  const { page, close } = await openDashboard();
  await page.route("**/signin.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "signin" }));
  await page.click("#account-menu-btn");
  await page.click("#account-sign-out");
  await page.waitForURL("**/signin.html");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-session")), null);
  await close();
  const context = await browser.newContext();
  const pageNoSession = await context.newPage();
  await pageNoSession.route("**/signin.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "signin" }));
  await pageNoSession.goto(`${base}/dashboard.html`);
  await pageNoSession.waitForURL("**/signin.html");
  await context.close();
});

test("owner profile link opens the account page and stays hidden for clients", { skip }, async () => {
  const context = await browser.newContext();
  const ownerPage = await context.newPage();
  await ownerPage.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({
    a: "test-token", r: "", role: "owner"
  })));
  await ownerPage.route("**/api/weddings*", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ weddings: [] })
  }));
  await ownerPage.route("**/account.html", route => route.fulfill({ status: 200, contentType: "text/html", body: "account" }));
  await ownerPage.goto(`${base}/dashboard.html`);
  await ownerPage.click("#account-menu-btn");
  const ownerLink = ownerPage.locator("#owner-profile");
  await ownerLink.waitFor({ state: "visible" });
  assert.equal(await ownerLink.getAttribute("href"), "/account.html");
  await ownerLink.click();
  await ownerPage.waitForURL("**/account.html");
  await context.close();
  const { page, close } = await openDashboard();
  await page.click("#account-menu-btn");
  assert.equal(await page.locator("#owner-profile").isVisible(), false);
  await close();
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
