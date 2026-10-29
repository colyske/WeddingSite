import test from "node:test";
import assert from "node:assert/strict";
import checkout, { enabledPaymentProviders } from "../api/checkout.js";

const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const paymentId = "550e8400-e29b-41d4-a716-446655440001";
const response = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const res = () => ({ status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.data = JSON.parse(body); } });

test("platform allowlist preserves configured defaults and rejects malformed controls", () => {
  assert.deepEqual(enabledPaymentProviders({}), ["stripe", "paystack", "daraja"]);
  assert.deepEqual(enabledPaymentProviders({ enabled_payment_providers: [] }), []);
  assert.throws(() => enabledPaymentProviders(null));
  assert.throws(() => enabledPaymentProviders({ enabled_payment_providers: ["unsupported"] }));
});

test("options and stale-tab checkout creation respect independent switches; existing statuses retain their provider", async () => {
  const env = {
    WEDDINGSITE_PAYMENT_MODE: "test", WEDDINGSITE_PUBLIC_ORIGIN: "https://wedding.example",
    PAYSTACK_SECRET_KEY: "sk_test_controls", PAYSTACK_SUPPORTED_CURRENCIES: "KES", PAYSTACK_SUPPORTED_MARKETS: "KE",
    DARAJA_ENVIRONMENT: "sandbox", DARAJA_CONSUMER_KEY: "fixture-key", DARAJA_CONSUMER_SECRET: "fixture-secret",
    DARAJA_SHORTCODE: "174379", DARAJA_PASSKEY: "fixture-passkey",
    TURNSTILE_SECRET_KEY: "fixture-secret", TURNSTILE_SITE_KEY: "fixture-site",
    SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "fixture-service"
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const fetch = globalThis.fetch;
  Object.assign(process.env, env);
  let enabled = [];
  const paths = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    paths.push(url.pathname);
    if (url.pathname === "/rest/v1/platform_policies") return response([{ enabled_payment_providers: enabled }]);
    if (url.pathname === "/rest/v1/weddings") return response([{ id: weddingId, currency: "KES" }]);
    if (url.pathname === "/integration/payment_session_timeout") return response({ status: true });
    if (url.pathname === "/oauth/v1/generate") return response({ access_token: "fixture-token", expires_in: 3600 });
    if (url.pathname === "/rest/v1/contributions") return response([{
      id: paymentId, provider_name: "daraja", provider_reference: "fixture-reference",
      payment_status: "paid", purchase_action: "song_bid", action_completed_at: "2026-10-29T00:00:00Z",
      provider_fee_pending: true, action_result: { completed: true }
    }]);
    throw new Error(`Unexpected external request: ${url.pathname}`);
  };
  try {
    for (const combination of [["daraja"], ["paystack"], ["daraja", "paystack"], []]) {
      enabled = combination;
      const result = res();
      await checkout({ method: "GET", headers: {}, query: { action: "options", weddingId, currency: "KES" } }, result);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.data.providers.map(p => p.id).sort(), [...combination].sort());
    }
    // A cached option from a previously open tab cannot initiate a now-disabled provider.
    enabled = ["daraja"];
    paths.length = 0;
    const stale = res();
    await checkout({ method: "POST", headers: { origin: "https://wedding.example" }, query: { action: "create" },
      body: { weddingId, idempotencyKey: paymentId, provider: "paystack", market: "KE", currency: "KES",
        email: "sample@example.com", purchaseAction: "song_bid", songTitle: "Sample song", artist: "Sample artist",
        amountMinor: 1000, visibility: "hidden", publicConsent: false } }, stale);
    assert.equal(stale.statusCode, 409);
    assert.match(stale.data.error, /disabled/);
    assert.deepEqual(paths, ["/rest/v1/platform_policies"], "no provider, anti-bot or pending intent started");
    enabled = [];
    paths.length = 0;
    const existing = res();
    await checkout({ method: "GET", headers: {}, query: { action: "status", id: paymentId } }, existing);
    assert.equal(existing.data.paymentStatus, "paid");
    assert.equal(existing.data.actionStatus, "completed");
    assert.deepEqual(paths, ["/rest/v1/contributions"], "no allowlist check or provider reassignment for existing payment");
  } finally {
    globalThis.fetch = fetch;
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
