import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import weddings from "../api/weddings.js";
import "../inspiration-fixtures.js";
import "../starter-setup.js";
import "../currencies.js";

test("accounting membership matches SQL, independent of browser ICU default exponents", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611010002_paystack_live_collection.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`'${WSCurrencies.accountingCodes.join(",")}'`));
  for (const code of ["COP", "HUF", "IDR", "PKR", "TWD"]) {
    assert.equal(WSCurrencies.supportsAccounting(code), true);
    assert.equal(WSCurrencies.exponent(code), 2);
  }
  assert.equal(WSCurrencies.supportsAccounting("JPY"), false);
  assert.equal(WSCurrencies.supportsAccounting("ZZZ"), false);
});

test("unpaid starter create/replay never consults collection; pending review is owner-scoped and explicit", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    WEDDINGSITE_PAYMENT_MODE: "live" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const original = globalThis.fetch;
  const owner = "550e8400-e29b-41d4-a716-446655440000";
  const key = "550e8400-e29b-41d4-a716-446655440001";
  const calls = [];
  let staged, created, pending, reviewed = false, foreignOwner = false, capabilityTimeout = true;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input), body = options.body && JSON.parse(options.body);
    calls.push({ path: url.pathname, body, options });
    if (url.pathname === "/auth/v1/user") return json({ id: owner });
    if (url.pathname.endsWith("/create_deferred_wedding_starter")) {
      assert.equal(options.headers.Authorization, "Bearer actor-token");
      if (created) { assert.deepEqual(body.p_input, staged); return json(created); }
      if (!staged) return json({ message: "STARTER_SOURCE_REQUIRED: Recheck source." }, 400);
      assert.equal(body.p_input.coupleNames, "");
      assert.equal(body.p_input.starterDeferred, true);
      assert.equal(body.p_input.starterSetup.reviewed, true, "validation does not imply review; DB persists false");
      pending = { ...body.p_input.starterSetup, reviewed: false };
      return json(created = { weddingId: owner, slug: body.p_input.slug });
    }
    if (url.pathname.endsWith("/stage_wedding_starter_source")) {
      assert.equal(options.headers.apikey, "service");
      assert.equal(body.p_owner, owner);
      staged = body.p_input;
      return json(null);
    }
    if (url.pathname === "/rest/v1/weddings") {
      assert.equal(url.searchParams.get("client_owner_id"), `eq.${owner}`);
      return json(foreignOwner ? [] : [{ id: owner, currency: "USD", published_at: null }]);
    }
    if (url.pathname === "/rest/v1/wedding_starter_structures") return json(pending ? [{ wedding_id: owner, setup: WSStarterSetup.structure(pending) }] : []);
    if (url.pathname === "/rest/v1/wedding_starter_pending") {
      assert.equal(options.headers.apikey, "anon", "pending reads use owner RLS, not service bypass");
      return json(pending ? [{ wedding_id: owner, setup: pending }] : []);
    }
    if (url.pathname === "/rest/v1/platform_policies") return capabilityTimeout
      ? json({ message: "Timed out checking collection." }, 503) : json([{ enabled_payment_providers: [] }]);
    if (url.pathname === "/rest/v1/wedding_starter_reviews") return json(reviewed ? [{ request_key: key }] : []);
    if (url.pathname.endsWith("/review_deferred_wedding_starter")) {
      assert.equal(options.headers.apikey, "service");
      assert.equal(body.p_owner, owner);
      reviewed = true;
      return json({ ok: true, decision: body.p_input.decision });
    }
    if (["venues", "payout_preferences", "registry_items", "sponsor_tiers", "vip_offers",
      "guest_site_content", "fundraising_streams", "sponsor_featured_campaigns"].some(table =>
      url.pathname === `/rest/v1/${table}`) || url.pathname.endsWith("/get_wedding_setup_status") ||
      url.pathname.endsWith("/wedding_moderation_status")) return json([]);
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  async function run(action, body, authenticated = true) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      setHeader() {}, end(text) { this.body = JSON.parse(text); }, json(body) { this.body = body; } };
    await weddings({ method: "POST", query: { action }, headers: authenticated ? { authorization: "Bearer actor-token" } : {}, body }, res);
    return res;
  }
  try {
    const body = { requestKey: key, inspirationId: "garden-gathering", coupleNames: "", currency: "USD",
      starterDeferred: true, starterSetup: WSStarterSetup.fictional("garden-gathering", "USD"),
      palette: ["#244b3a"], venues: WSInspiration.starter("garden-gathering").venues };
    assert.equal((await run("create", body, false)).statusCode, 401);
    const first = await run("create", body);
    assert.equal(first.statusCode, 201);
    assert.equal(pending.reviewed, false);
    assert.ok(pending.tiers.length && pending.campaigns.length);
    assert.equal(calls.some(call => call.path.includes("platform_policies")), false);
    const restored = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      setHeader() {}, end(text) { this.body = JSON.parse(text); }, json(body) { this.body = body; } };
    await weddings({ method: "GET", query: { action: "get", weddingId: owner },
      headers: { authorization: ["Bearer", "user"].join(" ") } }, restored);
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.body.wedding.starter_pending_setup, pending, "owner GET exposes the agreed pending field");
    const start = calls.length;
    assert.deepEqual((await run("create", body)).body, first.body);
    assert.deepEqual(calls.slice(start).map(call => call.path), ["/auth/v1/user", "/rest/v1/rpc/create_deferred_wedding_starter"]);
    assert.equal((await run("starter-review", { weddingId: owner, requestKey: key, currency: "USD", decision: "apply", reviewed: false })).statusCode, 400);
    foreignOwner = true;
    assert.equal((await run("starter-review", { weddingId: owner, requestKey: key, currency: "USD", decision: "apply", reviewed: true })).statusCode, 404);
    foreignOwner = false;
    const review = { weddingId: owner, requestKey: key, currency: "USD", decision: "apply", reviewed: true };
    assert.equal((await run("starter-review", review)).statusCode, 503);
    assert.equal(reviewed, false, "collection timeout leaves pending setup unchanged");
    capabilityTimeout = false;
    assert.equal((await run("starter-review", review)).statusCode, 409);
    assert.equal(reviewed, false, "empty support leaves pending setup unchanged");
    pending.currency = "KES";
    assert.equal((await run("starter-review", review)).statusCode, 409);
    assert.equal(reviewed, false, "foreign currency cannot be relabelled");
    const omit = { ...review, decision: "omit" };
    const before = calls.length;
    assert.deepEqual((await run("starter-review", omit)).body, { ok: true, decision: "omit" });
    assert.equal(calls.slice(before).some(call => call.path.includes("platform_policies")), false);
    assert.deepEqual((await run("starter-review", omit)).body, { ok: true, decision: "omit" });
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
