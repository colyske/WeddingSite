import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import checkoutHandler from "../api/checkout.js";
import webhooks from "../api/webhooks.js";
import { verifyProviderPayment } from "../server/payment-adapters.js";

// Regression for the Nov 1 live incident: STK Query answered ResultCode 4999
// ("still under processing") seconds after the prompt, the payment was cancelled,
// and the later successful callback was ignored, so the paid song bid never appeared.

const keys = [
  "WEDDINGSITE_PAYMENT_MODE", "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT", "DARAJA_CONSUMER_KEY",
  "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_LIVE_COLLECTION_ENABLED",
  "DARAJA_LIVE_SHORTCODE_CONFIRMED", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalInfo = console.info;
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
  console.error = originalError;
  console.info = originalInfo;
});

const ID = "9a1b33e8-6b41-4f66-9169-54197263db7f";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function useLive() {
  console.error = () => {};
  console.info = () => {};
  Object.assign(process.env, {
    WEDDINGSITE_PAYMENT_MODE: "live", WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example",
    DARAJA_ENVIRONMENT: "production", DARAJA_CONSUMER_KEY: `mock-key-${Math.random()}`, DARAJA_CONSUMER_SECRET: "mock-secret",
    DARAJA_SHORTCODE: "123456", DARAJA_PASSKEY: "mock-passkey", DARAJA_LIVE_COLLECTION_ENABLED: "true",
    DARAJA_LIVE_SHORTCODE_CONFIRMED: "123456", SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "mock-service"
  });
}

function world({ status = "pending", resultCode = "0", createdAt = new Date().toISOString() } = {}) {
  const row = {
    id: ID, payment_status: status, provider_name: "daraja", provider_reference: "ws_CO_1",
    pledged_amount_minor: 500, currency: "KES", purchase_action: "song_bid", action_result: null,
    action_completed_at: null, provider_fee_pending: true, payment_environment: "live",
    daraja_shortcode: "123456", daraja_merchant_request_id: "mr-1", created_at: createdAt
  };
  const state = { row, patches: [], recorded: [], recovered: [], queries: 0, resultCode };
  const settle = () => {
    row.payment_status = "paid";
    row.action_completed_at = new Date().toISOString();
    row.action_result = { completed: true, kind: "song_bid", songTitle: "Song", artist: "Artist" };
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === "api.safaricom.co.ke") {
      if (url.pathname.startsWith("/oauth/")) return json({ access_token: "t", expires_in: "3599" });
      state.queries++;
      return json({ ResponseCode: "0", ResultCode: state.resultCode, CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1", ResultDesc: "x" });
    }
    assert.equal(url.host, "supabase.example");
    if (url.pathname === "/rest/v1/rpc/record_verified_payment") {
      state.recorded.push(JSON.parse(init.body));
      if (row.payment_status !== "pending") return json(false);
      settle();
      return json(true);
    }
    if (url.pathname === "/rest/v1/rpc/recover_verified_daraja_payment") {
      state.recovered.push(JSON.parse(init.body));
      settle();
      return json(true);
    }
    if (url.pathname === "/rest/v1/contributions") {
      if (init.method === "PATCH") {
        state.patches.push(JSON.parse(init.body));
        if (url.searchParams.get("payment_status") === `eq.${row.payment_status}` || !url.searchParams.get("payment_status")) {
          Object.assign(row, JSON.parse(init.body));
        }
        return new Response(null, { status: 204 });
      }
      return json([row]);
    }
    throw new Error(`Unexpected ${url.pathname}`);
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
const status = () => call(checkoutHandler, { method: "GET", query: { action: "status", id: ID }, headers: {} });
const callback = () => call(webhooks, {
  method: "POST", query: { provider: "daraja" }, headers: {},
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1", ResultCode: 0 } } }));
  }
});
const bound = { environment: "live", shortcode: "123456", merchantRequestId: "mr-1" };

test("STK Query 4999 and unknown codes are still processing; only documented failures are terminal", async () => {
  useLive();
  for (const code of ["4999", "17", "500"]) {
    world({ resultCode: code });
    const result = await verifyProviderPayment("daraja", "ws_CO_1", ID, 500, "KES", bound);
    assert.deepEqual(result, { verified: false }, `code ${code} must not be terminal`);
  }
  for (const code of ["1032", "1037", "1", "2001"]) {
    world({ resultCode: code });
    const result = await verifyProviderPayment("daraja", "ws_CO_1", ID, 500, "KES", bound);
    assert.equal(result.terminal, true, `code ${code} is a final failure`);
  }
});

test("status poll during 4999 keeps the live payment pending and never cancels it", async () => {
  useLive();
  const state = world({ resultCode: "4999" });
  const res = await status();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, "pending");
  assert.equal(state.patches.length, 0);
  assert.equal(state.row.payment_status, "pending");
});

test("pending -> verified callback after a 4999 poll fulfills the song once", async () => {
  useLive();
  const state = world({ resultCode: "4999" });
  assert.equal((await status()).body.paymentStatus, "pending");
  state.resultCode = "0";
  const settled = state;
  const res = await callback();
  assert.equal(res.body.processed, true);
  assert.equal(settled.recorded.length, 1);
  assert.equal(settled.recovered.length, 0);
  const after = await status();
  assert.equal(after.body.paymentStatus, "paid");
  assert.equal(after.body.actionStatus, "completed");
});

test("a row wrongly cancelled on 4999 is recovered only after provider ResultCode 0 (callback)", async () => {
  useLive();
  const state = world({ status: "cancelled", resultCode: "0" });
  const res = await callback();
  assert.equal(res.body.processed, true);
  assert.equal(state.recovered.length, 1);
  assert.equal(state.recorded.length, 0, "cancelled rows never use the plain settlement path");
  assert.equal(state.recovered[0].p_contribution_id, ID);
  assert.equal(state.recovered[0].p_provider_reference, "ws_CO_1");
  assert.equal(state.row.payment_status, "paid");
});

test("status recovers a wrongly cancelled verified payment and reports the completed song", async () => {
  useLive();
  const state = world({ status: "cancelled", resultCode: "0" });
  const res = await status();
  assert.equal(state.recovered.length, 1);
  assert.equal(res.body.paymentStatus, "paid");
  assert.equal(res.body.actionStatus, "completed");
  assert.equal(res.body.actionResult.songTitle, "Song");
});

test("cancelled rows stay cancelled on final failure, report pending while still processing, and old rows are not queried", async () => {
  useLive();
  let state = world({ status: "cancelled", resultCode: "1032" });
  assert.equal((await callback()).body.processed, false);
  assert.equal((await status()).body.paymentStatus, "cancelled");
  assert.equal(state.recovered.length + state.recorded.length + state.patches.length, 0);
  state = world({ status: "cancelled", resultCode: "4999" });
  assert.equal((await status()).body.paymentStatus, "pending");
  assert.equal(state.row.payment_status, "cancelled");
  state = world({ status: "cancelled", resultCode: "0", createdAt: "2020-01-01T00:00:00Z" });
  assert.equal((await status()).body.paymentStatus, "cancelled");
  assert.equal(state.queries, 0);
});
