import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import checkoutHandler from "../api/checkout.js";
import webhooks from "../api/webhooks.js";

const keys = [
  "WEDDINGSITE_PAYMENT_MODE", "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT", "DARAJA_CONSUMER_KEY",
  "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_LIVE_COLLECTION_ENABLED",
  "DARAJA_LIVE_SHORTCODE_CONFIRMED", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TURNSTILE_SECRET_KEY"
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalError = console.error;
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
  console.error = originalError;
});

const WEDDING = "7c1b33e8-6b41-4f66-9169-54197263db7f";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function useLive(extra = {}) {
  console.error = () => {};
  Object.assign(process.env, {
    WEDDINGSITE_PAYMENT_MODE: "live", WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example",
    DARAJA_ENVIRONMENT: "production", DARAJA_CONSUMER_KEY: `mock-key-${Math.random()}`, DARAJA_CONSUMER_SECRET: "mock-secret",
    DARAJA_SHORTCODE: "123456", DARAJA_PASSKEY: "mock-passkey", DARAJA_LIVE_COLLECTION_ENABLED: "true",
    DARAJA_LIVE_SHORTCODE_CONFIRMED: "123456", SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "mock-service", TURNSTILE_SECRET_KEY: "mock-turnstile", ...extra
  });
}

function world({ approved = true, stk = () => json({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1" }) } = {}) {
  const state = {
    approval: { approved, shortcode: "123456" }, rows: [], inserts: 0, deletes: 0, stkCalls: 0, oauthCalls: 0,
    queries: [], settled: [], hosts: []
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    state.hosts.push(url.host);
    if (url.host === "challenges.cloudflare.com") return json({ success: true, hostname: "weddingsite.example" });
    if (url.host.endsWith("safaricom.co.ke")) {
      assert.equal(url.host, "api.safaricom.co.ke", "live credentials must never reach sandbox");
      if (url.pathname.startsWith("/oauth/")) { state.oauthCalls++; return json({ access_token: "mock-token", expires_in: "3599" }); }
      if (url.pathname.includes("stkpushquery")) {
        state.queries.push(JSON.parse(init.body));
        return json({ ResponseCode: "0", ResultCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1", ResultDesc: "ok" });
      }
      state.stkCalls++;
      await Promise.resolve();
      return stk(JSON.parse(init.body));
    }
    assert.equal(url.host, "supabase.example");
    const path = url.pathname;
    const method = init.method || "GET";
    const find = column => state.rows.find(row => row[column] === url.searchParams.get(column)?.replace("eq.", ""));
    if (path === "/rest/v1/daraja_live_approval") return json([state.approval]);
    if (path === "/rest/v1/platform_policies") {
      return json([{ contribution_fee_basis_points: 0, contribution_fixed_fee_minor: 0, contribution_fixed_fee_currency: "KES", max_contribution_minor: 5_000_000, enabled_payment_providers: ["daraja"] }]);
    }
    if (path === "/rest/v1/weddings") return json([{ id: WEDDING, slug: "ada", currency: "KES", wedding_date: "2099-01-01", time_zone: "Africa/Nairobi" }]);
    if (path === "/rest/v1/rpc/get_dj_leaderboard") return json([]);
    if (path === "/rest/v1/contribution_line_items") return new Response(null, { status: 201 });
    if (path === "/rest/v1/rpc/record_verified_payment") {
      const body = JSON.parse(init.body);
      state.settled.push(body);
      const row = state.rows.find(item => item.id === body.p_contribution_id);
      row.payment_status = "paid";
      return json(true);
    }
    if (path === "/rest/v1/contributions") {
      if (method === "POST") {
        const body = JSON.parse(init.body);
        if (state.rows.some(row => row.checkout_idempotency_key === body.checkout_idempotency_key)) {
          return json({ message: "duplicate key" }, 409);
        }
        state.inserts++;
        state.rows.push(body);
        return new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        const row = state.rows.find(item => item.id === url.searchParams.get("id")?.replace("eq.", ""));
        Object.assign(row, JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") { state.deletes++; return new Response(null, { status: 204 }); }
      const row = find("checkout_idempotency_key") || find("id") || find("provider_reference");
      return json(row ? [row] : []);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return state;
}

function call(handler, req) {
  const res = {
    status(code) { this.statusCode = code; return this; }, setHeader() {},
    end(body) { this.body = body ? JSON.parse(body) : null; }
  };
  return handler(req, res).then(() => res);
}

const checkoutBody = (overrides = {}) => ({
  weddingId: WEDDING, purchaseAction: "song_bid", market: "KE", currency: "KES", provider: "daraja",
  idempotencyKey: "11111111-1111-4111-8111-111111111111", visibility: "hidden", captchaToken: "ok",
  songTitle: "Song", artist: "Artist", amountMinor: 10000, mpesaPhone: "254712345678", ...overrides
});
const create = body => call(checkoutHandler, {
  method: "POST", query: { action: "create" }, headers: { origin: "https://weddingsite.example" }, body
});
const callback = () => call(webhooks, {
  method: "POST", query: { provider: "daraja" }, headers: {},
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1", ResultCode: 0 } } }));
  }
});

test("Owner approval absent: no provider OAuth or STK is attempted", async () => {
  useLive();
  const state = world({ approved: false });
  const res = await create(checkoutBody());
  assert.equal(res.statusCode, 503);
  assert.equal(state.oauthCalls + state.stkCalls, 0);
  assert.equal(state.inserts, 0);
});

test("approved live admission snapshots context; same-key concurrency sends one STK", async () => {
  useLive();
  const state = world();
  const [a, b] = await Promise.all([create(checkoutBody()), create(checkoutBody())]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
  assert.equal(state.stkCalls, 1);
  assert.equal(state.inserts, 1);
  const row = state.rows[0];
  assert.equal(row.payment_environment, "live");
  assert.equal(row.daraja_shortcode, "123456");
  assert.equal(row.daraja_merchant_request_id, "mr-1");
  assert.equal(row.provider_reference, "ws_CO_1");
  const retry = await create(checkoutBody());
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.body.paymentId, row.id);
  assert.equal(state.stkCalls, 1);
});

test("over-limit, non-KES and bad phone are rejected before any provider call", async () => {
  useLive();
  const state = world();
  const cases = [
    checkoutBody({ amountMinor: 6_000_000 }),
    checkoutBody({ amountMinor: 10050 }),
    checkoutBody({ currency: "USD" }),
    checkoutBody({ mpesaPhone: "12345" })
  ];
  for (const body of cases) assert.ok((await create(body)).statusCode >= 400);
  assert.equal(state.stkCalls, 0);
  assert.equal(state.inserts, 0);
});

test("uncertain STK outcomes retain the pending live row and are never erased", async () => {
  for (const stk of [() => json({ error: "gateway" }, 503), () => json({ CheckoutRequestID: "ws_CO_1" })]) {
    useLive();
    const state = world({ stk });
    const res = await create(checkoutBody());
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.paymentId, state.rows[0].id);
    assert.equal(state.deletes, 0);
    assert.equal(state.rows[0].payment_status, "pending");
    assert.equal(state.stkCalls, 1);
  }
});

test("callback reconciles with the stored context after kill switch and approval revocation", async () => {
  useLive();
  const state = world();
  await create(checkoutBody());
  process.env.DARAJA_LIVE_COLLECTION_ENABLED = "false";
  state.approval.approved = false;
  const res = await callback();
  assert.equal(res.statusCode, 200);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].BusinessShortCode, "123456");
  assert.equal(state.queries[0].CheckoutRequestID, "ws_CO_1");
  assert.equal(state.settled.length, 1);
  assert.equal(state.settled[0].p_contribution_id, state.rows[0].id);
});
