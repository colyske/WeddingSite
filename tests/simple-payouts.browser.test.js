import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

test("simple mobile couple retry and operator Processing reveals transaction ID only after success and after reload", { timeout: 90000 }, async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end('<main id="payouts"></main>');
      if (!["/simple-payouts.js", "/manual-payout-setup.js"].includes(path)) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let rows = [], state = "requested", failRequest = true, failProcessing = true;
    const requests = [], actions = [];
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const row = () => ({ id, amount_minor: 1234, currency: "KES", partner_slot: 1, status: state,
      requested_at: "2026-01-01", claimed_at: state==="processing" || state==="paid" ? "2026-01-02" : null,
      transaction_reference: state==="paid" ? "REAL-TEST-REFERENCE" : null, history: [] });
    await page.route("**/api/**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      if (action === "simple-payout-status") return route.fulfill({ json: { currency: "KES", available_minor: 10000,
        supported: true, kyc_complete: true, recipients: [{ slot: 1, label: "Partner 1 phone ending 0001" }], requests: rows } });
      if (action === "simple-payout-request") {
        requests.push(route.request().postDataJSON());
        if (failRequest) { failRequest = false; return route.fulfill({ status: 503, json: { error: "Synthetic ambiguous request" } }); }
        rows = [row()]; return route.fulfill({ json: { payoutId: id, reserved: true } });
      }
      if (action === "manual-payout-simple") return route.fulfill({ json: { notice: "Operator reporting only",
        weddings: [{ id, label: "Fixture wedding", payouts: { currency: "KES", available_minor: 8766, requests: [row()] } }] } });
      if (action === "manual-payout-simple-action") {
        const body = route.request().postDataJSON(); actions.push(body);
        if (failProcessing) { failProcessing = false; return route.fulfill({ status: 409, json: { error: "Synthetic claim rejected" } }); }
        state = body.action; return route.fulfill({ json: { result: { state } } });
      }
      throw new Error("Unexpected action");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const mount = async mode => page.evaluate(async ({ mode, id }) => {
      const m = await import("/simple-payouts.js");
      const helpers = { api: (url, opts) => fetch(url, opts), money: (n,c) => `${c} ${(n/100).toFixed(2)}`,
        esc: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;") };
      if (mode === "couple") await m.mountCouple(document.querySelector("main"), { ...helpers, weddingId: id });
      else await m.mountAdmin(document.querySelector("main"), { ...helpers, role: "owner" });
    }, { mode, id });
    await mount("couple");
    await page.locator('[name="amount"]').fill("12.34"); await page.locator('[name="partner"]').selectOption("1");
    await page.locator('[name="confirmed"]').check(); await page.getByRole("button", { name: "Request payout", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "ambiguous" }).waitFor();
    assert.equal(await page.locator('[name="amount"]').getAttribute("readonly"), "");
    await page.reload(); await mount("couple");
    assert.equal(await page.locator('[name="amount"]').inputValue(), "12.34");
    await page.locator('[name="confirmed"]').check(); await page.getByRole("button", { name: "Request payout", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "Payout requested" }).waitFor();
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].amountMinor, 1234);
    await mount("admin");
    assert.equal(await page.locator('[name="reference"]').count(), 0);
    await page.getByRole("button", { name: "Processing", exact: true }).click();
    await page.locator('[name="fee"]').fill("1.00"); await page.locator('[name="solo"]').check();
    await page.locator('[name="recipient"]').check(); await page.locator('[name="confirmed"]').check();
    await page.getByRole("button", { name: "Confirm processing", exact: true }).click();
    await page.locator("[data-action-result]").filter({ hasText: "rejected" }).waitFor();
    assert.equal(await page.locator('[name="reference"]').count(), 0, "Failed Processing never exposes Paid input");
    await page.getByRole("button", { name: "Confirm processing", exact: true }).click();
    await page.locator('[name="reference"]').waitFor();
    assert.deepEqual(actions[0], actions[1]); assert.equal(actions[1].fee, 100);
    await page.reload(); await mount("admin");
    await page.locator('[name="reference"]').waitFor();
    assert.equal(await page.locator('[name="reference"]').isVisible(), true);
    await page.locator('[name="reference"]').fill("REAL-TEST-REFERENCE");
    await page.getByRole("button", { name: "Confirm Paid — operator-reported", exact: true }).click();
    assert.equal(actions.length, 2, "Paid needs explicit confirmation");
    await page.locator('[name="confirmed"]').check();
    await page.getByRole("button", { name: "Confirm Paid — operator-reported", exact: true }).click();
    await page.getByRole("heading", { name: /Paid — operator-reported/ }).waitFor();
    assert.equal(actions.at(-1).reference, "REAL-TEST-REFERENCE");
    assert.equal(await page.locator('[name="reference"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
