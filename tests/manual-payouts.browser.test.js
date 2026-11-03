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
    const reviewWrites = [], intentWrites = [];
    let failReview = true, failIntent = true, intentStatus = "pending", couplePending = false;
    const revision = "550e8400-e29b-41d4-a716-446655440000";
    await page.route("**/api/**", route => {
      if (route.request().method() === "POST") writes++;
      const action = new URL(route.request().url()).searchParams.get("action");
      if (action === "manual-payout-review-intent") {
        reviewWrites.push(route.request().postDataJSON());
        if (failReview) { failReview = false; return route.fulfill({ status: 409, json: { error: "Synthetic retry: refresh evidence" } }); }
        intentStatus = reviewWrites.at(-1).decision;
        return route.fulfill({ json: { result: intentStatus === "declined" ? null : revision } });
      }
      if (action === "manual-payout-intent") {
        intentWrites.push(route.request().postDataJSON());
        if (failIntent) { failIntent = false; return route.fulfill({ status: 503, json: { error: "Synthetic network ambiguity" } }); }
        couplePending = true;
        return route.fulfill({ json: { intentId: revision, reserved: false } });
      }
      if (action === "manual-payout-workspace") return route.fulfill({ json: {
        evidence: [{ id: revision, kind: "statement", submitted_by: revision, checks: [] }],
        accounts: [{ id: revision, provider: "daraja", evidence_id: revision }],
        custody: [{ id: revision, account_reference: revision, provider: "daraja", currency: "KES",
          latest_batch: { id: revision, statement_reference: revision, statement_at: "2026-01-01", closing_minor: 5000, held_minor: 0 } }],
        recipients: [{ id: revision, revision: 1, wedding_id: revision, provider: "daraja", currency: "KES", evidence_id: revision }],
        intents: [{ id: revision, wedding_id: revision, amount_minor: 1200, currency: "KES", status: intentStatus }],
        unreconciledDebits: [{ custody_id: revision, statement_reference: revision, line_reference: revision,
          transaction_reference: "RECEIPT-1", actual_minor: 1000, actual_fee_minor: 100, currency: "KES", booked_at: "2026-01-01T10:00:00.123456+00:00" }],
        requests: [{ id: "request-1", claim: { sender_id: revision, claimed_at: "2026-01-01", channel: "manual_external" } },
          { id: "reported-1", custody_id: revision, provider: "daraja", account_reference: revision,
            receipt: { transaction_reference: "RECEIPT-1" } }, { id: "automatic-1", automatic: true }]
      } });
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
      }], manualIntents: couplePending ? [{ id: revision, amount_minor: 1200, currency: "KES", status: "pending", requested_at: "2026-01-01" }] : [],
      withdrawals: [] } : action === "role" ? { role } : action === "manual-payouts" ? {
        enabled, verification: "Manual evidence attestation; not automatic provider verification",
        readiness: { policy: { revision, enabled, recipient_ids: [] }, history: [],
          blockers: ready ? [] : ["Actual Owner review evidence required"] },
        heldAccounts: [{ id: "incident-1", custody_id: "custody-1", payout_id: "request-1", recorded_at: "2026-01-01" }],
        blockers: ["Separate activation required"], requests: [{
          id: "request-1", state: "uncertain", amount_minor: 1000, currency: "KES", recipient_revision: "opaque-revision",
          events: [{ state: "executing", actor_id: "sender-1", evidence_id: null }]
        }, { id: "reported-1", state: "reported", amount_minor: 1000, currency: "KES", events: [] },
          { id: "automatic-1", state: "approved", amount_minor: 1000, currency: "KES", events: [] }]
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
    assert.match(await page.locator("#manual-workspace").innerText(), /Couple requests for staff review/);
    assert.match(await page.locator("#manual-payout-control").innerText(), /Automatic-channel record: read-only/);
    await page.getByRole("button", { name: "Prepare reconciliation", exact: true }).click();
    assert.equal(await page.locator('[data-manual-action="reconcile"] input[name="at"]').inputValue(), "2026-01-01T10:00:00.123456Z");
    assert.equal(await page.locator('[data-manual-action="reconcile"] input[name="line"]').inputValue(), revision);
    assert.equal(writes, 0, "Prefill is read-only");
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
    assert.deepEqual(await page.locator('[data-manual-policy="draft"]').evaluate(form =>
      [...form.elements].filter(input => !input.validity.valid).map(input => ({
        name: input.name, type: input.type, message: input.validationMessage
      }))), []);
    await page.locator('[data-manual-policy="draft"] button').click();
    await page.waitForFunction(() => document.querySelector('[data-manual-policy="draft"] input[name="confirmed"]')?.checked === false)
      .catch(async error => { throw new Error(`${error.message}; writes=${JSON.stringify(policyWrites)}; notice=${await page.locator("#notice").textContent()}`); });
    assert.deepEqual(policyWrites[0], { revision, changes: draft, confirmed: true });
    ready = true;
    await page.locator('button[data-tab="payouts"]').click();
    await page.locator('[data-manual-policy="activate"] input[name="confirmed"]').check();
    await page.locator('[data-manual-policy="activate"] button').click();
    await page.waitForFunction(() => document.querySelector('[data-manual-action="request"] button')?.disabled === false &&
      document.querySelector('[data-manual-action="request"] fieldset')?.disabled === false);
    assert.deepEqual(policyWrites[1], { revision, changes: { enabled: true }, confirmed: true });
    await page.getByRole("button", { name: "Prepare staff review", exact: true }).click();
    const reviewForm = page.locator('[data-manual-action="review-intent"]');
    const reviewKey = await reviewForm.locator('[name="key"]').inputValue();
    assert.match(reviewKey, /^[0-9a-f-]{36}$/);
    await page.getByRole("button", { name: "Prepare staff review", exact: true }).click();
    assert.equal(await reviewForm.locator('[name="key"]').inputValue(), reviewKey);
    for (const field of ["custody", "recipient"]) await reviewForm.locator(`[name="${field}"]`).fill(revision);
    await reviewForm.locator('[name="fee"]').fill("0");
    await reviewForm.locator('[name="owner_solo"]').check();
    await reviewForm.locator('[name="confirmed"]').check();
    await reviewForm.locator("button").click();
    await page.getByText("Synthetic retry: refresh evidence", { exact: true }).waitFor();
    assert.equal(await reviewForm.locator('[name="key"]').inputValue(), reviewKey);
    assert.equal(await reviewForm.locator("button").isDisabled(), false);
    await reviewForm.locator("button").click();
    await page.locator("#manual-last-result").filter({ hasText: "review-intent recorded" }).waitFor();
    assert.equal(reviewWrites.length, 2);
    assert.deepEqual(reviewWrites[1], reviewWrites[0]);
    assert.equal(reviewWrites[0].fee, 0);
    assert.equal(reviewWrites[0].owner_solo, true);
    assert.equal(reviewWrites[0].id, revision);
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
    const loader = wedding.slice(wedding.indexOf("async function loadWithdrawals()"), wedding.indexOf("// Couple request intent"));
    const coupleForm = wedding.slice(wedding.indexOf('<form id="manual-intent-form">'), wedding.indexOf('<fieldset id="withdrawal-form"'));
    await page.setContent(coupleForm + '<p id="manual-payout-status"></p><span id="balance-display"></span><span id="settling-display"></span><span id="held-display"></span><p id="manual-balance-detail"></p><table><tbody id="withdrawals-body"></tbody></table><p id="no-withdrawals"></p>');
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
    const submitter = wedding.slice(wedding.indexOf("// Couple request intent"), wedding.indexOf("// Request withdrawal"));
    await page.evaluate(code => {
      new Function("WS", "$", "weddingId", "notice", code)(
        WS, id => document.getElementById(id), "wedding-fixture", message => { throw new Error(message); });
    }, submitter + "\n" + loader);
    const couple = page.locator("#manual-intent-form");
    assert.equal(await couple.locator('input:not([type="checkbox"])').count(), 1);
    await couple.locator('[name="amountMinor"]').fill("1200");
    await couple.locator('[name="confirmed"]').check();
    await couple.locator("button").click();
    await page.locator("#manual-intent-result").filter({ hasText: "Synthetic network ambiguity" }).waitFor();
    assert.equal(await couple.locator('[name="amountMinor"]').getAttribute("readonly"), "");
    await couple.locator("button").click();
    await page.locator("#manual-intent-history").filter({ hasText: "Awaiting staff review; no funds reserved" }).waitFor();
    assert.equal(await couple.locator("button").isDisabled(), true);
    assert.equal(intentWrites.length, 2);
    assert.deepEqual(intentWrites[1], intentWrites[0]);
    assert.match(intentWrites[0].key, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(intentWrites[0]).sort(), ["amountMinor", "confirmed", "key"]);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
