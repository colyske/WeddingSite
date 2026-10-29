import test from "node:test";
import assert from "node:assert/strict";
import weddings from "../api/weddings.js";
import "../currencies.js";
import "../amount-presets.js";

const presets = globalThis.WSAmountPresets;
const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const ownerId = "550e8400-e29b-41d4-a716-446655440001";
const json = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("minor-unit presets validate precision, positive finite values, count, currency and checkout caps", () => {
  for (const currency of ["KES", "USD"]) {
    assert.deepEqual(presets.normalize({ currency, song: [50000, 10000, 50000], gift: [1000, 2500] }, currency, 50000),
      { currency, song: [10000, 50000], gift: [1000, 2500] });
    assert.deepEqual(presets.parse("0.01, 1.10, 500"), [1, 110, 50000]);
    for (const song of [[], [0], [-1], [1], [99], [1.01], [NaN], [Infinity], ["100"], [50001], Array(7).fill(100)]) {
      assert.throws(() => presets.normalize({ currency, song, gift: [100] }, currency, 50000));
    }
    for (const input of ["", " ", "0", "-1", "1.001", "Infinity", "NaN", "1e2", "1,"]) assert.throws(() => presets.parse(input));
    assert.throws(() => presets.normalize({ currency: "EUR", song: [100], gift: [100] }, currency, 50000));
    assert.throws(() => presets.normalize({ currency, song: [100], gift: [100] }, currency, NaN));
  }
  assert.throws(() => presets.normalize({ currency: "JPY", song: [100], gift: [100] }, "JPY", 50000));
  assert.deepEqual(presets.amounts({ currency: "KES" }, "song"), [500, 1000, 2500, 5000]);
  assert.deepEqual(presets.amounts({ currency: "KES" }, "gift"), [1000, 2500, 5000]);
  assert.deepEqual(presets.amounts({ currency: "USD", amount_presets: { currency: "KES", song: [10000] } }, "song"), []);
});

test("organizer API persists canonical choices, preserves omitted presets and rejects unsafe currency changes", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "test-anon", SUPABASE_SERVICE_ROLE_KEY: "test-service" };
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const oldFetch = globalThis.fetch;
  let wedding = { id: weddingId, currency: "KES", amount_presets: null };
  const patches = [];
  let cap = 500000;
  let owned = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return json({ id: ownerId });
    if (url.pathname === "/rest/v1/platform_policies") return json([{ max_contribution_minor: cap }]);
    if (url.pathname === "/rest/v1/weddings") {
      if (!owned) return json([]);
      if (init.method === "PATCH") {
        assert.equal(url.searchParams.get("currency"), `eq.${wedding.currency}`);
        const patch = JSON.parse(init.body);
        if (patch.amount_presets !== undefined) assert.ok(url.searchParams.get("amount_presets") === "is.null" ||
          url.searchParams.get("amount_presets").startsWith("eq."));
        patches.push(patch);
        wedding = { ...wedding, ...patch };
      }
      return json([wedding]);
    }
    if (url.pathname.startsWith("/rest/v1/")) return json([]);
    throw new Error(`Unexpected fetch ${url}`);
  };
  const run = async body => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await weddings({ method: "POST", query: { action: "update" }, headers: { authorization: "Bearer fixture" },     body: { weddingId, ...body,
      ...(body.amountPresets === undefined || body.amountPresetsBase !== undefined ? {} : { amountPresetsBase: wedding.amount_presets }) } }, res);
    return res;
  };
  try {
    let res = await run({ currency: "KES", welcomeStory: "A celebration" });
    assert.equal(res.statusCode, 200);
    assert.equal("amount_presets" in patches[0], false);
    const valid = { currency: "KES", song: [50000, 10000, 50000], gift: [500000, 50000] };
    res = await run({ amountPresets: valid });
    assert.equal(res.statusCode, 409);
    res = await run({ amountPresets: valid, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.wedding.amount_presets, { currency: "KES", song: [10000, 50000], gift: [50000, 500000] });
    res = await run({ currency: "USD" });
    assert.equal(res.statusCode, 400);
    res = await run({ currency: "USD", amountPresets: valid, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES" });
    assert.equal(res.statusCode, 400);
    const usd = { currency: "USD", song: [500, 1000], gift: [1000, 2500] };
    res = await run({ currency: "USD", amountPresets: usd, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(wedding.amount_presets, usd);
    res = await run({ amountPresets: usd, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES",
      amountPresetsBase: { currency: "KES", song: [10000, 50000], gift: [50000, 500000] } });
    assert.equal(res.statusCode, 409, "stale editor must review against current currency");
    cap = 100;
    res = await run({ amountPresets: usd, amountPresetsReviewed: true, amountPresetsBaseCurrency: "USD" });
    assert.equal(res.statusCode, 400);
    res = await run({ currency: "KES", amountPresets: null, amountPresetsReviewed: true, amountPresetsBaseCurrency: "USD" });
    assert.equal(res.statusCode, 200, "explicit reviewed reset may change currency");
    assert.equal(wedding.amount_presets, null);
    owned = false;
    res = await run({ amountPresets: valid, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES" });
    assert.equal(res.statusCode, 404);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
