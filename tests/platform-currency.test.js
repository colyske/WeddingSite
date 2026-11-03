import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import { defaultCurrencyStatus } from "../server/platform-currency.js";

test("platform default status distinguishes unconfigured, supported and unavailable choices", () => {
  const currencies = [{ code: "KES", name: "Kenyan Shilling" }];
  assert.deepEqual(defaultCurrencyStatus(null, currencies), {
    currency: null, configured: false, supported: false
  });
  assert.deepEqual(defaultCurrencyStatus("KES", currencies), {
    currency: "KES", configured: true, supported: true
  });
  assert.deepEqual(defaultCurrencyStatus("EUR", currencies), {
    currency: "EUR", configured: true, supported: false
  });
});

test("default currency is Owner-only, limited to current collection support, and can be cleared", async () => {
  const env = {
    SUPABASE_URL: "https://db.example",
    SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    WEDDINGSITE_PAYMENT_MODE: "test"
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  let role = "owner", storedCurrency = "KES";
  const serviceCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "550e8400-e29b-41d4-a716-446655440000" });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    serviceCalls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/rest/v1/platform_policies") {
      return Response.json([{ default_currency: storedCurrency, enabled_payment_providers: [] }]);
    }
    if (url.pathname === "/rest/v1/rpc/owner_set_default_currency") {
      storedCurrency = init.body && JSON.parse(init.body).p_currency;
      return Response.json({ default_currency: storedCurrency, changed: true });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const invoke = async (action, method = "GET", body = {}) => {
    const res = { setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(data) { this.data = data; }, end(text) { this.data = JSON.parse(text); } };
    await admin({ method, query: { action }, headers: { authorization: "Bearer fixture-token" }, body }, res);
    return res;
  };
  try {
    for (role of ["admin", "superadmin"]) {
      serviceCalls.length = 0;
      assert.equal((await invoke("default-currency")).statusCode, 403);
      assert.equal((await invoke("default-currency-save", "POST", { currency: null, confirmed: true })).statusCode, 403);
      assert.deepEqual(serviceCalls, [], `${role} must not reach setting storage`);
    }

    role = "owner";
    const current = await invoke("default-currency");
    assert.equal(current.statusCode, 200);
    assert.deepEqual(current.data, {
      currency: "KES", configured: true, supported: false, currencies: []
    });

    serviceCalls.length = 0;
    const unsupported = await invoke("default-currency-save", "POST", { currency: "KES", confirmed: true });
    assert.equal(unsupported.statusCode, 409);
    assert.ok(!serviceCalls.some(call => call.path.endsWith("/rpc/owner_set_default_currency")));

    const unconfirmed = await invoke("default-currency-save", "POST", { currency: null, confirmed: false });
    assert.equal(unconfirmed.statusCode, 400);
    const cleared = await invoke("default-currency-save", "POST", { currency: null, confirmed: true });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.data.currency, null);
    assert.equal(cleared.data.changed, true);
    assert.ok(serviceCalls.some(call => call.path.endsWith("/rpc/owner_set_default_currency") &&
      call.body.p_currency === null && call.body.p_confirmed === true));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
