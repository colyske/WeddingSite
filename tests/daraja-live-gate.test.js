import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { darajaEnvironment, initiateDarajaStkPush, verifyProviderPayment } from "../server/payment-adapters.js";

const keys = [
  "WEDDINGSITE_PAYMENT_MODE", "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT",
  "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY",
  "DARAJA_LIVE_COLLECTION_ENABLED", "DARAJA_LIVE_SHORTCODE_CONFIRMED"
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
});

function useProduction(extra = {}) {
  Object.assign(process.env, {
    WEDDINGSITE_PAYMENT_MODE: "live",
    WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example",
    DARAJA_ENVIRONMENT: "production",
    DARAJA_CONSUMER_KEY: "mock-live-key",
    DARAJA_CONSUMER_SECRET: "mock-live-secret",
    DARAJA_SHORTCODE: "123456",
    DARAJA_PASSKEY: "mock-live-passkey",
    DARAJA_LIVE_COLLECTION_ENABLED: "true",
    DARAJA_LIVE_SHORTCODE_CONFIRMED: "123456",
    ...extra
  });
}

const stk = () => initiateDarajaStkPush({
  amountMinor: 10000, phoneNumber: "254712345678",
  callbackUrl: "https://weddingsite.example/api/webhooks?provider=daraja",
  accountReference: "ref1", description: "Gift"
});

const json = data => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

test("live Daraja is off without the explicit kill switch and never touches the network", async () => {
  useProduction();
  for (const override of [
    { DARAJA_LIVE_COLLECTION_ENABLED: undefined }, { DARAJA_LIVE_COLLECTION_ENABLED: "1" },
    { DARAJA_LIVE_SHORTCODE_CONFIRMED: undefined }, { DARAJA_LIVE_SHORTCODE_CONFIRMED: "654321" },
    { DARAJA_ENVIRONMENT: "sandbox" }, { WEDDINGSITE_PAYMENT_MODE: "test" }
  ]) {
    useProduction();
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return json({}); };
    assert.notEqual(darajaEnvironment(), "production");
    await assert.rejects(stk());
    assert.equal(calls, 0);
  }
});

test("fully switched live Daraja uses only production endpoints (mocked network)", async () => {
  useProduction();
  assert.equal(darajaEnvironment(), "production");
  const urls = [];
  globalThis.fetch = async input => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/oauth/")) return json({ access_token: "mock-token", expires_in: "3599" });
    return json({ ResponseCode: "0", CheckoutRequestID: "ws_CO_1", MerchantRequestID: "mr-1" });
  };
  const result = await stk();
  assert.equal(result.reference, "ws_CO_1");
  assert.ok(urls.length >= 1 && urls.every(url => url.startsWith("https://api.safaricom.co.ke/")));
  assert.ok(urls.some(url => url.endsWith("/mpesa/stkpush/v1/processrequest")));
});
