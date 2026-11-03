import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = path === "/" ? "admin.html" : path.slice(1);
    if (file.includes("..")) throw new Error("Invalid path");
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" })
      .end(await readFile(join(root, file)));
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

test("Owner can review and confirm the default currency; SuperAdmins cannot see or read its control", { skip }, async () => {
  let role = "owner", currency = "KES";
  const calls = [];
  const policies = {
    publication_fee_minor: 2500, far_future_months: 18, far_future_fee_minor: 5000,
    free_publications_per_client: 1, contribution_fee_basis_points: 500,
    contribution_fixed_fee_minor: 0, contribution_fixed_fee_currency: "USD",
    max_contribution_minor: 100000000, min_payout_minor: 1000,
    max_payout_minor: 100000000, payout_hold_days: 3
  };
  const context = await browser.newContext();
  await context.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({
    a: "fixture-token", r: "owner", user: { id: "fixture-owner" }
  })));
  await context.route("**/api/admin*", async route => {
    const request = route.request(), url = new URL(request.url());
    const action = url.searchParams.get("action");
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ action, method: request.method(), body, role });
    if (request.method() === "POST") {
      if (action === "default-currency-save") {
        currency = body.currency;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({
          currency, configured: Boolean(currency), supported: Boolean(currency),
          currencies: [{ code: "KES", name: "Kenyan Shilling" }, { code: "EUR", name: "Euro" }],
          changed: true
        }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    let data = {};
    if (action === "role") data = { role };
    else if (action === "policies") data = { policies };
    else if (action === "policy-history") data = { history: [] };
    else if (action === "refund-policy") data = { allocation: "manual_review" };
    else if (action === "payment-controls") data = { enabled: [], providers: [], daraja: {}, paystack: {} };
    else if (action === "paystack-publication-adjustments") data = { adjustments: [] };
    else if (action === "default-currency") data = {
      currency, configured: Boolean(currency), supported: Boolean(currency),
      currencies: [{ code: "KES", name: "Kenyan Shilling" }, { code: "EUR", name: "Euro" }]
    };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  const ownerPage = await context.newPage();
  const errors = [];
  ownerPage.on("pageerror", error => errors.push(error.message));
  await ownerPage.goto(base);
  await ownerPage.locator('[data-tab="fees"]').click();
  await ownerPage.locator("#default-currency-form").waitFor();
  assert.equal(await ownerPage.locator("#platform-default-currency").inputValue(), "KES");
  assert.match(await ownerPage.locator("#default-currency-settings").innerText(), /USD remains the canonical publication-fee currency/);
  ownerPage.on("dialog", dialog => dialog.accept());
  await ownerPage.locator("#platform-default-currency").selectOption("EUR");
  await ownerPage.locator("#default-currency-form button[type=submit]").click();
  await ownerPage.waitForFunction(() => document.getElementById("platform-default-currency")?.value === "EUR");
  const save = calls.find(call => call.action === "default-currency-save");
  assert.deepEqual(save.body, { currency: "EUR", confirmed: true });

  role = "superadmin";
  const adminPage = await context.newPage();
  await adminPage.goto(base);
  await adminPage.locator('[data-tab="fees"]').click();
  await adminPage.locator("#panel").getByRole("heading", { name: "Fees & settings" }).waitFor();
  assert.equal(await adminPage.locator("#default-currency-settings").count(), 0);
  assert.equal(calls.some(call => call.action === "default-currency" && call.method === "GET" && call.role === "superadmin"), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
