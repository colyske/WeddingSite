import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";
import "../inspiration-fixtures.js";
import { showcase } from "../server/showcase.js";

test("inspiration gallery, safe customizable wizard, retry, tab preservation, public design and sign-in continuity", { timeout: 120000 }, async () => {
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
    const context = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [], creates = [];
    let failCreate = true;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/**", route => {
      const request = route.request();
      const url = new URL(request.url());
      const action = url.searchParams.get("action");
      let data = {}, status = 200;
      if (action === "list") data = { weddings: [] };
      if (action === "site") data = { wedding: { ...showcase, slug: url.searchParams.get("slug"), is_showcase: false } };
      if (action === "style") {
        data = { style: globalThis.WSInspiration.publicDesign(["#123456", "#789abc", "#bc9876", "#fefefe"]) };
        if (url.searchParams.get("slug") === "private-wedding") { status = 404; data = { error: "This wedding is not available for public design reuse." }; }
      }
      if (action === "disclosure") data = { intent_id: "intent-1", enabled: true, rate_basis_points: 100,
        platform_fee_basis_points: 250, platform_fixed_fee_minor: "0", revision: "revision-1", terms_version: "client-referrals-v1" };
      if (action === "create") {
        creates.push(request.postDataJSON());
        status = failCreate ? 503 : 201;
        data = failCreate ? { error: "Temporary failure - retry your draft." }
          : { weddingId: "550e8400-e29b-41d4-a716-446655440000", slug: "our-own-names" };
      }
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(`${base}/inspiration.html`);
    assert.equal(await page.locator(".inspiration-card").count(), 3);
    assert.match(await page.locator(".inspiration-disclosure").innerText(), /not customers/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const fixture of globalThis.WSInspiration.fixtures) {
      await page.goto(`${base}/inspiration.html?style=${fixture.id}`);
      assert.equal(await page.locator("#inspiration-gallery").isVisible(), false);
      assert.match(await page.locator("#inspiration-preview").innerText(), new RegExp(fixture.names));
      assert.equal(await page.locator(".inspiration-event").count(), fixture.events.length);
      assert.equal(await page.locator("form").count(), 0, "preview has no payment, RSVP or messaging surface");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.getByRole("link", { name: "Use this style", exact: true }).click();
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "");
    assert.equal(await page.locator("#wedding-date").inputValue(), "");
    assert.equal(await page.locator("#location").inputValue(), "");
    assert.equal(await page.locator("#currency").inputValue(), "", "currency must be explicitly chosen, never inherited");
    assert.equal(await page.locator('[data-venue-field="name"]').first().inputValue(), "Evening ceremony");
    for (const field of ["time", "eventDate", "address", "map"]) {
      assert.ok((await page.locator(`[data-venue-field="${field}"]`).evaluateAll(inputs => inputs.map(input => input.value))).every(value => value === ""));
    }
    assert.equal(creates.length, 0, "selecting a style never creates a wedding");
    await page.fill("#couple-names", "Our own names");
    await page.click("#create-submit");
    assert.equal(creates.length, 0, "currency is mandatory for a style starter");
    await page.selectOption("#currency", "EUR");
    await page.click("#create-submit");
    assert.equal(creates.length, 0, "real referral consent is still required");
    await page.selectOption("#client-referral-decision", "accept");
    await page.click("#create-submit");
    await page.waitForFunction(() => document.getElementById("notice").textContent.includes("Temporary failure"));
    assert.equal(creates.length, 1);
    assert.equal(creates[0].currency, "EUR");
    assert.equal(creates[0].inspirationId, "city-evening");
    assert.equal(creates[0].weddingDate, null);
    assert.equal(creates[0].location, "");
    assert.equal(creates[0].referral.decision, "accept");
    assert.deepEqual(creates[0].palette, globalThis.WSInspiration.get("city-evening").palette);
    await page.reload();
    await page.locator("#guide-heading-couple").waitFor({ state: "attached" });
    assert.equal(await page.locator("#couple-names").inputValue(), "Our own names");
    assert.equal(await page.locator("#currency").inputValue(), "EUR");
    await page.selectOption("#client-referral-decision", "accept");
    failCreate = false;
    await page.click("#create-submit");
    await page.waitForFunction(() => document.getElementById("created").hidden === false);
    assert.equal(creates.length, 2);
    assert.equal(creates[1].requestKey, creates[0].requestKey, "reload/retry keeps the idempotency key");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-create-answers")), null);

    await page.goto(`${base}/dashboard.html?inspiration=garden-gathering`);
    await page.locator("#guide-heading-couple").waitFor();
    await page.fill("#couple-names", "Keep these answers");
    await page.click("[data-guide-keep]");
    await page.goto(`${base}/dashboard.html?inspiration=coastal-weekend`);
    await page.locator("#apply-inspiration").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Keep these answers");
    await page.click("#keep-current-answers");
    assert.equal(await page.locator("#couple-names").inputValue(), "Keep these answers");
    await page.goto(`${base}/dashboard.html?style=past-wedding`);
    await page.locator("#apply-inspiration").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Keep these answers");
    await page.click("#apply-inspiration");
    assert.equal(await page.locator("#couple-names").inputValue(), "");
    assert.equal(await page.locator("#currency").inputValue(), "");
    assert.equal(await page.locator('[data-venue-field="name"]').first().inputValue(), "Your ceremony");
    assert.match(await page.locator("#inspiration-selection-copy").innerText(), /Public visibility is not permission/);
    await page.fill("#couple-names", "Still ours");
    await page.click("[data-guide-keep]");
    await page.goto(`${base}/dashboard.html?style=private-wedding`);
    await page.locator("#notice").filter({ hasText: /not available for public design reuse/ }).waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Still ours");
    await page.goto(`${base}/dashboard.html?inspiration=unknown-client`);
    await page.locator("#notice").filter({ hasText: /That inspiration style is unavailable/ }).waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Still ours");
    for (const slug of ["past-wedding", "current-wedding", "future-wedding"]) {
      await page.goto(`${base}/guest.html?slug=${slug}`);
      const link = page.locator("#reuse-wedding-style a");
      await link.waitFor();
      assert.equal(await link.getAttribute("href"), `/dashboard.html?style=${slug}#step=couple`);
      assert.match(await page.locator("#reuse-wedding-style").innerText(), /Public visibility is not permission/);
    }
    await page.goto(`${base}/guest.html?slug=private-wedding`);
    await page.waitForFunction(() => document.getElementById("couple-names").textContent === "Amara & Kito (sample)");
    assert.equal(await page.locator("#reuse-wedding-style").isVisible(), false);
    assert.deepEqual(errors, []);

    // A separate unsigned device follows a platform-safe return destination.
    const unsigned = await browser.newContext();
    const login = await unsigned.newPage();
    await login.route("https://**", route => route.fulfill({ body: "" }));
    await login.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }));
    await login.goto(`${base}/dashboard.html?style=current-wedding#step=couple`);
    await login.waitForURL("**/signin.html?next=*");
    assert.equal(new URL(login.url()).searchParams.get("next"), "/dashboard.html?style=current-wedding#step=couple");
    await unsigned.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
