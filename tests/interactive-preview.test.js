import test from "node:test";
import assert from "node:assert/strict";
import weddings from "../api/weddings.js";
import { interactivePreview, creationFundPreset, permanentFeatures } from "../server/interactive-preview.js";
import { publicWeddingStyle } from "../server/wedding-style.js";
import { interactiveStarter } from "../server/interactive-starter.js";
import { showcase, showcaseFundraising, showcaseExtras } from "../server/showcase.js";

const owner = "550e8400-e29b-41d4-a716-446655440000";
const id = "550e8400-e29b-41d4-a716-446655440001";
test("preview projection contains no private workspace data or invented activity", () => {
  const bundle = interactivePreview({
    id, currency: "EUR", interactive_creation: true, client_owner_id: owner,
    payout: { fields: { account: "PRIVATE" } }, kyc: { id_number: "PRIVATE" },
    moderation: { note: "PRIVATE" }, starter_pending_setup: { secret: "PRIVATE" },
    venues: [{ name: "Our venue", address: "Public address", private_note: "PRIVATE" }],
    registry: [{ name: "Gift", target_amount_minor: 1200, amount_raised_minor: 99999 }],
    vip: { title: "VIP", seats_total: 12, seats_sold: 5, price_minor: 2300 },
    revenue_features: { giving: false }
  });
  assert.equal(JSON.stringify(bundle).includes("PRIVATE"), false);
  assert.deepEqual(bundle.site.wedding.revenue_features, permanentFeatures);
  assert.equal(bundle.fundraising.campaigns.length, 1);
  assert.equal(bundle.fundraising.campaigns[0].goal_minor, null);
  assert.equal(bundle.site.wedding.registry[0].amount_raised_minor, 0);
  assert.equal(bundle.fundraising.vip.seats_sold, 0);
  assert.deepEqual(bundle.leaderboard.bids, []);
  assert.deepEqual(bundle.ledger.ledger, []);
  assert.equal(creationFundPreset("KES"), 50000000);
  assert.equal(creationFundPreset("EUR"), null);
  assert.equal(creationFundPreset("EUR", { currency: "EUR", campaigns: [{ goalMinor: 12300 }] }), 12300);
  assert.equal(creationFundPreset("EUR", { currency: "KES", campaigns: [{ goalMinor: 12300 }] }), null);
});

test("interactive create uses the transactional initializer, stable key, blank draft and permanent flags", async () => {
  const oldFetch = globalThis.fetch;
  const env = Object.fromEntries(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" });
  const calls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, body });
    const result = url.pathname === "/auth/v1/user" ? { id: owner }
      : url.pathname.endsWith("/create_interactive_wedding") ? { weddingId: id, slug: "wedding" } : [];
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const style = await publicWeddingStyle("showcase-wedding");
    const body = { requestKey: id, coupleNames: "", currency: "EUR", styleSlug: "showcase-wedding",
      interactiveCreation: true, starterDeferred: true, starterSetup: style.setup };
    const response = { status(code) { this.code = code; return this; }, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await weddings({ method: "POST", headers: { authorization: "Bearer fixture" }, query: { action: "create" }, body }, response);
    assert.equal(response.code, 201);
    const create = calls.find(call => call.path.endsWith("/create_interactive_wedding"));
    assert.equal(create.body.p_request_key, id);
    assert.equal(create.body.p_input.currency, "EUR");
    assert.equal(create.body.p_input.coupleNames, "");
    assert.deepEqual(create.body.p_input.starterSetup.features, permanentFeatures);
    assert.equal(create.body.p_input.starterSetup.content.travel, showcaseExtras.travel);
    assert.deepEqual(create.body.p_input.starterSetup.content.faq, showcaseExtras.faq);
    assert.equal(create.body.p_input.starterSetup.registry[0].description, showcase.registry[0].description);
    assert.equal(create.body.p_input.starterSetup.tiers[0].perks, showcaseFundraising.tiers[0].perks);
    assert.equal(create.body.p_input.starterSetup.vip.description, showcaseFundraising.vip.description);
    assert.equal(create.body.p_input.starterSetup.campaigns[0].purpose, showcaseFundraising.campaigns[0].purpose);
    assert.equal(create.body.p_input.venues.length, showcase.venues.length);
    assert.equal(create.body.p_input.venues.every(item => !item.eventDate && item.address.startsWith("Sample venue:")), true);
    assert.equal(create.body.p_input.welcomeStory.includes("[Partner one]"), true);
    assert.equal(create.body.p_input.weddingDate, null);
    assert.equal(calls.some(call => /collection|checkout|payment/.test(call.path)), false);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("full fictional editorial placeholders exclude identities and activity; wording is plain-text allowlisted", async () => {
  const style = await publicWeddingStyle("showcase-wedding");
  const seed = interactiveStarter(globalThis.WSStarterSetup.normalize({ ...style.setup, reviewed: true }, "KES"));
  const structure = globalThis.WSStarterSetup.structure(seed.setup);
  const preview = interactivePreview({ interactive_creation: true, starter_structure: structure }, [{
    id, name: "Saved goal", goal_minor: 10000,
    milestones: [{ name: "First stage", target_minor: 5000, reached: true, private_note: "SECRET" }]
  }]);
  assert.equal(preview.fundraising.campaigns.length, 2, "priced and unpriced goal structures are both visible");
  assert.equal(preview.fundraising.campaigns[0].milestones[0].reached, false);
  assert.equal(preview.fundraising.campaigns[1].milestones[0].name, showcaseFundraising.campaigns[0].milestones[0].name);
  assert.equal(preview.fundraising.draftVip.title, showcaseFundraising.vip.title);
  assert.equal("seats_total" in preview.fundraising.draftVip, false);
  assert.equal(preview.site.wedding.registry[0].amount_raised_minor, 0);
  assert.deepEqual(preview.fundraising.sponsors, []);
  assert.equal(JSON.stringify(preview).includes("SECRET"), false);
  assert.equal(JSON.stringify(seed).includes("Azure Bloom Studio"), false);
  assert.equal(JSON.stringify(seed).includes("contact_email"), false);
  assert.deepEqual(globalThis.WSWeddingContent.normalize({ "story:0": "", "welcome:1": "Our next chapter" }),
    { "story:0": "", "welcome:1": "Our next chapter" });
  assert.throws(() => globalThis.WSWeddingContent.normalize({ private: "not allowed" }));
});

test("real preview handler requires authorization, owner filtering and read-only no-store projection", async () => {
  const previous = { ...process.env }, oldFetch = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" });
  const calls = [];
  let owned = true;
  let savedFunds = [{ id, name: "Celebration", goal_minor: 50000000, raised_minor: 9999, milestones: [] }];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    const json = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/auth/v1/user") return json({ id: owner });
    if (url.pathname === "/rest/v1/weddings") {
      assert.equal(url.searchParams.get("client_owner_id"), `eq.${owner}`);
      return json(owned ? [{ id, currency: "KES", couple_names: "A & B", interactive_creation: true, payout: "PRIVATE" }] : []);
    }
    if (url.pathname.endsWith("/save_interactive_fundraising_campaigns")) {
      savedFunds = JSON.parse(options.body).p_payload;
      return json(null);
    }
    if (url.pathname === "/rest/v1/fundraising_streams" && url.searchParams.has("enabled")) return json(savedFunds);
    if (url.pathname === "/rest/v1/fundraising_milestones") return json(savedFunds.flatMap(fund =>
      fund.milestones.map(item => ({ ...item, stream_id: fund.id, reached: true, internal_note: "PRIVATE" }))));
    return json([]);
  };
  const run = async (headers, action = "preview", body) => {
    const res = { statusCode: 0, headers: {}, status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; }, json(body) { this.body = body; }, end(text) { this.body = JSON.parse(text); } };
    await weddings({ method: body ? "POST" : "GET", headers, query: { action, weddingId: id }, body }, res);
    return res;
  };
  try {
    assert.equal((await run({})).statusCode, 401);
    const res = await run({ authorization: "Bearer fixture" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Cache-Control"], /no-store/);
    assert.equal(res.body.fundraising.campaigns[0].raised_minor, 0);
    assert.equal(JSON.stringify(res.body).includes("PRIVATE"), false);
    assert.equal(calls.some(({ url }) => /visits|contributions|kyc|checkout/.test(url.pathname)), false);
    const saved = await run({ authorization: "Bearer fixture-owner-token" }, "campaigns-save", {
      weddingId: id, currency: "KES", campaigns: [{ id, name: "Our saved goal", purpose: "Our plans", goal: "1200",
        milestones: [{ id, name: "Our saved milestone", description: "Our stage", target: "500" }] }]
    });
    assert.equal(saved.statusCode, 200);
    const reloaded = await run({ authorization: "Bearer fixture-owner-token" });
    assert.deepEqual(reloaded.body.fundraising.campaigns[0].milestones, [{
      id, name: "Our saved milestone", description: "Our stage", target_minor: 50000, reached: false
    }]);
    assert.equal(reloaded.body.fundraising.campaigns[0].raised_minor, 0);
    assert.equal(JSON.stringify(reloaded.body).includes("PRIVATE"), false);
    owned = false;
    assert.equal((await run({ authorization: "Bearer fixture" })).statusCode, 404);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
