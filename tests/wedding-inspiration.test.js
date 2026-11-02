import test from "node:test";
import assert from "node:assert/strict";
import "../inspiration-fixtures.js";
import guest from "../api/guest.js";
import weddings from "../api/weddings.js";

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

test("style endpoints filter visibility, ignore dates, never read personal content, and preserve authenticated creation", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" });
  const oldFetch = globalThis.fetch;
  const calls = [];
  const creates = new Map();
  const key = "550e8400-e29b-41d4-a716-446655440002";
  const owner = "550e8400-e29b-41d4-a716-446655440000";
  const referral = { intentId: owner, revision: key, decision: "accept", termsVersion: "client-referrals-v1" };
  const response = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.pathname === "/auth/v1/user") return response({ id: owner });
    if (url.pathname === "/rest/v1/weddings") {
      assert.equal(options.method, "GET");
      assert.equal(url.searchParams.get("select"), "palette", "no client content may be read");
      assert.equal(url.searchParams.get("published_at"), "not.is.null");
      assert.equal(url.searchParams.get("archived_at"), "is.null");
      assert.equal(url.searchParams.get("lifecycle_admin_restricted"), "eq.false");
      assert.equal(url.searchParams.has("wedding_date"), false, "past/current/future are equally eligible");
      return response(["eq.past-wedding", "eq.current-wedding", "eq.future-wedding"].includes(url.searchParams.get("slug"))
        ? [{ palette: ["#112233", "#445566", "#778899", "#eeeeee"] }] : []);
    }
    if (url.pathname === "/rest/v1/rpc/create_wedding_draft") {
      assert.equal(options.headers.Authorization, "Bearer owner-token");
      assert.equal(body.p_request_key, key);
      assert.deepEqual(body.p_input.referral, referral, "real referral consent passes through unchanged");
      assert.deepEqual(Object.keys(body.p_input).sort(), ["coupleNames", "currency", "location", "maxCapacity",
        "palette", "paletteNames", "referral", "slug", "timeZone", "venues", "weddingDate"]);
      if (!creates.has(key)) creates.set(key, { weddingId: owner, slug: body.p_input.slug });
      return response(creates.get(key));
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
      assert.deepEqual(res.body.style.venues.map(event => event.name), ["Your ceremony", "Your reception"]);
      assert.deepEqual(Object.keys(res.body), ["style"]);
    }
    for (const slug of ["private-wedding", "unpublished-wedding", "restricted-wedding", "archived-wedding", "../invalid"]) {
      assert.equal((await run(guest, "style", null, slug, false)).statusCode, 404);
    }
    assert.equal((await run(guest, "style", {}, "past-wedding", false)).statusCode, 405);
    const payload = { coupleNames: "Our own names", requestKey: key, currency: "EUR", referral,
      styleSlug: "past-wedding", ...inspiration.publicDesign(["#112233"]),
      published_at: "2099-01-01", enabled_payment_methods: ["stripe"], payout: { method: "test" } };
    delete payload.classification;
    const initial = await run(weddings, "create", payload);
    assert.equal(initial.statusCode, 201);
    assert.equal((await run(weddings, "create", payload)).body.weddingId, initial.body.weddingId);
    assert.equal(creates.size, 1);
    const input = calls.find(call => call.url.pathname.endsWith("/create_wedding_draft")).body.p_input;
    assert.equal(input.currency, "EUR");
    assert.equal(input.weddingDate, null);
    assert.equal(input.location, null);
    assert.equal((await run(weddings, "create", payload, null, false)).statusCode, 401);
    assert.equal((await run(weddings, "create", { ...payload, styleSlug: "private-wedding" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, currency: "" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, currency: "JPY" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...payload, inspirationId: "garden-gathering" })).statusCode, 400);
    const fictional = { ...payload, styleSlug: undefined, inspirationId: "coastal-weekend" };
    assert.equal((await run(weddings, "create", fictional)).statusCode, 201);
    assert.equal((await run(weddings, "create", { ...fictional, inspirationId: "unclassified-client" })).statusCode, 400);
    assert.equal((await run(weddings, "create", { ...fictional, currency: undefined })).statusCode, 400);
    assert.equal(calls.some(call => ["PATCH", "DELETE"].includes(call.options.method)), false);
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  }
});
