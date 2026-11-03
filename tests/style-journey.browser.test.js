import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";
import "../inspiration-fixtures.js";
import "../currencies.js";
import "../starter-setup.js";
import { showcase } from "../server/showcase.js";
import { publicWeddingStyle } from "../server/wedding-style.js";

const showcaseStyle = await publicWeddingStyle("showcase-wedding");

const WWW = "https://www.joinourwedding.site";
const SHOWCASE = "https://showcase-wedding.joinourwedding.site";
const WEDDING_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER = { id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112", email: "couple@example.test" };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// The real pages on emulated production hosts: root 308s to www, wedding sites are subdomains, APIs are mocked.
function journey(context, scratch = false) {
  const state = { creates: [], reviews: [], wedding: null, capabilityStatus: 503 };
  const api = (route, url) => {
    const request = route.request(), action = url.searchParams.get("action");
    let data = {}, status = 200;
    if (action === "me") data = { user: USER, role: "client" };
    if (action === "google-status") data = { enabled: true };
    if (action === "google-start") {
      const body = request.postDataJSON();
      const authorization = new URL("https://supabase.example/auth/v1/authorize");
      authorization.searchParams.set("provider", "google");
      authorization.searchParams.set("redirect_to", `${WWW}/signin.html?oauth_state=${body.state}`);
      authorization.searchParams.set("code_challenge", body.codeChallenge);
      data = { authorizationUrl: authorization.toString() };
    }
    if (action === "google-exchange") data = { accessToken: "fresh-access-token", refreshToken: "fresh-refresh-token", user: USER, role: "client" };
    if (action === "list") data = { weddings: state.wedding ? [state.wedding] : [], total: state.wedding ? 1 : 0 };
    if (action === "site") data = { wedding: url.searchParams.get("slug") === "our-private-guide" && state.wedding
      ? state.wedding : { ...showcase, slug: "showcase-wedding" } };
    if (action === "style") data = { style: { ...WSInspiration.publicDesign(["#123456", "#789abc", "#bc9876", "#fefefe"]),
      setup: WSStarterSetup.fictional("garden-gathering", "USD") } };
    if (action === "style" && scratch) data = { style: showcaseStyle };
    if (action === "collection-capabilities") { status = state.capabilityStatus; data = { error: "Collection availability is temporarily unavailable." }; }
    if (action === "create") {
      const body = request.postDataJSON();
      state.creates.push(body);
      if (!state.wedding) {
        const config = WSStarterSetup.normalize({ ...body.starterSetup, reviewed: true }, body.starterSetup.currency);
        state.wedding = {
          id: WEDDING_ID, slug: "our-private-guide", couple_names: body.coupleNames, currency: body.currency,
          wedding_date: null, public_location: null, welcome_story: "", time_zone: body.timeZone, max_guest_capacity: 150,
          palette: body.palette, palette_names: [], revenue_features: config.features, rsvp_fee_minor: 0,
          extra_guest_fee_minor: 0, premium_diet_fee_minor: 0, premium_diet_options: config.rsvp.premiumDietOptions,
          published_at: null, starter_pending_setup: config.currency === body.currency ? { ...config, reviewed: false } : null,
          starter_structure: WSStarterSetup.structure(config),
          attire_notes: config.content.attire, travel_info: config.content.travel, faq: config.content.faq,
          starter_review_note: "Source prices and goals are pending review in their original currency; none have been applied.",
          venues: body.venues.map((v, index) => ({ id: `event-${index}`, name: v.name, description: v.description,
            kind: v.kind, is_main: v.isMain, sort_order: index, event_date: null, event_time: null, address: null, map_link: null })),
          registry: [], tiers: [], vip: null, featuredSponsorCampaign: null
        };
      }
      data = { weddingId: WEDDING_ID, slug: "our-private-guide" };
    }
    if (action === "get") data = { wedding: state.wedding };
    if (action === "quote") data = { quote: { pending_date: true, fee_minor: null, currency: state.wedding?.currency } };
    if (action === "campaigns") data = { currency: state.wedding?.currency, campaigns: [], summary: [], rows: [] };
    if (action === "extras-get") data = { travel: state.wedding?.travel_info || "", faq: state.wedding?.faq || [] };
    if (action === "starter-review") {
      state.reviews.push(request.postDataJSON());
      state.wedding = { ...state.wedding, starter_pending_setup: null, starter_review_note: null };
      data = { ok: true, decision: request.postDataJSON().decision };
    }
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  };
  // A predicate (not a "https://**" glob) so cross-host navigations are always intercepted, never sent live.
  return context.route(url => url.protocol === "https:", async route => {
    const url = new URL(route.request().url());
    // Production 308s root to www keeping path/query/hash; Playwright does not route a mocked redirect's
    // follow-up, so emulate it with a same-tab replace to keep every document local.
    if (url.hostname === "joinourwedding.site") return route.fulfill({ contentType: "text/html",
      body: `<!doctype html><script>location.replace("${WWW}" + location.pathname + location.search + location.hash)</script>` });
    if (url.hostname === "supabase.example") {
      const callback = new URL(url.searchParams.get("redirect_to"));
      callback.searchParams.set("code", "test-authorization-code");
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><script>location.replace(${JSON.stringify(callback.toString())})</script>` });
    }
    if (![new URL(WWW).hostname, new URL(SHOWCASE).hostname].includes(url.hostname)) return route.fulfill({ body: "" });
    if (url.pathname.startsWith("/api/")) return api(route, url);
    const file = url.pathname === "/" ? (url.hostname.startsWith("www.") ? "index.html" : "guest.html") : url.pathname.slice(1);
    try {
      if (file.includes("..")) throw new Error("Invalid path");
      return route.fulfill({ contentType: types[extname(file)] || "application/octet-stream", body: await readFile(new URL(`../${file}`, import.meta.url)) });
    } catch { return route.fulfill({ status: 404, body: "" }); }
  }).then(() => state);
}

async function useShowcaseStyle(page) {
  await page.goto(`${SHOWCASE}/`);
  const use = page.locator("#reuse-wedding-style a");
  await use.waitFor();
  assert.equal(await use.getAttribute("target"), null, "Use this style stays in the same tab");
  assert.equal(await use.getAttribute("href"), "https://joinourwedding.site/dashboard.html?style=showcase-wedding#step=couple");
  await use.click();
}

async function reviewInGuide(page, state) {
  await page.waitForURL(`${WWW}/wedding.html?id=${WEDDING_ID}*#step=couple`);
  await page.locator("#guide-heading-couple").waitFor();
  assert.equal(state.creates.length, 1, "exactly one draft is created");
  assert.equal(await page.locator("#couple-names").inputValue(), "", "the couple is asked for their names first");
  assert.doesNotMatch(await page.locator("#notice").innerText(), /could not be verified|currency support/i, "no capability toast");
  await page.evaluate(() => { location.hash = "#step=money"; });
  await page.locator("#guide-heading-money").waitFor();
  await page.locator("#starter-pending-hint").filter({ hasText: /aren't confirmed for your account right now/ }).waitFor();
  assert.equal(await page.locator("#starter-pending-apply").isHidden(), true, "nothing is applied while collection is unconfirmed");
  await Promise.all([page.waitForEvent("load"), page.locator("#starter-pending-omit").click()]);
  await page.locator("#guide-heading-money").waitFor();
  assert.equal(await page.locator("#starter-pending").isHidden(), true);
  assert.deepEqual(Object.keys(state.reviews.at(-1)).sort(), ["currency", "decision", "requestKey", "reviewed", "weddingId"]);
  assert.equal(state.reviews.at(-1).decision, "omit");
}

test("signed-in and signed-out showcase style choices reach the same-tab native guide on the real pages", { timeout: 600000 }, async () => {
  let browser;
  try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
  try {
    // Signed in on www: home -> showcase (same tab) -> Use this style -> root 308 -> real dashboard create -> real guide.
    const signedIn = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: "reduce" });
    const state = await journey(signedIn);
    const page = await signedIn.newPage();
    const errors = [];
    page.on("pageerror", error => { if (new URL(page.url()).hostname.startsWith("www.")) errors.push(error.message); });
    await page.goto(`${WWW}/signin.html`);
    await page.evaluate(user => WS.save({ accessToken: "test-access-token", refreshToken: "test-refresh-token", user, role: "client" }), USER);
    await page.goto(`${WWW}/`);
    const pages = signedIn.pages().length;
    await page.locator(`main a[href^='${SHOWCASE}']`).first().click();
    await page.waitForURL(`${SHOWCASE}/`);
    assert.equal(signedIn.pages().length, pages, "the showcase opens in the same tab");
    await useShowcaseStyle(page);
    await page.waitForURL(url => url.hostname === "www.joinourwedding.site" && url.pathname === "/wedding.html");
    assert.equal(await page.evaluate(() => WS.token()), "test-access-token", "no second sign-in");
    await reviewInGuide(page, state);
    await page.goto(`${WWW}/dashboard.html`);
    await page.locator(`[data-setup-progress="${WEDDING_ID}"]`).waitFor();
    assert.equal(state.creates.length, 1, "returning to the dashboard lists the same draft without creating another");
    assert.deepEqual(errors, []);
    await signedIn.close();

    // Signed out: the choice survives Google sign-in and lands on one new draft in the guide.
    const signedOut = await browser.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: "reduce" });
    const fresh = await journey(signedOut);
    const login = await signedOut.newPage();
    await useShowcaseStyle(login);
    await login.waitForURL(url => url.pathname === "/signin.html");
    assert.equal(new URL(login.url()).hostname, "www.joinourwedding.site");
    assert.equal(new URL(login.url()).searchParams.get("next"), "/dashboard.html?style=showcase-wedding#step=couple");
    assert.equal(fresh.creates.length, 0, "nothing is created before sign-in");
    await login.waitForFunction(() => document.getElementById("google-signin")?.disabled === false);
    await login.click("#google-signin");
    await login.waitForURL(url => url.pathname === "/wedding.html");
    assert.equal(await login.evaluate(() => WS.token()), "fresh-access-token");
    assert.ok(!login.url().includes("access-token"), "tokens never travel in URLs");
    await reviewInGuide(login, fresh);
    assert.equal(await login.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no overflow at 320px");
    await signedOut.close();

    // From scratch uses the real virtual showcase mapping, saved native controls and shared guest renderer.
    const scratchContext = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: "reduce" });
    const defaults = await journey(scratchContext, true);
    const scratch = await scratchContext.newPage();
    await scratch.goto(`${WWW}/signin.html`);
    await scratch.evaluate(user => WS.save({ accessToken: "test-access-token", user, role: "client" }), USER);
    await scratch.goto(`${WWW}/dashboard.html?scratch=showcase#step=couple`);
    await scratch.waitForURL(`${WWW}/wedding.html?id=${WEDDING_ID}*#step=couple`);
    await scratch.locator("#guide-heading-couple").waitFor();
    assert.equal(defaults.creates.length, 1);
    assert.deepEqual(defaults.wedding.palette, showcase.palette, "actual saved palette, not a marketing preview");
    assert.equal(defaults.wedding.venues.length, showcase.venues.length);
    assert.equal(await scratch.locator(".venue-item").count(), showcase.venues.length);
    assert.equal(await scratch.locator(".venue-date").first().inputValue(), "");
    assert.equal(await scratch.locator("#welcome-story").inputValue(), "");
    assert.equal(defaults.wedding.currency, "USD", "unavailable destination support never chooses source KES");
    assert.equal(defaults.wedding.starter_pending_setup, null);
    assert.equal(defaults.wedding.starter_structure.campaigns[0].milestones[0].targetMinor, null);
    await scratch.reload();
    await scratch.locator("#guide-heading-couple").waitFor();
    assert.equal(defaults.creates.length, 1, "saved native draft reload does not create another");
    await scratch.goto(`${WWW}/guest.html?slug=our-private-guide`);
    await scratch.locator("#palette-preview figure").first().waitFor();
    assert.equal(await scratch.locator("#palette-preview figure").count(), 4, "shared guest renderer uses the saved showcase palette");
    assert.equal(defaults.wedding.published_at, null, "renderer verification does not publish the real draft");
    await scratchContext.close();
  } finally {
    await browser?.close();
  }
});
