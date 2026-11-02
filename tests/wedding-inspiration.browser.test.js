import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { chromium } from "playwright";
import "../inspiration-fixtures.js";
import "../currencies.js";
import "../starter-setup.js";
import { showcase } from "../server/showcase.js";

test("safe starter selection, currency review, retry and native shared-editor customization", { timeout: 120000 }, async () => {
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
    async function capture(label) {
      if (!process.env.STARTER_EVIDENCE_DIR) return;
      const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(metrics.scroll <= metrics.width);
      const screenshot = `starter-${label}-${metrics.width}.png`;
      await page.screenshot({ path: `${process.env.STARTER_EVIDENCE_DIR}\\${screenshot}`, fullPage: true });
      evidence.cases.push({ label, ...metrics, screenshot });
    }
    let failCreate = true, capabilitiesFail = false, wedding = null, config = null;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
    await page.route("https://**", route => route.fulfill({ body: "" }));
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url()), action = url.searchParams.get("action");
      let data = {}, status = 200;
      if (action === "list") data = { weddings: [] };
      if (action === "site") data = { wedding: { ...showcase, slug: url.searchParams.get("slug"), is_showcase: false } };
      if (action === "style") {
        data = { style: { ...WSInspiration.publicDesign(["#123456", "#789abc", "#bc9876", "#fefefe"]),
          setup: WSStarterSetup.fictional("garden-gathering", "KES") } };
        if (url.searchParams.get("slug") === "private-wedding") { status = 404; data = { error: "This wedding is not available for public setup reuse." }; }
      }
      if (action === "collection-capabilities") {
        data = { currencies: ["USD", "KES", "EUR", "CAD"].map(code => ({ code, name: code, methods: [{ name: "Mock collection", markets: ["Example market"] }] })) };
        if (capabilitiesFail) { status = 503; data = { error: "Collection capability lookup unavailable." }; }
      }
      if (action === "disclosure") data = { intent_id: "intent-1", enabled: true, rate_basis_points: 100,
        platform_fee_basis_points: 250, platform_fixed_fee_minor: "0", revision: "revision-1", terms_version: "client-referrals-v1" };
      if (action === "create") {
        const body = request.postDataJSON();
        creates.push(body);
        status = failCreate ? 503 : 201;
        data = failCreate ? { error: "Temporary failure - retry your draft." }
          : { weddingId: "550e8400-e29b-41d4-a716-446655440000", slug: "our-own-names" };
        if (!failCreate) {
          config = WSStarterSetup.normalize(body.starterSetup, body.currency);
          wedding = {
            id: data.weddingId, slug: data.slug, couple_names: body.coupleNames, currency: body.currency,
            wedding_date: null, public_location: null, welcome_story: "", cover_image_url: null, guest_instructions: null,
            time_zone: body.timeZone, max_guest_capacity: 150, palette: body.palette, palette_names: [],
            revenue_features: config.features, rsvp_fee_minor: config.rsvp.feeMinor, extra_guest_fee_minor: config.rsvp.extraGuestFeeMinor,
            premium_diet_fee_minor: config.rsvp.premiumDietFeeMinor, premium_diet_options: config.rsvp.premiumDietOptions,
            attire_notes: config.content.attire, published_at: null,
            starter_review_note: config.reviewNote,
            venues: body.venues.map((v, i) => ({ id: `event-${i}`, name: v.name, kind: v.kind, description: v.description,
              event_date: null, event_time: null, address: null, map_link: null, is_main: v.isMain, sort_order: i })),
            registry: config.registry.map((r, i) => ({ id: `gift-${i}`, name: r.name, category: r.category, description: r.description, target_amount_minor: r.targetMinor })),
            tiers: config.tiers.map((t, i) => ({ id: `tier-${i}`, name: t.name, min_amount_minor: t.minimumMinor, perks: t.perks })),
            vip: config.vip ? { title: config.vip.title, description: config.vip.description, seats_total: config.vip.seats, seats_sold: 0, price_minor: config.vip.priceMinor } : null,
            featuredSponsorCampaign: config.featured ? { enabled: false, starts_at: null, closes_at: null,
              slot_count: config.featured.slots, minimum_bid_minor: config.featured.minimumMinor, bid_increment_minor: config.featured.incrementMinor } : null
          };
        }
      }
      if (action === "get") data = { wedding };
      if (action === "quote") data = { quote: { pending_date: true, fee_minor: null, currency: wedding.currency } };
      if (action === "campaigns") data = { currency: wedding.currency, campaigns: config.campaigns.map((c, i) => ({
        id: `goal-${i}`, name: c.name, purpose: c.purpose, enabled: c.enabled, goal_minor: c.goalMinor,
        milestones: c.milestones.map((m, j) => ({ id: `milestone-${j}`, name: m.name, description: m.description, target_minor: m.targetMinor }))
      })), summary: [], rows: [] };
      if (action === "extras-get") data = { travel: config.content.travel, faq: config.content.faq };
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
    await page.locator("#starter-review").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "");
    assert.equal(await page.locator("#starter-currency").inputValue(), "");
    assert.equal(await page.locator("#currency").count(), 0, "no obsolete parallel wizard/form");
    await page.fill("#couple-names", "Our own names");
    await page.click("#create-submit");
    assert.equal(creates.length, 0);
    await page.selectOption("#starter-currency", "EUR");
    await page.locator("#starter-reviewed").check();
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await capture("currency-review");
    }
    await page.click("#create-submit");
    assert.equal(creates.length, 0, "real referral consent remains required");
    await page.selectOption("#client-referral-decision", "accept");
    await page.click("#create-submit");
    await page.locator("#notice").filter({ hasText: /Temporary failure/ }).waitFor();
    assert.equal(creates.length, 1);
    assert.equal(creates[0].starterSetup.reviewed, true);
    assert.equal(Object.hasOwn(creates[0].starterSetup, "amountPresets"), false);
    assert.ok(creates[0].venues.every(v => !v.eventDate && !v.time && !v.address && !v.map));
    await page.reload();
    await page.locator("#starter-currency option[value=EUR]").waitFor({ state: "attached" });
    assert.equal(await page.locator("#couple-names").inputValue(), "Our own names");
    assert.equal(await page.locator("#starter-currency").inputValue(), "EUR");
    await page.locator("#starter-reviewed").check();
    await page.selectOption("#client-referral-decision", "accept");
    failCreate = false;
    await page.evaluate(() => {
      for (let i = 0; i < 2; i++) document.getElementById("create-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForURL("**/wedding.html?*#step=couple");
    assert.equal(creates.length, 2, "double submit creates only one request");
    assert.deepEqual(creates[1], creates[0], "retry preserves full payload and request key");
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Our own names");
    assert.equal(await page.locator("#wedding-date").inputValue(), "");
    assert.equal(await page.locator("#welcome-story").inputValue(), "", "template must not satisfy the real story requirement");
    assert.equal(await page.locator(".tier-name").first().inputValue(), config.tiers[0].name);
    assert.equal(await page.locator(".tier-min-amount").first().inputValue(), "25");
    assert.equal(await page.locator(".cp-goal").first().inputValue(), "1500");
    assert.equal(await page.locator("#vip-price").inputValue(), "25");
    assert.equal(await page.locator("#featured-sponsor-enabled").isChecked(), false);
    assert.equal(await page.locator("#featured-sponsor-starts").inputValue(), "");
    assert.equal(await page.locator("#travel-info").inputValue(), config.content.travel);
    assert.equal(await page.locator("#starter-review-note [data-starter-review-note]").innerText(), config.reviewNote);
    assert.equal(await page.locator(".faq-q").count(), 3);
    await page.locator(".guide-jump > summary").click();
    await page.locator(".guide-nav button").filter({ hasText: "Fundraising & celebration features" }).click();
    await page.locator(".tier-name").first().fill("Our personalized package");
    assert.equal(await page.locator(".tier-name").first().inputValue(), "Our personalized package");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await capture("native-offering-editor");
    }

    await page.goto(`${base}/dashboard.html?style=past-wedding`);
    await page.locator("#starter-review").waitFor();
    await page.selectOption("#starter-currency", "KES");
    assert.match(await page.locator("#starter-summary").innerText(), /KES 2500/);
    await page.selectOption("#starter-currency", "EUR");
    assert.match(await page.locator("#starter-money-disclosure").innerText(), /omitted, not converted/);
    assert.doesNotMatch(await page.locator("#starter-summary").innerText(), /EUR 2500/);
    assert.equal(await page.locator("#starter-reviewed").isChecked(), false);
    await page.fill("#couple-names", "Keep our own names");
    await page.goto(`${base}/dashboard.html?inspiration=coastal-weekend`);
    await page.locator("#apply-inspiration").waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Keep our own names");
    await page.click("#keep-current-answers");
    await page.goto(`${base}/dashboard.html?style=private-wedding`);
    await page.locator("#notice").filter({ hasText: /not available for public setup reuse/ }).waitFor();
    assert.equal(await page.locator("#couple-names").inputValue(), "Keep our own names");
    capabilitiesFail = true;
    await page.click("#starter-capabilities-retry");
    await page.locator("#notice").filter({ hasText: /capability lookup unavailable/ }).waitFor();
    assert.equal(await page.locator("#starter-currency option").count(), 1);
    assert.equal(creates.length, 2);
    capabilitiesFail = false;
    await page.click("#starter-capabilities-retry");
    await page.locator("#starter-currency option[value=EUR]").waitFor({ state: "attached" });
    await page.selectOption("#starter-currency", "EUR");
    await page.locator("#starter-reviewed").check();
    await page.selectOption("#client-referral-decision", "accept");
    await page.click("#create-submit");
    await page.waitForURL("**/wedding.html?*#step=couple");
    await page.locator("#starter-review-note").waitFor();
    assert.equal(creates.length, 3);
    for (const field of ["tiers", "registry", "campaigns"]) assert.deepEqual(creates[2].starterSetup[field], []);
    assert.equal(creates[2].starterSetup.vip, null);
    assert.equal(creates[2].starterSetup.featured, null);
    assert.equal(creates[2].starterSetup.rsvp.fee, "0");
    assert.match(await page.locator("#starter-review-note").innerText(), /source prices were NOT copied into EUR/);
    await page.locator('#starter-review-note a[href="#step=campaigns"]').click();
    assert.equal(await page.locator("[data-guide-step=campaigns]").isVisible(), true);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await capture("omissions-in-shared-wizard");
    }
    for (const slug of ["past-wedding", "current-wedding", "future-wedding"]) {
      await page.goto(`${base}/guest.html?slug=${slug}`);
      await page.locator("#reuse-wedding-style a").waitFor();
    }
    assert.deepEqual(errors, []);
    const unsigned = await browser.newContext();
    const login = await unsigned.newPage();
    await login.route("https://**", route => route.fulfill({ body: "" }));
    await login.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }));
    await login.goto(`${base}/dashboard.html?style=current-wedding`);
    await login.waitForURL("**/signin.html?next=*");
    assert.equal(new URL(login.url()).searchParams.get("next"), "/dashboard.html?style=current-wedding");
    if (process.env.STARTER_EVIDENCE_DIR) {
      for (const name of ["dashboard.js", "dashboard.html", "starter-setup.js", "server\\wedding-style.js", "api\\weddings.js",
        "wedding.html", "supabase\\migrations\\202611090001_wedding_starter_drafts.sql"]) {
        evidence.assets.push({ name, sha256: createHash("sha256").update(await readFile(new URL(`../${name.replaceAll("\\", "/")}`, import.meta.url))).digest("hex") });
      }
      evidence.pageErrors = errors;
      await writeFile(`${process.env.STARTER_EVIDENCE_DIR}\\starter-exact-head-mobile-evidence.json`, JSON.stringify(evidence, null, 2));
    }
    await unsigned.close();
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
