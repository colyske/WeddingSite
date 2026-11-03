import test from "node:test";
import assert from "node:assert/strict";
import "../inspiration-fixtures.js";
import guest from "../api/guest.js";
import weddings from "../api/weddings.js";
import { paystackCredentialFingerprint } from "../server/paystack.js";

const inspiration = globalThis.WSInspiration;
test("fictional inspiration is immutable and starters have an explicit safe allowlist", () => {
  assert.equal(inspiration.fixtures.length, 3);
  assert.equal(new Set(inspiration.fixtures.map(item => item.palette.join())).size, 3);
  for (const item of inspiration.fixtures) {
    assert.equal(item.classification, "author-owned-fictional-inspiration");
    assert.ok(Object.isFrozen(item.events));
    assert.ok(item.welcome && item.attire && item.travel && item.faq.length >= 3);
    const starter = inspiration.starter(item.id);
    assert.deepEqual(Object.keys(starter).sort(), ["palette", "venues"]);
    assert.deepEqual(starter.palette, item.palette);
    assert.equal(starter.venues.length, item.events.length);
    assert.equal(starter.venues.filter(event => event.isMain).length, 1);
    for (const event of starter.venues) {
      assert.deepEqual(Object.keys(event).sort(), ["address", "description", "eventDate", "isMain", "kind", "map", "name", "time"]);
      for (const key of ["time", "eventDate", "address", "map"]) assert.equal(event[key], "");
      assert.match(event.description, /^Sample wording - personalize:/);
    }
    assert.equal(JSON.stringify(starter).includes(item.names), false);
    starter.palette[0] = "#000000";
    assert.notEqual(item.palette[0], "#000000");
  }
  assert.equal(inspiration.get("ordinary-client"), null);
  assert.throws(() => inspiration.starter("ordinary-client"), /listed fictional/);
});

test("public design extraction rejects invalid colours and includes only generic prompts", () => {
  const design = inspiration.publicDesign(["#112233"]);
  assert.deepEqual(Object.keys(design).sort(), ["classification", "palette", "venues"]);
  assert.equal(design.palette.length, 4);
  assert.equal(design.classification, "public-design-only");
  assert.deepEqual(design.venues.map(event => event.name), ["Your ceremony", "Your reception"]);
  assert.throws(() => inspiration.publicDesign(["red; background:url(unsafe)"]), /cannot be reused/);
});

test("style endpoints allowlist public configuration, stage only current currencies, and replay atomically", async () => {
  const env = {
    SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    WEDDINGSITE_PAYMENT_MODE: "live", PAYSTACK_SECRET_KEY: "sk_live_fixture", PAYSTACK_MERCHANT_ID: "12345",
    PAYSTACK_LIVE_MERCHANT_CONFIRMED: "12345", PAYSTACK_LIVE_COLLECTION_ENABLED: "true",
    PAYSTACK_RECONCILIATION_ENABLED: "true", PAYSTACK_SUPPORTED_CURRENCIES: "USD", PAYSTACK_SUPPORTED_MARKETS: "US"
  };
  const names = Object.keys(env);
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, env);
  const oldFetch = globalThis.fetch;
  const calls = [];
  const creates = new Map();
  let existingDraft = null;
  let staged = null, capabilityFailure = false;
  const key = "550e8400-e29b-41d4-a716-446655440002";
  const owner = "550e8400-e29b-41d4-a716-446655440000";
  const referral = { intentId: owner, revision: key, decision: "accept", termsVersion: "client-referrals-v1" };
  const response = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.pathname === "/auth/v1/user") return response({ id: owner });
    if (url.pathname === "/rest/v1/platform_policies") return capabilityFailure
      ? new Response(JSON.stringify({ message: "Capability lookup unavailable." }), { status: 503 })
      : response([{ enabled_payment_providers: ["paystack"] }]);
    if (url.pathname === "/rest/v1/paystack_live_policy") return response([{
      approved: true, merchant_id: "12345", credential_fingerprint: paystackCredentialFingerprint(),
      settlement_mode: "standard", standard_enabled: true, capabilities: [{ currency: "USD", market: "US" }]
    }]);
    if (url.pathname === "/rest/v1/rpc/stage_wedding_starter_capability") {
      assert.equal(options.headers.apikey, "service", "only backend service role may stage capability proof");
      assert.equal(body.p_owner, owner);
      assert.equal(body.p_request_key, key);
      assert.equal(body.p_input.currency, "USD");
      staged = body.p_input;
      return response(null);
    }
    if (url.pathname === "/rest/v1/weddings") {
      assert.equal(options.method, "GET");
      assert.equal(url.searchParams.get("select"), "id,palette,currency,revenue_features,rsvp_fee_minor,extra_guest_fee_minor,premium_diet_fee_minor,premium_diet_options", "only public configuration may be read");
      assert.equal(url.searchParams.get("published_at"), "not.is.null");
      assert.equal(url.searchParams.get("archived_at"), "is.null");
      assert.equal(url.searchParams.get("lifecycle_admin_restricted"), "eq.false");
      assert.equal(url.searchParams.has("wedding_date"), false, "past/current/future are equally eligible");
      return response(["eq.past-wedding", "eq.current-wedding", "eq.future-wedding", "eq.opted-out-wedding"].includes(url.searchParams.get("slug"))
        ? [{ id: owner, currency: "KES", palette: ["#112233", "#445566", "#778899", "#eeeeee"],
          rsvp_fee_minor: 0, premium_diet_options: ["A personal menu label"],
          revenue_features: url.searchParams.get("slug") === "eq.opted-out-wedding"
            ? Object.fromEntries(WSStarterSetup.featureKeys.map(key => [key, false])) : null,
          amount_presets: null }] : []);
    }
    if (url.pathname === "/rest/v1/sponsor_tiers") {
      assert.equal(url.searchParams.get("select"), "min_amount_minor");
      return response([{ min_amount_minor: 250000 }]);
    }
    if (url.pathname === "/rest/v1/registry_items") {
      assert.equal(url.searchParams.get("select"), "target_amount_minor");
      return response([{ target_amount_minor: 15000000 }]);
    }
    if (url.pathname === "/rest/v1/vip_offers") {
      assert.equal(url.searchParams.get("select"), "seats_total,price_minor");
      return response([{ seats_total: 12, price_minor: 250000 }]);
    }
    if (url.pathname === "/rest/v1/sponsor_featured_campaigns") {
      assert.equal(url.searchParams.get("select"), "slot_count,minimum_bid_minor,bid_increment_minor");
      assert.equal(url.searchParams.get("enabled"), "eq.true");
      return response([{ slot_count: 3, minimum_bid_minor: 1000000, bid_increment_minor: 250000 }]);
    }
    if (url.pathname === "/rest/v1/venues") {
      assert.equal(url.searchParams.get("select"), "name,kind,is_main,address,map_link");
      return response([{ name: "Secret Person introductions at Private House", kind: "pre", address: "PRIVATE_CANARY_VENUE" },
        { name: "Secret Person fundraiser", kind: "pre", address: "PRIVATE_CANARY_VENUE" },
        { name: "Secret Person ceremony", kind: "main", is_main: true, address: "PRIVATE_CANARY_OTHER" }]);
    }
    if (url.pathname === "/rest/v1/fundraising_streams") {
      assert.equal(url.searchParams.get("select"), "id,goal_minor");
      assert.equal(url.searchParams.get("enabled"), "eq.true");
      return response([{ id: owner, goal_minor: 15000000 }]);
    }
    if (url.pathname === "/rest/v1/fundraising_milestones") {
      assert.equal(url.searchParams.get("select"), "target_minor");
      return response([{ target_minor: 5000000 }]);
    }
    if (url.pathname === "/rest/v1/rpc/create_wedding_from_starter") {
      assert.equal(options.headers.Authorization, "Bearer owner-token");
      assert.equal(body.p_request_key, key);
      assert.deepEqual(body.p_input.referral, referral, "real referral consent passes through unchanged");
      assert.deepEqual(Object.keys(body.p_input).sort(), ["coupleNames", "currency", "location", "maxCapacity",
        "palette", "paletteNames", "referral", "slug", "starterSetup", "timeZone", "venues", "weddingDate"]);
      if (existingDraft) return response(existingDraft);
      if (staged) {
        assert.deepEqual(body.p_input, staged);
        const draft = { weddingId: owner, slug: body.p_input.slug };
        creates.set(key, draft);
        staged = null;
        return response(draft);
      }
      return new Response(JSON.stringify({ message: "STARTER_CAPABILITY_REQUIRED: Check support." }), { status: 400 });
    }
    throw new Error(`Unexpected external call: ${input}`);
  };
  async function run(handler, action, body, slug, auth = true, method = body ? "POST" : "GET") {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; },
      setHeader() {}, end(text) { this.body = JSON.parse(text); }, json(body) { this.body = body; } };
    await handler({ method, headers: auth ? { authorization: "Bearer owner-token" } : {},
      query: { action, slug }, body }, res);
    return res;
  }
  try {
    for (const slug of ["past-wedding", "current-wedding", "future-wedding", "showcase-wedding"]) {
      const res = await run(guest, "style", null, slug, false);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.style.venues.some(event => event.kind === "pre"));
      assert.ok(res.body.style.venues.some(event => event.kind === "main"));
      assert.ok(res.body.style.venues.every(event => event.time === "" && event.eventDate === "" && event.address === ""));
      assert.equal(res.body.style.setup.currency, "KES");
      assert.equal(res.body.style.setup.reviewed, false);
      assert.equal(res.body.style.setup.tiers[0].minAmount, slug === "showcase-wedding" ? "10000.00" : "2500.00");
      assert.equal(JSON.stringify(res.body).includes("A personal menu label"), false);
      assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_CANARY|Secret Person|2099|Homestead|Amara|Kito/);
      if (slug !== "showcase-wedding") {
        assert.deepEqual(res.body.style.venues.map(v => v.kind), ["pre", "pre", "main"]);
        assert.match(res.body.style.venues[0].name, /Family introductions/);
        assert.match(res.body.style.venues[1].name, /fundraiser/);
        assert.match(res.body.style.venues[2].name, /Ceremony/);
        assert.match(res.body.style.venues[0].description, /Venue group 1/);
        assert.match(res.body.style.venues[1].description, /Venue group 1/);
        assert.match(res.body.style.venues[2].description, /Venue group 2/);
      }
      assert.equal(JSON.stringify(res.body).includes("raised"), false);
      assert.deepEqual(Object.keys(res.body), ["style"]);
    }
    for (const slug of ["private-wedding", "unpublished-wedding", "restricted-wedding", "archived-wedding", "../invalid"]) {
      assert.equal((await run(guest, "style", null, slug, false)).statusCode, 404);
    }
    const beforeOptOut = calls.length;
    const optedOut = await run(guest, "style", null, "opted-out-wedding", false);
    assert.equal(optedOut.statusCode, 200);
    assert.ok(Object.values(optedOut.body.style.setup.features).every(enabled => enabled === false));
    assert.equal(optedOut.body.style.setup.tiers.length, 0);
    assert.equal(optedOut.body.style.setup.campaigns.length, 0);
    assert.equal(optedOut.body.style.setup.vip, null);
    assert.equal(optedOut.body.style.setup.featured, null);
    assert.deepEqual(calls.slice(beforeOptOut).map(call => call.url.pathname),
      ["/rest/v1/weddings", "/rest/v1/venues"], "nonpublic/disabled feature configuration is not read");
    assert.equal((await run(guest, "style", {}, "past-wedding", false)).statusCode, 405);
    const payload = { coupleNames: "Our own names", requestKey: key, currency: "USD", referral,
      styleSlug: "past-wedding", ...inspiration.publicDesign(["#112233"]),
      starterSetup: { ...globalThis.WSStarterSetup.fictional("garden-gathering", "USD"), reviewed: true },
      published_at: "2099-01-01", enabled_payment_methods: ["stripe"], payout: { method: "test" } };
    delete payload.classification;
    capabilityFailure = true;
    assert.equal((await run(weddings, "create", payload)).statusCode, 503, "unavailable capabilities fail closed");
    capabilityFailure = false;
    const initial = await run(weddings, "create", payload);
    assert.equal(initial.statusCode, 201);
    assert.equal(creates.size, 1);
    const input = calls.find(call => call.url.pathname.endsWith("/create_wedding_from_starter")).body.p_input;
    assert.equal(input.currency, "USD");
    assert.equal(input.weddingDate, null);
    assert.equal(input.location, null);
    assert.equal((await run(weddings, "create", payload, null, false)).statusCode, 401);
    assert.equal((await run(weddings, "create", { ...payload, styleSlug: "private-wedding" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, currency: "" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, currency: "JPY" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, inspirationId: "garden-gathering" })).statusCode, 400);
    const fictional = { ...payload, styleSlug: undefined, inspirationId: "coastal-weekend" };
    assert.equal((await run(weddings, "create", fictional)).statusCode, 201);
    const unsupported = { ...fictional, currency: "EUR",
      starterSetup: { ...globalThis.WSStarterSetup.fictional("garden-gathering", "EUR"), reviewed: true } };
    assert.equal((await run(weddings, "create", unsupported)).statusCode, 400, "accounting membership does not prove collection readiness");
    assert.equal((await run(weddings, "create", { ...fictional, inspirationId: "unclassified-client" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...fictional, currency: undefined })).statusCode, 400);
    existingDraft = { weddingId: owner, slug: "our-own-names" };
    const beforeReplay = calls.length;
    const replay = await run(weddings, "create", payload);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.body, existingDraft);
    assert.deepEqual(calls.slice(beforeReplay).map(call => call.url.pathname),
      ["/auth/v1/user", "/rest/v1/rpc/create_wedding_from_starter"],
      "existing RPC replay needs neither a fresh source lookup nor the unavailable helper/staging");
    assert.equal(calls.some(call => ["PATCH", "DELETE"].includes(call.options.method)), false);
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});
