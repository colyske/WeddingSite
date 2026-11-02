import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import "../inspiration-fixtures.js";
import "../currencies.js";
import "../starter-setup.js";
import { showcase } from "../server/showcase.js";

test("style entry opens unpaid native customization; retries retain the draft and no preflight reviews money", { timeout: 120000 }, async () => {
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
    const page = await context.newPage(), errors = [], creates = [];
    const evidence = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      api: "Mocked APIs only; no provider or Production writes", cases: [], assets: [] };
    if (process.env.STARTER_EVIDENCE_DIR) await mkdir(process.env.STARTER_EVIDENCE_DIR, { recursive: true });
    async function capture(label) {
      if (!process.env.STARTER_EVIDENCE_DIR) return;
      const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.width);
      const screenshot = `starter-${label}-${metrics.width}.png`;
      await page.screenshot({ path: join(process.env.STARTER_EVIDENCE_DIR, screenshot), fullPage: true });
      evidence.cases.push({ label, ...metrics, screenshot });
    }
    let responseLost = true, saved = null, wedding = null, referral = false, capabilityCallsBeforeCreate = 0, styleAvailable = true;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", role: "client" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url()), action = url.searchParams.get("action");
      let data = {}, status = 200;
      if (action === "list") data = { weddings: [] };
      if (action === "site") data = { wedding: { ...showcase, slug: url.searchParams.get("slug"), is_showcase: false } };
      if (action === "style") {
        data = { style: { ...WSInspiration.publicDesign(["#123456", "#789abc", "#bc9876", "#fefefe"]),
          setup: WSStarterSetup.fictional("garden-gathering", "KES") } };
        if (!styleAvailable || url.searchParams.get("slug") === "private-wedding") {
          status = 404; data = { error: "This wedding is not available for public setup reuse." };
        }
      }
      if (action === "collection-capabilities") {
        if (!saved) capabilityCallsBeforeCreate++;
        status = 503; data = { error: "Collection availability is temporarily unavailable." };
      }
      if (action === "disclosure") data = referral
        ? { intent_id: "intent-1", enabled: true, rate_basis_points: 100, platform_fee_basis_points: 250,
          platform_fixed_fee_minor: "0", revision: "revision-1", terms_version: "client-referrals-v1" } : {};
      if (action === "create") {
        const body = request.postDataJSON();
        creates.push(body);
        assert.equal(body.starterDeferred, true);
        assert.equal(body.starterSetup.reviewed, false);
        if (!saved) {
          saved = { weddingId: "550e8400-e29b-41d4-a716-446655440000", slug: "our-private-guide" };
          const config = WSStarterSetup.normalize({ ...body.starterSetup, reviewed: true }, body.currency);
          wedding = {
            id: saved.weddingId, slug: saved.slug, couple_names: body.coupleNames, currency: body.currency,
            wedding_date: null, public_location: null, welcome_story: "", cover_image_url: null, guest_instructions: null,
            time_zone: body.timeZone, max_guest_capacity: 150, palette: body.palette, palette_names: [],
            revenue_features: config.features, rsvp_fee_minor: 0, extra_guest_fee_minor: 0, premium_diet_fee_minor: 0,
            premium_diet_options: config.rsvp.premiumDietOptions, attire_notes: config.content.attire, published_at: null,
            starter_pending_setup: { ...config, reviewed: false },
            starter_review_note: "Source prices and goals are pending review in their original currency; none have been applied.",
            venues: body.venues.map((v, i) => ({ id: `event-${i}`, name: v.name, kind: v.kind, description: v.description,
              event_date: null, event_time: null, address: null, map_link: null, is_main: v.isMain, sort_order: i })),
            registry: [], tiers: [], vip: null, featuredSponsorCampaign: null
          };
        }
        data = saved;
        if (responseLost) { responseLost = false; return route.abort("failed"); }
      }
      if (action === "get") data = { wedding };
      if (action === "quote") data = { quote: { pending_date: true, fee_minor: null, currency: wedding.currency } };
      if (action === "campaigns") data = { currency: wedding.currency, campaigns: [], summary: [], rows: [] };
      if (action === "extras-get") data = wedding.starter_pending_setup.content;
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    });
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const fixture of [null, ...WSInspiration.fixtures]) {
        await page.goto(`${base}/inspiration.html${fixture ? `?style=${fixture.id}` : ""}`);
        assert.equal(await page.locator("form").count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await capture(fixture?.id || "gallery");
      }
    }
    await page.getByRole("link", { name: "Use this style", exact: true }).click();
    await page.locator("#notice").filter({ hasText: /Please try again/ }).waitFor();
    assert.equal(creates.length, 1, "no names/currency/review interstitial before unpaid create");
    assert.equal(creates[0].coupleNames, "");
    assert.equal(creates[0].starterSetup.currency, "USD");
    assert.equal(capabilityCallsBeforeCreate, 0);
    await page.reload();
    await page.waitForURL("**/wedding.html?*#step=couple");
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[1], creates[0], "response-loss/auth reload retries the exact same request key and payload");
    assert.equal(await page.locator("#couple-names").inputValue(), "");
    assert.equal(await page.locator("#wedding-date").inputValue(), "");
    assert.equal(await page.locator("#welcome-story").inputValue(), "");
    assert.equal(wedding.starter_pending_setup.tiers.length > 0, true, "source structure was retained, not dropped");
    assert.equal(wedding.starter_pending_setup.reviewed, false);
    assert.deepEqual(wedding.tiers, []);
    assert.equal(Number(await page.locator("#rsvp-fee").inputValue()), 0);
    assert.deepEqual(await page.evaluate(() => ["COP", "HUF", "IDR", "PKR", "TWD"]
      .map(code => [WSCurrencies.supportsAccounting(code), WSCurrencies.exponent(code)])),
    Array.from({ length: 5 }, () => [true, 2]), "Chromium uses the same accounting list as SQL/Node");
    await page.locator("#couple-names").fill("Our real names");
    assert.equal(await page.locator("#couple-names").inputValue(), "Our real names", "native customization remains available with a capability failure");
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await capture("unpaid-native-guide");
    }
    await page.goto(`${base}/dashboard.html?style=private-wedding`);
    await page.locator("#notice").filter({ hasText: /not available for public setup reuse/ }).waitFor();
    assert.equal(creates.length, 2);
    // A real referral decision remains deliberate, even when style entry auto-continues.
    await page.evaluate(() => { sessionStorage.removeItem("ws-starter-choice"); sessionStorage.removeItem("ws-create-request-key"); });
    referral = true; saved = null; responseLost = true;
    await page.goto(`${base}/dashboard.html?style=past-wedding`);
    await page.locator("#client-referral-disclosure").waitFor();
    assert.equal(creates.length, 2);
    await page.selectOption("#client-referral-decision", "decline");
    await page.click("#create-submit");
    await page.locator("#notice").filter({ hasText: /Please try again/ }).waitFor();
    assert.equal(creates.length, 3);
    styleAvailable = false;
    await page.reload();
    await page.locator("#client-referral-disclosure").waitFor();
    await page.selectOption("#client-referral-decision", "decline");
    await page.click("#create-submit");
    await page.waitForURL("**/wedding.html?*#step=couple");
    assert.equal(creates.length, 4);
    assert.deepEqual(creates[3], creates[2], "owned-draft retry survives source becoming unavailable without creating another draft");
    assert.equal(creates[2].referral.decision, "decline");
    assert.equal(creates[2].starterSetup.currency, "KES", "public source currency is never relabelled");
    assert.deepEqual(errors, []);
    const unsigned = await browser.newContext();
    const login = await unsigned.newPage();
    await login.route("https://**", route => route.fulfill({ body: "" }));
    await login.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }));
    await login.goto(`${base}/dashboard.html?style=current-wedding#step=couple`);
    await login.waitForURL("**/signin.html?next=*");
    assert.equal(new URL(login.url()).searchParams.get("next"), "/dashboard.html?style=current-wedding#step=couple");
    if (process.env.STARTER_EVIDENCE_DIR) {
      for (const name of ["dashboard.js", "dashboard.html", "starter-setup.js", "currencies.js", "api/weddings.js",
        "wedding.html", "supabase/migrations/202611100002_deferred_wedding_starters.sql"]) {
        evidence.assets.push({ name, sha256: createHash("sha256").update(await readFile(new URL(`../${name}`, import.meta.url))).digest("hex") });
      }
      evidence.pageErrors = errors;
      await writeFile(join(process.env.STARTER_EVIDENCE_DIR, "starter-exact-head-mobile-evidence.json"), JSON.stringify(evidence, null, 2));
    }
    await unsigned.close();
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
