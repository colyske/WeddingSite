import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import guest from "../api/guest.js";

test("API rejects forbidden direct actions before invoking a privileged RPC", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "fixture" });
  let role = "admin";
  let calls = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === "/auth/v1/user") return Response.json({ id: "550e8400-e29b-41d4-a716-446655440000" });
    if (path === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    calls.push(path);
    assert.ok(path.startsWith("/rest/v1/rpc/"));
    return Response.json(path.endsWith("admin_list_users") ? [] : true);
  };
  const invoke = async (action, method = "GET", body = {}) => {
    const result = { setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(data) { this.data = data; }, end(text) { this.data = JSON.parse(text); } };
    await admin({ method, query: { action }, headers: { authorization: "Bearer fixture" }, body }, result);
    return result;
  };
  try {
    for (role of ["client", "admin", "superadmin", "owner"]) {
      const leader = ["superadmin", "owner"].includes(role);
      for (const action of ["overview", "audit", "policies", "refund-policy", "payment-controls", "policy-history", "ledger", "payouts"]) {
        calls = [];
        assert.equal((await invoke(action)).statusCode, leader ? 200 : 403, `${role}: ${action}`);
        if (!leader) assert.deepEqual(calls, []);
      }
      for (const action of ["policies-save", "refund-policy-save"]) {
        calls = [];
        const result = await invoke(action, "POST", { allocation: "manual_review", confirmed: true, policies: {} });
        assert.equal(result.statusCode, role === "owner" ? 200 : 403);
        if (role !== "owner") assert.deepEqual(calls, []);
      }
      calls = [];
      assert.equal((await invoke("set-role", "POST", { user_id: "fixture", role: "admin" })).statusCode, leader ? 200 : 403);
      if (!leader) assert.deepEqual(calls, []);
      for (const action of ["users", "weddings", "operations"]) {
        assert.equal((await invoke(action)).statusCode, role === "client" ? 403 : 200);
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("retired in-kind enquiry API cannot create records even from an old tab", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Retired enquiry must not reach a database or provider"); };
  const res = { setHeader() {}, status(code) { this.statusCode = code; return this; },
    end(text) { this.data = JSON.parse(text); } };
  try {
    await guest({ method: "POST", query: { action: "sponsor-enquiry" }, headers: {},
      body: { slug: "old-tab", companyName: "Sample", offer: "In-kind proposal" } }, res);
    assert.equal(res.statusCode, 410);
    assert.match(res.data.error, /no longer available/);
  } finally { globalThis.fetch = saved; }
});
