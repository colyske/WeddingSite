import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/b2c.js";

function response() {
  return { code: 0, body: null, status(code) { this.code = code; return this; },
    setHeader() {}, end(body) { this.body = JSON.parse(body); } };
}
const id = "10000000-0000-4000-8000-000000000001";

test("B2C API authenticates scheduler/callbacks and never contacts Daraja with default gates", async () => {
  const oldFetch = global.fetch;
  const keys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "DARAJA_B2C_ENABLED"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, {
    SUPABASE_URL: "https://synthetic.supabase.test", SUPABASE_ANON_KEY: "synthetic-anon",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", CRON_SECRET: "synthetic-cron-secret", DARAJA_B2C_ENABLED: "false"
  });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    assert.ok(String(url).startsWith("https://synthetic.supabase.test/"), "No provider call permitted");
    if (String(url).endsWith("/auth/v1/user")) return { ok: true, json: async () => ({ id }) };
    assert.ok(String(url).endsWith("/rpc/b2c_mark_stale"));
    assert.equal(options.headers.Authorization, "Bearer synthetic-service");
    return { ok: true, text: async () => "0" };
  };
  try {
    let res = response();
    await handler({ method: "GET", query: { action: "worker" }, headers: {} }, res);
    assert.equal(res.code, 401);
    assert.equal(calls.length, 0);
    res = response();
    await handler({ method: "GET", query: { action: "worker" }, headers: { authorization: "Bearer synthetic-cron-secret" } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.held, true);
    assert.equal(calls.length, 1);
    res = response();
    await handler({ method: "POST", query: { action: "result", dispatch: id }, headers: {}, body: { Result: {} } }, res);
    assert.equal(res.code, 403);
    assert.equal(calls.length, 1);
    res = response();
    await handler({ method: "POST", query: { action: "dispatch" }, headers: { authorization: "Bearer synthetic-staff" },
      body: { payoutId: id, idempotencyKey: id, confirmed: true } }, res);
    assert.equal(res.code, 409);
    assert.equal(calls.length, 2); // Authentication only; no reservation or provider calls.
    res = response();
    await handler({ method: "POST", query: { action: "policy-save" }, headers: { authorization: "Bearer synthetic-staff" },
      body: { confirmed: true, changes: { require_four_eyes: false } } }, res);
    assert.equal(res.code, 400);
  } finally {
    global.fetch = oldFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
