import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";
import "../inspiration-fixtures.js";
import "../currencies.js";
import "../starter-setup.js";

const WEDDING_ID = "550e8400-e29b-41d4-a716-446655440000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("the currency step reviews pending style amounts inline without blocking personalization", { timeout: 600000 }, async () => {
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [], reviews = [];
    const pending = { ...WSStarterSetup.normalize({ ...WSStarterSetup.fictional("garden-gathering", "KES"), reviewed: true }, "KES"), reviewed: false };
    let state = { currency: "KES", pending, capabilities: { status: 200, currencies: [{ code: "KES", name: "Kenyan shilling", methods: [{ name: "M-Pesa", markets: ["KE"] }] }] } };
    let reviewResponses = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => location.protocol.startsWith("http") && sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", role: "client" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url()), action = url.searchParams.get("action");
      let data = {}, status = 200;
      const wedding = {
        id: WEDDING_ID, slug: "our-private-guide", couple_names: state.names || "", currency: state.currency, wedding_date: null,
        public_location: null, welcome_story: "", time_zone: "Africa/Nairobi", max_guest_capacity: 150,
        palette: ["#123456"], palette_names: [], revenue_features: pending.features, rsvp_fee_minor: 0,
        extra_guest_fee_minor: 0, premium_diet_fee_minor: 0, published_at: null, venues: [], registry: [], tiers: [],
        vip: null, featuredSponsorCampaign: null, starter_pending_setup: state.pending,
        starter_structure: state.structure || null,
        starter_review_note: state.pending ? "Source prices and goals are pending review in their original currency; none have been applied." : null
      };
      if (action === "get") data = { wedding };
      if (action === "collection-capabilities") { status = state.capabilities.status; data = status === 200 ? { currencies: state.capabilities.currencies } : { error: "Collection availability is temporarily unavailable." }; }
      if (action === "quote") data = { quote: { pending_date: true, fee_minor: null, currency: state.currency } };
      if (action === "campaigns") data = { currency: state.currency, campaigns: [], summary: [], rows: [] };
      if (action === "extras-get") data = pending.content;
      if (action === "update") {
        const body = request.postDataJSON();
        if (body.currency !== state.currency) state = { ...state, currency: body.currency, pending: null };
        state.names = body.coupleNames;
        data = { wedding: { ...wedding, couple_names: state.names, currency: state.currency, starter_pending_setup: state.pending } };
      }
      if (action === "starter-structure") {
        state.structure = request.postDataJSON().structure;
        data = { ok: true, structure: state.structure };
      }
      if (action === "starter-review") {
        reviews.push(request.postDataJSON());
        const next = reviewResponses.shift() || { status: 200, body: { ok: true } };
        if (next.hold) await next.hold;
        if (next.lost) { state = { ...state, pending: null }; return route.abort("failed"); }
        status = next.status; data = next.body;
        if (status === 200) state = { ...state, pending: null };
      }
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    });

    const panel = page.locator("#starter-pending");
    const apply = page.locator("#starter-pending-apply");
    const omit = page.locator("#starter-pending-omit");
    const status = page.locator("#starter-pending-status");

    // Supported, same currency: apply is offered; a 409 stays inline and keeps the draft editable.
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await panel.waitFor();
    await page.waitForFunction(() => !document.getElementById("starter-pending-apply").hidden);
    assert.match(await page.locator("#starter-pending-items").innerText(), /To review: .*sponsor package/);
    assert.match(await apply.textContent(), /Add these KES amounts/);
    reviewResponses = [{ status: 409, body: { error: "Guest-payment collection is not ready in this currency yet." } }];
    await apply.click();
    await status.filter({ hasText: /not ready in this currency yet\. Your draft and answers are safe\./ }).waitFor();
    assert.equal(await panel.isVisible(), true, "a refused review leaves the pending amounts in place");
    assert.equal(await apply.isDisabled(), false, "the couple can retry");
    assert.deepEqual(Object.keys(reviews[0]).sort(), ["currency", "decision", "requestKey", "reviewed", "weddingId"]);
    assert.equal(reviews[0].decision, "apply");
    assert.equal(reviews[0].currency, "KES");
    assert.equal(reviews[0].reviewed, true);
    assert.match(reviews[0].requestKey, UUID);
    await Promise.all([page.waitForEvent("load"), apply.click()]);
    assert.equal(reviews[1].requestKey, reviews[0].requestKey, "a retry replays the same idempotency key");
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(new URL(page.url()).hash, "#step=money", "reload resumes the currency step");
    assert.equal(await panel.isHidden(), true, "once reviewed, the pending panel is gone");

    // Capability lookup fails: no apply, explicit omit still works, personalization continues.
    state = { currency: "KES", pending, capabilities: { status: 503 } };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await panel.waitFor();
    await page.locator("#starter-pending-hint").filter({ hasText: /aren't confirmed for your account right now/ }).waitFor();
    assert.equal(await apply.isHidden(), true);
    assert.equal(await omit.isDisabled(), false);
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=couple`);
    await page.locator("#couple-names").fill("Amani & Wanjiru");
    assert.equal(await page.locator("#couple-names").inputValue(), "Amani & Wanjiru");

    // Unsaved answers elsewhere: deciding is refused calmly, nothing is posted or reloaded.
    const before = reviews.length;
    await page.evaluate(() => { location.hash = "#step=money"; });
    await page.locator("#guide-heading-money").waitFor();
    await omit.click();
    await status.filter({ hasText: /Save your changes first/ }).waitFor();
    assert.equal(reviews.length, before, "no review is sent while answers are unsaved");
    await page.evaluate(() => { location.hash = "#step=couple"; });
    assert.equal(await page.locator("#couple-names").inputValue(), "Amani & Wanjiru", "unsaved answers are kept");

    // An unsaved currency change disables both choices.
    state = { currency: "KES", pending, capabilities: { status: 200, currencies: [{ code: "KES", name: "Kenyan shilling", methods: [{ name: "M-Pesa", markets: ["KE"] }] }, { code: "USD", name: "US dollar", methods: [{ name: "Card", markets: ["US"] }] }] } };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await page.waitForFunction(() => !document.getElementById("starter-pending-apply").hidden);
    await page.locator("#currency").selectOption("USD");
    await page.locator("#starter-pending-hint").filter({ hasText: /Saving a different currency permanently clears/ }).waitFor();
    assert.equal(await apply.isDisabled(), true);
    assert.equal(await omit.isDisabled(), true);

    // The response to an omit is lost after the server applied it: the retry replays the same key.
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await page.waitForFunction(() => !document.getElementById("starter-pending-apply").hidden);
    reviewResponses = [{ lost: true }];
    await omit.click();
    await status.filter({ hasText: /Your draft and answers are safe\./ }).waitFor();
    assert.equal(await omit.isDisabled(), false);
    await Promise.all([page.waitForEvent("load"), omit.click()]);
    assert.deepEqual(reviews.at(-1), reviews.at(-2), "a lost response is retried with an identical payload and key");
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(await panel.isHidden(), true);

    // While an apply is in flight the form is held like a normal save, so a stale form can't overwrite the amounts.
    let release;
    state = { ...state, pending };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await page.waitForFunction(() => !document.getElementById("starter-pending-apply").hidden);
    reviewResponses = [{ status: 200, body: { ok: true, decision: "apply" }, hold: new Promise(resolve => { release = resolve; }) }];
    await apply.click();
    await status.filter({ hasText: /Adding the amounts/ }).waitFor();
    assert.equal(await page.locator("#couple-names").isDisabled(), true, "answers can't be edited mid-apply");
    await Promise.all([page.waitForEvent("load"), release()]);
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(await panel.isHidden(), true);

    // Answers typed while an omit is in flight are kept: no reload, the panel just closes.
    state = { ...state, pending };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await page.waitForFunction(() => !document.getElementById("starter-pending-apply").hidden);
    await page.evaluate(() => { window.__sameDocument = true; });
    reviewResponses = [{ status: 200, body: { ok: true, decision: "omit" }, hold: new Promise(resolve => { release = resolve; }) }];
    await omit.click();
    await status.filter({ hasText: /Leaving the amounts out/ }).waitFor();
    await page.evaluate(() => { location.hash = "#step=couple"; });
    await page.locator("#couple-names").fill("Amani & Wanjiru");
    release();
    await page.locator("#notice").filter({ hasText: /amounts were left out\. Your other answers are still on this page/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__sameDocument), true, "the page was not reloaded");
    assert.equal(await page.locator("#couple-names").inputValue(), "Amani & Wanjiru", "answers typed mid-review are kept");
    assert.equal(await panel.isHidden(), true);
    assert.equal(await page.locator("#starter-review-note").isHidden(), true);

    // Different saved currency: amounts are never converted; only an explicit omit is offered.
    state = { currency: "USD", pending, capabilities: { status: 200, currencies: [{ code: "USD", name: "US dollar", methods: [{ name: "Card", markets: ["US"] }] }] } };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await panel.waitFor();
    await page.locator("#starter-pending-hint").filter({ hasText: /can't be converted or relabelled/ }).waitFor();
    assert.equal(await apply.isHidden(), true);
    await Promise.all([page.waitForEvent("load"), omit.click()]);
    const last = reviews.at(-1);
    assert.equal(last.decision, "omit");
    assert.equal(last.currency, "USD");
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(await panel.isHidden(), true);
    // Amount-free structures are real native editors and survive omission, edits, saves and reloads.
    state = { currency: "KES", pending, structure: WSStarterSetup.structure(pending), capabilities: {
      status: 200, currencies: [{ code: "KES", name: "Kenyan shilling", methods: [{ name: "M-Pesa", markets: ["KE"] }] },
        { code: "USD", name: "US dollar", methods: [{ name: "Card", markets: ["US"] }] }]
    } };
    await page.goto("about:blank");
    await page.goto(`${base}/wedding.html?id=${WEDDING_ID}#step=money`);
    await panel.waitFor();
    await Promise.all([page.waitForEvent("load"), omit.click()]);
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(state.structure.tiers.length, 2);
    await page.evaluate(() => { location.hash = "#step=couple"; });
    await page.locator("#couple-names").fill("Our own couple");
    await page.evaluate(() => { location.hash = "#step=giving"; });
    await page.locator(".tier-name").first().fill("Our editable package");
    assert.equal(await page.locator(".tier-min-amount").first().inputValue(), "");
    assert.equal(await page.locator(".registry-target").first().inputValue(), "");
    assert.equal(await page.locator("#vip-price").inputValue(), "");
    await page.evaluate(() => document.getElementById("edit-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => !document.getElementById("edit-form").dataset.submitting);
    assert.equal(state.structure.tiers[0].name, "Our editable package");
    await page.reload();
    await page.locator("#guide-heading-giving").waitFor();
    assert.equal(await page.locator(".tier-name").first().inputValue(), "Our editable package");
    await page.evaluate(() => { location.hash = "#step=campaigns"; });
    await page.locator(".cp-name").first().waitFor();
    assert.equal(await page.locator(".ms-row").count(), 2);
    assert.equal(await page.locator(".ms-target").first().inputValue(), "");
    // Even nested, newly typed amounts are cleared when the owner chooses a different currency.
    await page.locator(".cp-goal").first().fill("800");
    await page.locator(".ms-target").first().fill("100");
    await page.evaluate(() => { location.hash = "#step=money"; });
    await page.locator("#currency").selectOption("USD");
    assert.equal(await page.locator(".cp-goal").first().inputValue(), "");
    assert.equal(await page.locator(".ms-target").first().inputValue(), "");
    await page.evaluate(() => document.getElementById("edit-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => !document.getElementById("edit-form").dataset.submitting);
    assert.equal(state.currency, "USD");
    assert.equal(state.structure.campaigns[0].milestones[0].targetMinor, null);
    await page.reload();
    await page.locator("#guide-heading-money").waitFor();
    assert.equal(await panel.isHidden(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no overflow at 320px");
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
