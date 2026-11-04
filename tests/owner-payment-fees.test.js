import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import { manualPayoutCommand } from "../server/manual-payouts.js";
const id = "550e8400-e29b-41d4-a716-446655440000";
const body = { key: id, contribution: id, fee: 44, source_kind: "statement", reference: "STMT-TEST1", actual_zero: false, confirmed: true };
test("Owner actual-fee commands enforce exact minor units, factual and zero confirmations, safe references and immutable payload", () => {
  assert.deepEqual(manualPayoutCommand("fee-attestation", body, "owner"), {
    rpc: "owner_record_payment_fee", args: { p_key: id, p_contribution: id, p_fee: 44, p_source_kind: "statement",
      p_reference: "STMT-TEST1", p_actual_zero: false, p_confirmed: true }
  });
  for (const role of ["superadmin", "admin", "helper", "client", undefined]) {
    assert.equal(manualPayoutCommand("fee-attestation", body, role).status, 403);
  }
  for (const patch of [{ fee: -1 }, { fee: 1.5 }, { fee: "44" }, { fee: Number.MAX_SAFE_INTEGER+1 },
    { fee: 0 }, { actual_zero: true }, { confirmed: false }, { source_kind: "estimate" }, { reference: "254700000001" },
    { reference: "Alice 0700000001" }, { reference: "STMT-123456789" }, { reference: "NO-DIGIT" },
    { platform_fee_minor: 0 }, { funds_available_at: null }, { provider_reference: "secret" }, { phone: "never accepted" }]) {
    assert.equal(manualPayoutCommand("fee-attestation", { ...body, ...patch }, "owner").status, 400);
  }
  assert.equal(manualPayoutCommand("fee-attestation", { ...body, fee: 0, actual_zero: true }, "owner").args.p_fee, 0);
});
test("Owner fee API rejects all other roles before RPC, preserves caller token, and returns bounded domain failures", async () => {
  const previousFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "fixture" });
  let role = "owner", error = false;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    calls.push({ path: url.pathname, body: JSON.parse(init.body || "{}"), token: init.headers.Authorization });
    if (error) return Response.json({ message: "PAYMENT_FEE: Known fees cannot be overwritten." }, { status: 400 });
    if (url.pathname.endsWith("/owner_payment_fee_workspace")) return Response.json({ pending: [], history: [] });
    if (url.pathname.endsWith("/owner_record_payment_fee")) return Response.json(id);
    throw new Error("Unexpected fee RPC");
  };
  async function invoke(method, action, payload = body) {
    const response = { status(n) { this.statusCode=n;return this; }, setHeader() {}, end(s) { this.data=JSON.parse(s); },
      json(body) { this.data=body; } };
    await admin({ method, query: { action }, headers: { authorization: "Bearer fee-fixture" }, body: payload }, response);
    return response;
  }
  try {
    for (role of ["superadmin", "admin", "client", "helper"]) {
      assert.equal((await invoke("GET", "manual-payout-fees")).statusCode, 403);
      assert.equal((await invoke("POST", "manual-payout-fee-attestation")).statusCode, 403);
      assert.equal(calls.length, 0);
    }
    role = "owner";
    assert.equal((await invoke("GET", "manual-payout-fees")).statusCode, 200);
    assert.equal((await invoke("POST", "manual-payout-fee-attestation")).statusCode, 200);
    assert.equal(calls.at(-1).token, "Bearer fee-fixture");
    assert.equal(calls.at(-1).body.p_fee, 44);
    error = true;
    const denied = await invoke("POST", "manual-payout-fee-attestation");
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.data.error, "Known fees cannot be overwritten.");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k]=v; }
  }
});
