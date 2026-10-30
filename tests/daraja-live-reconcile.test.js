import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  darajaConfiguredEnvironment, darajaEnvironment, initiateDarajaStkPush, verifyProviderPayment
} from "../server/payment-adapters.js";
import "../payment-intent.js";
const paymentIntent = globalThis.WSPaymentIntent;

const keys = [
  "WEDDINGSITE_PAYMENT_MODE", "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT", "DARAJA_CONSUMER_KEY",
  "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_LIVE_COLLECTION_ENABLED",
  "DARAJA_LIVE_SHORTCODE_CONFIRMED"
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
});

function useProduction(extra = {}) {
  Object.assign(process.env, {
    WEDDINGSITE_PAYMENT_MODE: "live", WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example",
    DARAJA_ENVIRONMENT: "production", DARAJA_CONSUMER_KEY: "mock-key", DARAJA_CONSUMER_SECRET: "mock-secret",
    DARAJA_SHORTCODE: "123456", DARAJA_PASSKEY: "mock-passkey", DARAJA_LIVE_COLLECTION_ENABLED: "true",
    DARAJA_LIVE_SHORTCODE_CONFIRMED: "123456", ...extra
  });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const stk = () => initiateDarajaStkPush({
  amountMinor: 10000, phoneNumber: "254712345678",
  callbackUrl: "https://weddingsite.example/api/webhooks?provider=daraja", accountReference: "ref1", description: "Gift"
});
const liveBound = { environment: "live", shortcode: "123456", merchantRequestId: "mr-1" };

function queryMock(calls, merchant = "mr-1") {
  return async input => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/oauth/")) return json({ access_token: "mock-token", expires_in: "3599" });
    return json({ ResponseCode: "0", ResultCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: merchant,
      ResultDesc: "ok" });
  };
}

test("kill switch off blocks new admissions but still reconciles admitted live payments", async () => {
  useProduction({ DARAJA_LIVE_COLLECTION_ENABLED: "false" });
  assert.equal(darajaEnvironment(), null);
  assert.equal(darajaConfiguredEnvironment(), "production");
  let calls = [];
  globalThis.fetch = async () => { calls.push("x"); return json({}); };
  await assert.rejects(stk());
  assert.equal(calls.length, 0);
  calls = [];
  globalThis.fetch = queryMock(calls);
  const result = await verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES", liveBound);
  assert.equal(result.verified, true);
  assert.ok(calls.every(url => url.startsWith("https://api.safaricom.co.ke/")));
});

test("live verification refuses unbound, mismatched and old test rows before any fetch", async () => {
  useProduction();
  const calls = [];
  globalThis.fetch = queryMock(calls);
  await assert.rejects(verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES"));
  await assert.rejects(verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES", { environment: "test" }));
  await assert.rejects(verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES", { ...liveBound, shortcode: "654321" }));
  await assert.rejects(verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES", { ...liveBound, merchantRequestId: "" }));
  assert.equal(calls.length, 0);
});

test("live query response for another merchant request is rejected", async () => {
  useProduction();
  globalThis.fetch = queryMock([], "mr-other");
  await assert.rejects(verifyProviderPayment("daraja", "ws_CO_1", "c1", 10000, "KES", liveBound));
});

test("STK acceptance evidence missing from a 2xx body is uncertain, never a definite decline", async () => {
  useProduction();
  const respond = body => { globalThis.fetch = async input => String(input).includes("/oauth/")
    ? json({ access_token: "t", expires_in: "3599" }) : body(); };
  respond(() => json({ CheckoutRequestID: "ws_CO_1" }));
  await assert.rejects(stk(), error => error.uncertain === true && !error.rejected);
  respond(() => json({ errorMessage: "x" }, 200));
  await assert.rejects(stk(), error => error.uncertain === true && !error.rejected);
  respond(() => json({ ResponseCode: "1", errorMessage: "declined" }, 400));
  await assert.rejects(stk(), error => error.rejected === true);
  respond(() => json({}, 500));
  await assert.rejects(stk(), error => error.uncertain === true);
  respond(() => { throw new Error("network"); });
  await assert.rejects(stk(), error => error.uncertain === true);
});

test("an uncertain create response retains the payment id, reuses the key and blocks a second initiation", async () => {
  const intent = paymentIntent.create();
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return json({ error: "uncertain", paymentId: "pay-1", paymentStatus: "pending" }, 503);
  };
  const payload = { weddingId: "w", provider: "daraja", market: "KE", purchaseAction: "gift", amountMinor: 10000, mpesaPhone: "0712345678" };
  const first = await intent.submit(payload, fetchImpl);
  assert.equal(first.kind, "held");
  assert.equal(intent.heldPaymentId, "pay-1");
  const second = await intent.submit({ ...payload, amountMinor: 20000 }, fetchImpl);
  assert.equal(second.kind, "blocked");
  assert.equal(bodies.length, 1);
  intent.release();
  const keyBefore = bodies[0].idempotencyKey;
  const failing = async (_url, init) => { bodies.push(JSON.parse(init.body)); return json({ error: "bad" }, 400); };
  await intent.submit(payload, failing);
  await intent.submit(payload, failing);
  assert.equal(bodies[1].idempotencyKey, bodies[2].idempotencyKey);
  assert.notEqual(bodies[1].idempotencyKey, keyBefore);
  await intent.submit({ ...payload, amountMinor: 30000 }, failing);
  assert.notEqual(bodies[3].idempotencyKey, bodies[2].idempotencyKey);
});

test("successful pending starts and transport uncertainty are held; storage survives reload; different actions get new keys", async () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const payload = { weddingId: "w", provider: "daraja", purchaseAction: "song_bid", songTitle: "A", artist: "B", amountMinor: 10000, captchaToken: "t1" };
  const bodies = [];
  const ok = async (_u, init) => { bodies.push(JSON.parse(init.body)); return json({ paymentId: "pay-9", paymentStatus: "pending" }); };
  let intent = paymentIntent.create({ name: "s", storage });
  assert.equal((await intent.submit(payload, ok)).kind, "started");
  assert.equal(intent.heldPaymentId, "pay-9");
  assert.equal((await intent.submit(payload, ok)).kind, "blocked");
  assert.equal(bodies.length, 1);
  intent = paymentIntent.create({ name: "s", storage });
  assert.equal(intent.heldPaymentId, "pay-9", "outstanding payment is recovered after reload");
  intent.release();
  assert.equal(paymentIntent.create({ name: "s", storage }).heldPaymentId, "");
  const down = async (_u, init) => { bodies.push(JSON.parse(init.body)); throw new Error("network"); };
  assert.equal((await intent.submit(payload, down)).kind, "uncertain");
  assert.equal((await intent.submit({ ...payload, captchaToken: "t2" }, down)).kind, "uncertain");
  assert.equal(bodies[1].idempotencyKey, bodies[2].idempotencyKey, "retry reuses the key");
  assert.equal((await intent.submit({ ...payload, songTitle: "Other" }, down)).kind, "blocked");
  assert.equal(bodies.length, 3);
  intent.release();
  await intent.submit(payload, ok);
  const firstKey = bodies.at(-1).idempotencyKey;
  intent.release();
  await intent.submit({ ...payload, songTitle: "Other" }, ok);
  assert.notEqual(bodies.at(-1).idempotencyKey, firstKey, "a different same-price action never reuses a key");
});

test("guest copy comes from trusted options mode and never calls live prompts test", () => {
  assert.match(paymentIntent.darajaNote("live"), /real money/i);
  assert.match(paymentIntent.darajaNote("test"), /real phone can still be prompted and charged/i);
  assert.doesNotMatch(paymentIntent.payLabel("daraja", "live"), /test|sandbox/i);
  assert.match(paymentIntent.payLabel("daraja", "test"), /sandbox/i);
});

