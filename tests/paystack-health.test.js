import test from "node:test";
import assert from "node:assert/strict";

test("Paystack health uses the documented read-only integration endpoint and fails closed", async () => {
  const originalFetch = globalThis.fetch;
  const keys = ["WEDDINGSITE_PAYMENT_MODE", "PAYSTACK_SECRET_KEY"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { WEDDINGSITE_PAYMENT_MODE: "test", PAYSTACK_SECRET_KEY: "sk_test_health_fixture" });
  try {
    for (const [label, status, body, expected] of [
      ["healthy", 200, { status: true, data: { payment_session_timeout: 1800 } }, true],
      ["rejected", 401, { status: false }, false],
      ["invalid-body", 200, { message: "not verified" }, false]
    ]) {
      globalThis.fetch = async (input, init) => {
        assert.equal(input, "https://api.paystack.co/integration/payment_session_timeout");
        assert.ok(!init.method || init.method === "GET", "health checks never initialize a transaction");
        return new Response(JSON.stringify(body), { status });
      };
      const { checkProviderHealth } = await import(`../server/payment-adapters.js?health=${label}`);
      assert.equal(await checkProviderHealth("paystack"), expected, label);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
