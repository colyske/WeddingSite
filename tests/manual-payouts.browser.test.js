import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("manual payout leadership UI is explicitly OFF, no legacy sent or accidental operations", { timeout: 60000 }, async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const body = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "fixture", r: "superadmin" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    let role = "superadmin", writes = 0;
    await page.route("**/api/**", route => {
      if (route.request().method() === "POST") writes++;
      const action = new URL(route.request().url()).searchParams.get("action");
      const data = action === "role" ? { role } : action === "manual-payouts" ? {
        enabled: false, verification: "Manual evidence attestation; not automatic provider verification",
        blockers: ["Separate activation required"], requests: [{
          id: "request-1", state: "uncertain", amount_minor: 1000, currency: "KES", recipient_revision: "opaque-revision",
          events: [{ state: "executing", actor_id: "sender-1", evidence_id: null }]
        }]
      } : action === "payouts" ? { payouts: [{ id: "legacy-1", wedding_id: "wedding-1",
        amount_minor: 1000, currency: "KES", status: "approved", couple_names: "Fixture couple" }] } :
        action === "overview" ? {} : { queue: [], adjustments: [], cases: [] };
      return route.fulfill({ json: data });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + "/admin.html");
    await page.locator('[data-tab="payouts"]').click();
    await page.locator("#manual-payout-control").waitFor();
    assert.match(await page.locator("#manual-payout-control").innerText(), /OFF/);
    assert.match(await page.locator("#manual-payout-control").innerText(), /uncertain/);
    assert.equal(await page.locator('[data-ps="sent"], [data-ps="approved"]').count(), 0);
    assert.equal(await page.locator('[data-manual-action="request"] button').isDisabled(), true);
    assert.equal(await page.locator('[data-manual-action="transition"] button').isDisabled(), true);
    assert.equal(await page.locator('[data-manual-action="evidence"] input[value="policy"]').count(), 0);
    assert.equal(writes, 0);
    role = "admin";
    await page.reload();
    await page.locator('[data-tab="operations"]').waitFor();
    assert.equal(await page.locator('[data-tab="payouts"]').count(), 0);
    const wedding = await readFile(new URL("../wedding.html", import.meta.url), "utf8");
    assert.match(wedding, /<fieldset id="withdrawal-form" disabled/);
    assert.match(wedding, /Independently statement-reconciled payment/);
    assert.match(wedding, /Outcome uncertain; funds held; do not resend/);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
