import test from "node:test";
import assert from "node:assert/strict";
import checkout from "../api/checkout.js";
import { readFile } from "node:fs/promises";

const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const idempotencyKey = "550e8400-e29b-41d4-a716-446655440001";
const response = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("song request migration normalizes paid insertions and groups normalized titles safely", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202610300006_song_request_normalization.sql", import.meta.url), "utf8");
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /regexp_replace\(trim\(coalesce\(p_song_title/);
  assert.match(migration, /regexp_replace\(trim\(coalesce\(p_artist_name/);
  assert.match(migration, /where b\.wedding_id = p_wedding_id and b\.payment_status = 'paid'/);
  assert.match(migration, /group by title_key, artist_key/);
  assert.match(migration, /grant execute on function public\.get_dj_leaderboard\(uuid\) to anon, authenticated, service_role/);
});

test("new and existing song requests create pending verified checkouts, never direct song credit", async () => {
  const env = {
    WEDDINGSITE_PAYMENT_MODE: "test", WEDDINGSITE_PUBLIC_ORIGIN: "https://wedding.example",
    PAYSTACK_SECRET_KEY: "sk_test_song_checkout", PAYSTACK_SUPPORTED_CURRENCIES: "KES", PAYSTACK_SUPPORTED_MARKETS: "KE",
    TURNSTILE_SECRET_KEY: "test-secret", SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "test-service"
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  let prior = [];
  let challengeValid = true;
  let leaderboard = [];
  const entries = [];
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.hostname === "challenges.cloudflare.com") return response({ success: challengeValid, hostname: "wedding.example" });
    if (url.pathname === "/integration/payment_session_timeout") return response({ status: true });
    if (url.pathname === "/transaction/initialize") return response({
      status: true, data: { authorization_url: "https://checkout.paystack.com/test", reference: idempotencyKey }
    });
    if (url.pathname === "/rest/v1/weddings") return response([{ id: weddingId, slug: "qa-couple", currency: "KES", wedding_date: "2099-01-01" }]);
    if (url.pathname === "/rest/v1/platform_policies") return response([{ contribution_fee_basis_points: 500, max_contribution_minor: 10000000 }]);
    if (url.pathname === "/rest/v1/rpc/get_dj_leaderboard") return response(leaderboard);
    if (url.pathname === "/rest/v1/contributions") {
      if (init.method === "GET") return response(prior);
      if (init.method === "POST") entries.push(JSON.parse(init.body));
      return response(null);
    }
    if (url.pathname === "/rest/v1/contribution_line_items") return response(null);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const run = async overrides => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await checkout({
      method: "POST", query: { action: "create" }, headers: { origin: "https://wedding.example" },
      body: { weddingId, idempotencyKey, provider: "paystack", market: "KE", currency: "KES", purchaseAction: "song_bid",
        captchaToken: "test-token", email: "qa@example.test", amountMinor: 1000, visibility: "hidden", publicConsent: false,
        songTitle: "  QA   Song ", artist: " QA   Artist  ", ...overrides }
    }, res);
    return res;
  };
  try {
    let res = await run({});
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.paymentStatus, "pending");
    assert.deepEqual(entries[0].purchase_data, { songTitle: "QA Song", artist: "QA Artist" });
    assert.equal(entries[0].paid_amount_minor, 0);
    assert.equal(entries[0].payment_status, "pending");
    assert.equal(entries[0].purchase_action, "song_bid");

    leaderboard = [{ song_title: "QA Song", artist_name: "QA Artist" }];
    res = await run({ songTitle: "qa song", artist: "qa artist", amountMinor: 2500 });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(entries[1].purchase_data, entries[0].purchase_data);
    assert.equal(entries[1].pledged_amount_minor, 2500);
    assert.ok(!calls.some(path => /place_dj_bid|record_verified_payment|dj_song_bids/.test(path)));

    for (const invalid of [{ songTitle: "" }, { artist: "" }, { songTitle: "x".repeat(161) }, { amountMinor: -1 }]) {
      res = await run(invalid);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(entries.length, 2);
    challengeValid = false;
    res = await run({});
    assert.equal(res.statusCode, 400);
    assert.equal(entries.length, 2);
    challengeValid = true;
    prior = [{ id: entries[0].id, payment_status: "pending" }];
    res = await run({});
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.paymentId, entries[0].id);
    assert.equal(entries.length, 2, "duplicate checkout does not credit or create a second contribution");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
