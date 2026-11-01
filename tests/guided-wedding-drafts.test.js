import test from "node:test";
import assert from "node:assert/strict";
import weddings from "../api/weddings.js";

const owner = "550e8400-e29b-41d4-a716-446655440000";
const id = "550e8400-e29b-41d4-a716-446655440001";
const key = "550e8400-e29b-41d4-a716-446655440002";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("draft API uses idempotent transactional creation, explicit clears, omitted fields and actionable publish readiness", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service" };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, env);
  const calls = [];
  const requests = new Map();
  let wedding;
  let missing = ["wedding-date", "location", "venues-section"];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return json({ id: owner });
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: url.pathname, body, method: options.method || "GET" });
    if (url.pathname === "/rest/v1/rpc/create_wedding_draft") {
      if (!requests.has(body.p_request_key)) {
        wedding = { id, slug: body.p_input.slug, couple_names: body.p_input.coupleNames,
          wedding_date: body.p_input.weddingDate, public_location: body.p_input.location,
          currency: body.p_input.currency, palette: body.p_input.palette, amount_presets: null };
        requests.set(body.p_request_key, { weddingId: id, slug: wedding.slug });
      }
      return json(requests.get(body.p_request_key));
    }
    if (url.pathname === "/rest/v1/rpc/save_wedding_content") {
      wedding = { ...wedding, ...body.p_patch };
      return json(wedding);
    }
    if (url.pathname === "/rest/v1/rpc/wedding_publication_readiness") return json(missing);
    if (url.pathname === "/rest/v1/rpc/publish_wedding_with_fee") return json(true);
    if (url.pathname === "/rest/v1/rpc/publication_quote") return json({ fee_minor: null, usd_amount_minor: null, currency: "USD", pending_date: true });
    if (url.pathname === "/rest/v1/weddings") return json([wedding]);
    if (url.pathname.startsWith("/rest/v1/")) return json([]);
    throw new Error(`Unexpected external/provider call: ${url}`);
  };
  async function run(action, body, method = "POST") {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; },
      setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await weddings({ method, headers: { authorization: "Bearer fixture-token" },
      query: { action, weddingId: id }, body }, res);
    return res;
  }
  try {
    let res = await run("create", { coupleNames: "Amina & Joseph", requestKey: key });
    assert.equal(res.statusCode, 201);
    const create = calls.find(call => call.path.endsWith("/create_wedding_draft"));
    assert.equal(create.body.p_input.weddingDate, null);
    assert.equal(create.body.p_input.location, null);
    assert.deepEqual(create.body.p_input.venues, []);
    assert.equal(create.body.p_request_key, key);
    assert.equal(create.body.p_input.referral, null, "wrapper checks pending referral intents even without a supplied choice");
    res = await run("create", { coupleNames: "Amina & Joseph", requestKey: key });
    assert.equal(res.body.weddingId, id);
    assert.equal(requests.size, 1);
    assert.equal(calls.some(call => call.method === "PATCH"), false, "create and zone/palette writes commit together");
    res = await run("update", { weddingId: id, welcomeStory: "Still making plans." });
    assert.equal(res.statusCode, 200);
    let save = calls.filter(call => call.path.endsWith("/save_wedding_content")).at(-1).body;
    assert.deepEqual(save.p_patch, { welcome_story: "Still making plans." });
    assert.equal(save.p_venues, null, "omitted venue list keeps existing venues");
    res = await run("update", { weddingId: id, weddingDate: null, location: null, venues: [] });
    assert.equal(res.statusCode, 200);
    save = calls.filter(call => call.path.endsWith("/save_wedding_content")).at(-1).body;
    assert.deepEqual(save.p_patch, { wedding_date: null, public_location: null });
    assert.deepEqual(save.p_venues, []);
    res = await run("update", { weddingId: id, venues: [{ id, address: null }] });
    assert.equal(res.statusCode, 200);
    save = calls.filter(call => call.path.endsWith("/save_wedding_content")).at(-1).body;
    assert.equal(Object.hasOwn(save.p_venues[0], "name"), false, "omitted saved venue fields stay omitted");
    assert.equal(save.p_venues[0].address, null);
    res = await run("quote", null, "GET");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.quote.pending_date, true);
    assert.equal(res.body.quote.fee_minor, null);
    res = await run("publish", { weddingId: id });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body.missingFields, missing);
    assert.equal(calls.some(call => call.path.endsWith("/publish_wedding_with_fee")), false);
    missing = [];
    res = await run("publish", { weddingId: id });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.filter(call => call.path.endsWith("/publish_wedding_with_fee")).length, 1);
    res = await run("create", { coupleNames: "Amina & Joseph" });
    assert.equal(res.statusCode, 400);
    res = await run("create", { coupleNames: "Amina & Joseph", requestKey: key, weddingDate: "2027-02-31" });
    assert.equal(res.statusCode, 400);
    res = await run("update", { weddingId: id, weddingDate: false });
    assert.equal(res.statusCode, 400, "invalid booleans must not silently clear a date");
    res = await run("create", { coupleNames: "Amina & Joseph", requestKey: key, referral: { decision: "accept" } });
    assert.equal(res.statusCode, 400);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
