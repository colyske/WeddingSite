import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("manual payout leadership UI is explicitly OFF, no legacy sent or accidental operations", { timeout: 180000 }, async () => {
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
    try { browser = await chromium.launch({ channel: "msedge", timeout: 15000 }); } catch { browser = await chromium.launch({ timeout: 15000 }); }
    const page = await browser.newPage();
    page.on("pageerror", error => console.error("Manual operator browser error:", error.message));
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "fixture", r: "superadmin" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    let role = "superadmin", writes = 0, payoutState = "requested", enabled = false, ready = false;
    const policyWrites = [];
    const revision = "550e8400-e29b-41d4-a716-446655440000";
    await page.route("**/api/**", route => {
      if (route.request().method() === "POST") writes++;
      const action = new URL(route.request().url()).searchParams.get("action");
      if (action === "manual-payout-policy") {
        const body = route.request().postDataJSON();
        policyWrites.push(body);
        enabled = body.changes.enabled;
        return route.fulfill({ json: { result: {} } });
      }
      const data = action === "balance" ? { currency: "KES", available_minor: 0, manual: {
        statement_backed_minor: 5000, reserved_minor: payoutState === "paid" ? 0 : 1000,
        spent_minor: payoutState === "paid" ? 1000 : 0, known_obligations_minor: 100, unknown_or_held_minor: 200
      } } : action === "withdrawals" ? { manualWithdrawals: [{
        id: "shared-payout", amount_minor: 1000, currency: "KES", status: payoutState, requested_at: "2026-01-01"
      }], withdrawals: [] } : action === "role" ? { role } : action === "manual-payouts" ? {
        enabled, verification: "Manual evidence attestation; not automatic provider verification",
        readiness: { policy: { revision, enabled, recipient_ids: [] }, history: [],
          blockers: ready ? [] : ["Actual Owner review evidence required"] },
        heldAccounts: [{ id: "incident-1", custody_id: "custody-1", payout_id: "request-1", recorded_at: "2026-01-01" }],
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
    await page.goto(origin + "/admin.html", { waitUntil: "domcontentloaded" });
    await page.locator('button[data-tab="payouts"]').click();
    await page.locator("#manual-payout-control").waitFor();
    assert.match(await page.locator("#manual-payout-control").innerText(), /OFF/);
    assert.match(await page.locator("#manual-payout-control").innerText(), /uncertain/);
    assert.match(await page.locator("#manual-payout-control").innerText(), /existing line exactly and atomically allocates it before paid/);
    assert.equal(await page.locator('[data-manual-action="debit"] input[name="actual"]').count(), 1);
    assert.match(await page.locator("#manual-payout-control [role=alert]").innerText(), /held across both payout channels.*no release or resend/);
    assert.equal(await page.locator('[data-ps="sent"], [data-ps="approved"]').count(), 0);
    assert.equal(await page.locator('[data-manual-action="request"] button').isDisabled(), true);
    assert.equal(await page.locator('[data-manual-action="transition"] option').filter({ hasText: /^executing$/ }).getAttribute("disabled"), "");
    assert.equal(await page.locator('[data-manual-action="transition"] button').isDisabled(), false);
    assert.equal(await page.locator('[data-manual-action="evidence"] button').isDisabled(), false);
    assert.equal(await page.locator('[data-manual-action="receipt"] button').isDisabled(), false);
    assert.equal(await page.locator("#manual-policy").count(), 0);
    assert.equal(await page.locator('[data-manual-action="evidence"] input[value="policy"]').count(), 0);
    assert.equal(writes, 0);
    role = "owner";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('button[data-tab="payouts"]').click();
    await page.locator("#manual-policy").waitFor();
    assert.equal(await page.locator('[data-manual-policy="activate"] button').isDisabled(), true);
    assert.equal(await page.locator('[data-manual-policy="draft"] input[name="payout_fee_minor"]').inputValue(), "");
    assert.equal(await page.locator('[data-manual-policy="draft"] input[name="fee_payer"]').inputValue(), "");
    assert.equal(await page.locator('[data-manual-action="evidence"] option').filter({ hasText: /^policy$/ }).count(), 1);
    const draft = { custody_id: revision, recipient_ids: [revision], per_payout_minor: 10000, daily_minor: 20000,
      payout_fee_minor: 100, fee_payer: "wedding", statement_max_age_minutes: 60,
      review_evidence: revision, fee_evidence: revision, rail_evidence: revision, secure_evidence: revision, enabled: false };
    for (const [field, value] of Object.entries(draft)) {
      if (field !== "enabled") await page.locator(`[data-manual-policy="draft"] input[name="${field}"]`).fill(String(value));
    }
    await page.locator('[data-manual-policy="draft"] input[name="confirmed"]').check();
    await page.locator('[data-manual-policy="draft"] button').click();
    await page.waitForFunction(() => document.querySelector('[data-manual-policy="draft"] input[name="confirmed"]')?.checked === false)
      .catch(async error => { throw new Error(`${error.message}; writes=${JSON.stringify(policyWrites)}; page=${await page.locator("#manual-policy").innerText()}`); });
    assert.deepEqual(policyWrites[0], { revision, changes: draft, confirmed: true });
    ready = true;
    await page.locator('button[data-tab="payouts"]').click();
    await page.locator('[data-manual-policy="activate"] input[name="confirmed"]').check();
    await page.locator('[data-manual-policy="activate"] button').click();
    await page.waitForFunction(() => document.querySelector('[data-manual-action="request"] button')?.disabled === false &&
      document.querySelector('[data-manual-action="request"] fieldset')?.disabled === false);
    assert.deepEqual(policyWrites[1], { revision, changes: { enabled: true }, confirmed: true });
    await page.locator('[data-manual-policy="deactivate"] input[name="confirmed"]').check();
    await page.locator('[data-manual-policy="deactivate"] button').click();
    await page.locator('[data-manual-action="request"] fieldset[disabled]').waitFor({ state: "attached" });
    assert.deepEqual(policyWrites[2], { revision, changes: { enabled: false }, confirmed: true });
    role = "admin";
    await page.reload();
    await page.locator('button[data-tab="operations"]').waitFor();
    assert.equal(await page.locator('button[data-tab="payouts"]').count(), 0);
    const wedding = await readFile(new URL("../wedding.html", import.meta.url), "utf8");
    assert.match(wedding, /<fieldset id="withdrawal-form" disabled/);
    assert.match(wedding, /Independently statement-reconciled payment/);
    assert.match(wedding, /Outcome uncertain; funds held; do not resend/);
    // Exercise the real editor loader/render function with its real DOM targets;
    // no fabricated provider calls or a second implementation of balance logic.
    const loader = wedding.slice(wedding.indexOf("async function loadWithdrawals()"), wedding.indexOf("// Request withdrawal"));
    await page.setContent('<p id="manual-payout-status"></p><span id="balance-display"></span><span id="settling-display"></span><span id="held-display"></span><p id="manual-balance-detail"></p><table><tbody id="withdrawals-body"></tbody></table><p id="no-withdrawals"></p>');
    for (payoutState of ["requested", "uncertain", "paid"]) {
      await page.evaluate(async code => {
        const run = new Function("WS", "$", "weddingId", code + ";return loadWithdrawals();");
        await run(WS, id => document.getElementById(id), "wedding-fixture");
      }, loader);
      const detail = await page.locator("#manual-balance-detail").innerText();
      assert.match(detail, /Estimates are not spendable; requests are staff-controlled/);
      const amount = await page.evaluate(() => WS.money(1000, "KES"));
      assert.ok(detail.includes(`${payoutState === "paid" ? "reconciled spent" : "reserved (including uncertain)"}: ${amount}`));
      assert.match(await page.locator("#withdrawals-body").innerText(),
        payoutState === "paid" ? /Independently statement-reconciled/ : payoutState === "uncertain" ? /Outcome uncertain; funds held/ : /awaiting independent review/);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
