import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import weddings from "../api/weddings.js";
import { manualPayoutCommand } from "../server/manual-payouts.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const action = { id, key: id, action: "processing", reason: null, fee: 100, reference: null,
  solo: true, recipient_confirmed: true, confirmed: true };
const res = () => ({ status(code) { this.statusCode = code; return this; }, setHeader() {},
  end(body) { this.data = JSON.parse(body); } });
test("simple operator API keeps integer units, immutable command fields, leadership and explicit confirmation", async () => {
  const command = manualPayoutCommand("simple-action", action, "owner");
  assert.equal(command.rpc, "simple_payout_action");
  assert.equal(command.args.p_fee, 100);
  assert.equal(command.args.p_confirmed, true);
  for (const role of ["client", "admin", "helper"]) assert.equal(manualPayoutCommand("simple-action", action, role).status, 403);
  assert.equal(manualPayoutCommand("simple-action", action, "superadmin").status, 403);
  for (const patch of [{ confirmed: false }, { fee: 0.1 }, { fee: Number.MAX_SAFE_INTEGER+1 }, { fee: null },
    { bank: "unsupported" }, { recipient_confirmed: false }, { reference: "BEFORE-CLAIM" }]) {
    assert.equal(manualPayoutCommand("simple-action", { ...action, ...patch }, "owner").status, 400);
  }
  const oldFetch = globalThis.fetch, saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "fixture" });
  let role = "owner", calls = [], rejected = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    if (url.pathname === "/rest/v1/weddings") return Response.json([{ id, currency: "KES" }]);
    calls.push({ path: url.pathname, body: JSON.parse(init.body || "{}"), token: init.headers.Authorization });
    if (rejected) return Response.json({ message: "SIMPLE_PAYOUT: Amount exceeds available wedding balance." }, { status: 400 });
    return Response.json(url.pathname.endsWith("simple_payout_submit") ? id : { state: "processing", available_minor: 9000 });
  };
  const invoke = async (handler, name, body, method = "POST") => {
    calls = []; const response = res();
    await handler({ method, query: { action: name, weddingId: id }, headers: { authorization: "Bearer fixture" }, body }, response);
    return response;
  };
  try {
    assert.equal((await invoke(admin, "manual-payout-simple-action", action)).statusCode, 200);
    assert.equal(calls[0].body.p_solo, true);
    role = "admin";
    assert.equal((await invoke(admin, "manual-payout-simple", {}, "GET")).statusCode, 403);
    assert.equal(calls.length, 0);
    role = "client";
    const request = { key: id, amountMinor: 1234, partner: 1, confirmed: true };
    const response = await invoke(weddings, "simple-payout-request", request);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.data, { payoutId: id, recorded: true });
    assert.deepEqual(calls[0].body, { p_key: id, p_wedding: id, p_amount: 1234, p_partner: 1, p_confirmed: true });
    for (const patch of [{ amountMinor: 1.5 }, { amountMinor: "1234" }, { partner: 3 }, { confirmed: false },
      { bankAccount: "unsupported" }, { amountMinor: Number.MAX_SAFE_INTEGER+1 }]) {
      assert.equal((await invoke(weddings, "simple-payout-request", { ...request, ...patch })).statusCode, 400);
      assert.equal(calls.length, 0);
    }
    rejected = true;
    assert.equal((await invoke(weddings, "simple-payout-request", request)).statusCode, 409);
  } finally { globalThis.fetch = oldFetch; for (const [k,v] of Object.entries(saved)) v===undefined ? delete process.env[k] : process.env[k]=v; }
});
