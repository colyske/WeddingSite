import test from "node:test";
import assert from "node:assert/strict";
import referrals from "../server/referrals.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const response = () => ({
  setHeader() {}, status(code) { this.statusCode = code; return this; },
  json(data) { this.data = data; }, end(text) { this.data = JSON.parse(text); }
});

test("send start authorizes only after a committed first start and a separate checked read", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "test-anon" });
  let mode = "first", role = "owner";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") return Response.json({ id });
    if (path === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    calls.push({ path, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    if (path.endsWith("_send_start")) {
      if (mode === "timeout") throw new Error("transport lost");
      if (mode === "replay") return Response.json({ started: false, send_authorized: false });
      if (mode === "invalid") return Response.json({ started: "true", send_authorized: false });
      return Response.json({ started: true, send_authorized: false });
    }
    if (path.endsWith("_send_checked")) {
      if (mode === "blocked") return Response.json({ message: "FACILITATOR_MANUAL_HOLD: Incident." }, { status: 400 });
      if (mode === "read-timeout") throw new Error("transport lost");
      return Response.json({ request_id: id, expected_name: "Test recipient", phone: "254700000003",
        send_authorized: false, historical_only: true });
    }
    throw new Error("Unexpected RPC");
  };
  const invoke = async body => {
    const res = response();
    await referrals({ method: "POST", query: { action: "manual-send-start" },
      headers: { authorization: "Bearer fixture-token" }, body }, res);
    return res;
  };
  try {
    const body = { id, key: id, confirmed: true };
    role = "client";
    assert.equal((await invoke(body)).statusCode, 403);
    role = "owner";
    assert.equal((await invoke({ ...body, sender: id })).statusCode, 400);
    const first = await invoke(body);
    assert.equal(first.statusCode, 200);
    assert.equal(first.data.send_authorized, true);
    assert.equal(first.data.phone, "254700000003");
    assert.deepEqual(calls.map(call => call.path.split("/").at(-1)),
      ["facilitator_manual_send_start", "facilitator_manual_send_checked"]);
    assert.ok(calls.every(call => call.authorization === "Bearer fixture-token"));
    calls.length = 0;
    const upper = await invoke({ ...body, id: id.toUpperCase(), key: id.toUpperCase() });
    assert.equal(upper.data.send_authorized, true);
    assert.ok(calls.every(call => call.body.p_request === id && call.body.p_key === id));
    for (mode of ["replay", "invalid", "timeout", "blocked", "read-timeout"]) {
      calls.length = 0;
      const result = await invoke(body);
      assert.equal(result.data.send_authorized, mode === "replay" ? false : undefined);
      assert.equal(result.data.phone, undefined);
      assert.equal(result.statusCode, mode === "replay" ? 200 : 409);
      if (mode !== "replay") assert.match(result.data.error, /unknown.*Do not retry or send/i);
      assert.equal(calls.length, ["blocked", "read-timeout"].includes(mode) ? 2 : 1);
    }
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("manual payout endpoints require actor authentication, staff roles and exact valid inputs", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "test-anon" });
  const calls = [];
  let role = "client", disabled = false;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://db.example");
    if (parsed.pathname === "/auth/v1/user") return Response.json({ id });
    if (parsed.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    assert.match(parsed.pathname, /^\/rest\/v1\/rpc\/facilitator_manual_/);
    calls.push({ path: parsed.pathname, body: JSON.parse(options.body), authorization: options.headers.Authorization });
    if (disabled) return Response.json({ message: "FACILITATOR_MANUAL_DISABLED: Manual payouts are not available." }, { status: 400 });
    return Response.json(parsed.pathname.endsWith("_workspace") ? [] : id);
  };
  const invoke = async (action, method, body, authenticated = true) => {
    const res = response();
    await referrals({ method, query: { action, id }, headers: authenticated ? { authorization: "Bearer fixture-token" } : {}, body }, res);
    return res;
  };
  try {
    assert.equal((await invoke("manual-workspace", "GET", null, false)).statusCode, 401);
    assert.equal((await invoke("manual-staff-workspace", "GET")).statusCode, 403);
    assert.equal(calls.length, 0);
    const valid = { key: id, recipient: id, review: id, amount: 100, confirmed: true };
    for (const body of [{ ...valid, amount: 0 }, { ...valid, amount: 0.1 }, { ...valid, actor: id }, { ...valid, confirmed: false }]) {
      assert.equal((await invoke("manual-submit", "POST", body)).statusCode, 400);
    }
    assert.equal((await invoke("manual-submit", "POST", valid)).statusCode, 200);
    assert.equal(calls.at(-1).authorization, "Bearer fixture-token");
    assert.deepEqual(calls.at(-1).body, { p_key: id, p_recipient: id, p_review: id, p_amount: 100, p_confirmed: true });
    role = "admin";
    assert.equal((await invoke("manual-staff-workspace", "GET")).statusCode, 200);
    const action = { id, key: id, action: "processing", reason: null, fee: 0, reference: null, ownerSolo: true, confirmed: true };
    assert.equal((await invoke("manual-staff-action", "POST", action)).statusCode, 403);
    role = "owner";
    assert.equal((await invoke("manual-staff-action", "POST", action)).statusCode, 200);
    assert.equal(calls.at(-1).body.p_owner_solo, true);
    const review = { incident: "1", evidence: id, ownerSolo: true, confirmed: true };
    role = "admin";
    assert.equal((await invoke("manual-incident-review", "POST", review)).statusCode, 403);
    role = "owner";
    assert.equal((await invoke("manual-incident-review", "POST", review)).statusCode, 200);
    assert.equal(calls.at(-1).body.p_incident, "1");
    assert.equal((await invoke("manual-incident-review", "POST", { ...review, incident: "9223372036854775808" })).statusCode, 400);
    const evidence = { incident: "1", key: id, reference: id, sha256: "a".repeat(64), confirmed: true };
    assert.equal((await invoke("manual-incident-evidence", "POST", evidence)).statusCode, 200);
    assert.equal((await invoke("manual-sender-current", "GET")).statusCode, 200);
    disabled = true;
    const unavailable = await invoke("manual-workspace", "GET");
    assert.equal(unavailable.statusCode, 503);
    assert.match(unavailable.data.error, /not available/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
