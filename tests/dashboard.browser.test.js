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
  const path = new URL(req.url, "http://x").pathname;
  try {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (file.includes("..")) throw new Error("bad path");
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
for (const opts of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(opts); break; } catch { /* try next */ }
}
const skip = browser ? false : "No Chromium/Edge available (run: npx playwright install chromium)";
if (!browser && process.env.CI) throw new Error(skip);

// Opens the dashboard with a seeded session and a mocked API.
async function openDashboard(handlers = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = [];
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "" }));
  });
  await page.route("**/api/weddings*", async (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    calls.push({ action, body });
    const h = handlers[action];
    if (action === "list" && !h) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ weddings: [] }) });
    return h ? h(route, body) : route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto(`${base}/dashboard.html`);
  await page.waitForSelector("#venues-container .venue-item");
  return { page, calls, errors, close: () => context.close() };
}

const json = (status, obj, delay = 0) => async (route) => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
};

const fill = async (page, names = "Sarah & John", location = "Nairobi") => {
  await page.fill("#couple-names", names);
  await page.fill("#location", location);
};

const noop = { name: "x" };
void noop;

test("page loads with no script errors and no native form navigation", { skip }, async () => {
  const { page, errors, close } = await openDashboard();
  await fill(page);
  await page.click("#create-submit");
  await page.waitForTimeout(150);
  assert.equal(new URL(page.url()).search, "", "form must never submit natively (no query string)");
  assert.deepEqual(errors, []);
  await close();
});

test("Edit colours toggles editor, updates swatches, saves and resets (4 colours)", { skip }, async () => {
  const { page, close } = await openDashboard();
  assert.equal(await page.isHidden("#palette-editor"), true);
  await page.click("#edit-palette");
  assert.equal(await page.isVisible("#palette-editor"), true);
  for (const [i, c] of ["#112233", "#445566", "#778899", "#aabbcc"].entries()) {
    await page.fill(`#color-${i + 1}`, c);
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    await page.waitForFunction(([id, rgb]) => getComputedStyle(document.getElementById(id)).backgroundColor === rgb, [`swatch-${i + 1}`, `rgb(${r}, ${g}, ${b})`]);
  }
  await page.click("#save-palette");
  assert.equal(await page.isHidden("#palette-editor"), true);
  await page.click("#edit-palette");
  await page.click("#reset-palette");
  assert.equal(await page.inputValue("#color-1"), "#244b3a");
  await close();
});

test("success: sends every field (currency, capacity, palette, venues), shows created wedding, double-submit blocked", { skip }, async () => {
  const { page, calls, close } = await openDashboard({ create: json(201, { weddingId: "11111111-1111-1111-1111-111111111111", slug: "sarah-john" }, 300) });
  await fill(page);
  await page.fill("#wedding-date", "2027-06-12");
  await page.selectOption("#currency", "KES");
  await page.fill("#max-capacity", "220");
  await page.click("#edit-palette");
  await page.fill("#color-2", "#123456");
  await page.click("#add-venue");
  const names = page.locator("[data-venue-field=name]");
  await names.nth(0).fill("Church");
  await names.nth(1).fill("Reception");
  await page.locator("input[name=main-venue]").nth(1).check();

  await page.click("#create-submit");
  assert.equal(await page.isDisabled("#create-submit"), true, "button disabled while creating");
  await page.locator("#create-submit").dispatchEvent("click");
  await page.locator("#create-form").evaluate((f) => f.requestSubmit());
  await page.waitForSelector("#created:not([hidden])");

  const creates = calls.filter((c) => c.action === "create");
  assert.equal(creates.length, 1, "double submit must produce a single request");
  const b = creates[0].body;
  assert.equal(b.coupleNames, "Sarah & John");
  assert.equal(b.currency, "KES");
  assert.equal(b.maxCapacity, 220);
  assert.equal(b.weddingDate, "2027-06-12");
  assert.equal(b.palette.length, 4);
  assert.equal(b.palette[1], "#123456");
  assert.deepEqual(b.venues.map((v) => [v.name, v.isMain]), [["Church", false], ["Reception", true]]);
  assert.match(await page.textContent("#created"), /Sarah & John/);
  assert.match(await page.getAttribute('#created a[href*="wedding.html"]', "href"), /wedding\.html\?id=1111.*slug=sarah-john/);
  assert.ok(b.timeZone, "time zone is sent");
  assert.match(await page.inputValue("#created .ws-share-url"), /guest\.html\?slug=sarah-john$/);
  assert.equal(await page.inputValue("#couple-names"), "", "form reset only after success");
  await close();
});

for (const [label, handler, pattern] of [
  ["API 400 error", json(400, { error: "Check the couple names." }), /Check the couple names/],
  ["API 500 error", json(500, {}), /HTTP 500/],
  ["401 session expired", json(401, { error: "Unauthorized" }), /session has expired/i],
  ["non-JSON error body", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }), /HTTP 502/],
  ["network failure", (route) => route.abort("connectionrefused"), /Could not reach the server/]
]) {
  test(`error (${label}): message shown, every value kept, can retry`, { skip }, async () => {
    const { page, calls, close } = await openDashboard({ create: handler });
    await fill(page, "Amina & Joseph", "Mombasa");
    await page.selectOption("#currency", "NGN");
    await page.fill("#max-capacity", "75");
    await page.click("#edit-palette");
    await page.fill("#color-3", "#abcdef");
    await page.locator("[data-venue-field=name]").first().fill("Beach chapel");
    await page.click("#create-submit");
    await page.waitForFunction(() => !document.getElementById("create-submit").disabled);
    assert.match(await page.textContent("#notice"), pattern);
    assert.equal(await page.isVisible("#notice"), true);
    assert.equal(await page.inputValue("#couple-names"), "Amina & Joseph");
    assert.equal(await page.inputValue("#location"), "Mombasa");
    assert.equal(await page.inputValue("#currency"), "NGN");
    assert.equal(await page.inputValue("#max-capacity"), "75");
    assert.equal(await page.inputValue("#color-3"), "#abcdef");
    assert.equal(await page.locator("[data-venue-field=name]").first().inputValue(), "Beach chapel");
    assert.equal(await page.isVisible("#created"), false);
    await page.click("#create-submit");
    await page.waitForFunction(() => !document.getElementById("create-submit").disabled);
    assert.equal(calls.filter((c) => c.action === "create").length, 2, "retry sends a new request");
    await close();
  });
}

test("client validation: shows messages, keeps values, sends nothing", { skip }, async () => {
  const { page, calls, close } = await openDashboard({ create: json(201, { weddingId: "x", slug: "x" }) });
  await page.click("#create-submit");
  assert.match(await page.textContent("#notice"), /Couple names|required/i);
  await page.fill("#couple-names", "A & B");
  await page.click("#create-submit");
  assert.match(await page.textContent("#notice"), /location|required/i);
  await page.fill("#location", "Kisumu");
  for (const bad of ["0", "-3", "2.5", ""]) {
    await page.fill("#max-capacity", bad);
    await page.click("#create-submit");
    assert.match(await page.textContent("#notice"), /capacity|required/i, `capacity "${bad}"`);
  }
  await page.fill("#max-capacity", "50");
  await page.click("[data-action=add-venue]");
  await page.locator("[data-venue-field=map]").first().fill("javascript:alert(1)");
  await page.click("#create-submit");
  assert.match(await page.textContent("#notice"), /http/);
  assert.equal(calls.filter((c) => c.action === "create").length, 0);
  assert.equal(await page.inputValue("#couple-names"), "A & B");
  await close();
});

test("venues: add, remove, choose main venue; values survive add/remove", { skip }, async () => {
  const { page, close } = await openDashboard();
  await page.locator("[data-venue-field=name]").first().fill("Church");
  await page.click("#add-venue");
  await page.click("#add-venue");
  assert.equal(await page.locator(".venue-item").count(), 3);
  assert.equal(await page.locator("[data-venue-field=name]").first().inputValue(), "Church");
  await page.locator("input[name=main-venue]").nth(2).check();
  await page.locator(".remove-venue").nth(1).click();
  assert.equal(await page.locator(".venue-item").count(), 2);
  assert.equal(await page.locator("input[name=main-venue]").nth(1).isChecked(), true, "main venue kept after removing another");
  await page.locator(".remove-venue").nth(1).click();
  await page.locator(".remove-venue").first().click();
  assert.equal(await page.locator(".venue-item").count(), 1, "always at least one venue row");
  await close();
});

test("weddings list renders escaped data; list failure shows a message", { skip }, async () => {
  const w = { id: "22222222-2222-2222-2222-222222222222", slug: "s", couple_names: "<img src=x onerror=alert(1)>", currency: "USD", max_guest_capacity: 10, palette: ["#244b3a"], created_at: "2026-01-01T00:00:00Z" };
  const ok = await openDashboard({ list: json(200, { weddings: [w] }) });
  await ok.page.waitForSelector("#weddings-grid .card");
  assert.equal(await ok.page.locator("#weddings-grid img").count(), 0);
  await ok.close();
  const bad = await openDashboard({ list: json(500, { error: "Database unavailable" }) });
  await bad.page.waitForFunction(() => /Database unavailable/.test(document.getElementById("empty").textContent));
  await bad.close();
});

test("sign out clears the session; no session redirects to sign in", { skip }, async () => {
  const { page, close } = await openDashboard();
  await page.route("**/signin.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "signin" }));
  await page.click("#sign-out");
  await page.waitForURL("**/signin.html");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-session")), null);
  await close();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.route("**/signin.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "signin" }));
  await p.goto(`${base}/dashboard.html`);
  await p.waitForURL("**/signin.html");
  await ctx.close();
});

test.after(async () => { await browser?.close(); server.close(); });
