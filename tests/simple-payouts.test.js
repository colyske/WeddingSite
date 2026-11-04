import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import weddings from "../api/weddings.js";
import { manualPayoutCommand } from "../server/manual-payouts.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const action = { id, key: id, action: "processing", reason: null, fee: 100, reference: null,
  solo: true, recipient_confirmed: true, confirmed: true };
const res = () => ({ status(code) { this.statusCode = code; return this; }, setHeader() {},
  end(body) { this.data = JSON.parse(body); }, json(body) { this.data = body; } });
test("simple operator API keeps integer units, immutable command fields, leadership and explicit confirmation", async () => {
  const command = manualPayoutCommand("simple-action", action, "owner");
  assert.equal(command.rpc, "simple_payout_action");
  assert.equal(command.args.p_fee, 100);
  assert.equal(command.args.p_confirmed, true);
  for (const role of ["client", "admin", "helper"]) assert.equal(manualPayoutCommand("simple-action", action, role).status, 403);
  assert.equal(manualPayoutCommand("simple-action", action, "superadmin").status, 403);
  assert.equal(manualPayoutCommand("simple-action", { ...action, fee: null }, "owner").args.p_fee, null);
  const paid = { ...action, action: "paid", solo: false, fee: null, reference: "FIXTURE-TX" };
  assert.equal(manualPayoutCommand("simple-action", paid, "owner").args.p_recipient_confirmed, true);
  assert.equal(manualPayoutCommand("simple-action", { ...paid, recipient_confirmed: false }, "owner").status, 400);
  for (const patch of [{ confirmed: false }, { fee: 0.1 }, { fee: Number.MAX_SAFE_INTEGER+1 },
    { bank: "unsupported" }, { recipient_confirmed: false }, { reference: "BEFORE-CLAIM" }]) {
    assert.equal(manualPayoutCommand("simple-action", { ...action, ...patch }, "owner").status, 400);
  }
  const oldFetch = globalThis.fetch, saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "fixture" });
  let role = "owner", calls = [], rejected = false, owned = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    if (url.pathname === "/rest/v1/weddings") return Response.json(owned ? [{ id, currency: "KES" }] : []);
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
    for (const denied of ["client", "helper", "admin"]) {
      role = denied;
      assert.equal((await invoke(admin, "manual-payout-simple", {}, "GET")).statusCode, 403);
      assert.equal(calls.length, 0, "Unauthorized role never reaches private recipient RPC");
    }
    role = "client";
    owned = false;
    assert.equal((await invoke(weddings, "simple-payout-status", {}, "GET")).statusCode, 404);
    assert.equal(calls.length, 0, "Another couple never reaches private recipient RPC");
    owned = true;
    const request = { key: id, amountMinor: 1234, partner: 1, confirmed: true, recipientHash: "a".repeat(64) };
    const response = await invoke(weddings, "simple-payout-request", request);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.data, { payoutId: id, recorded: true });
    assert.deepEqual(calls[0].body, { p_key: id, p_wedding: id, p_amount: 1234, p_partner: 1, p_confirmed: true,
      p_recipient_hash: request.recipientHash, p_processing_fee: null, p_policy_revision: null });
    assert.equal((await invoke(weddings, "simple-payout-request", { ...request, processingFeeMinor: 100, policyRevision: 0 })).statusCode, 201);
    assert.deepEqual(calls[0].body, { p_key:id,p_wedding:id,p_amount:1234,p_partner:1,p_confirmed:true,
      p_recipient_hash:request.recipientHash,p_processing_fee:100,p_policy_revision:0 });
    for (const patch of [{ amountMinor: 1.5 }, { amountMinor: "1234" }, { partner: 3 }, { confirmed: false },
      { bankAccount: "unsupported" }, { amountMinor: Number.MAX_SAFE_INTEGER+1 }, { processingFeeMinor: 100 },
      { policyRevision: 0 }, { processingFeeMinor: 1.5, policyRevision: 0 }, { processingFeeMinor: 100, policyRevision: -1 },
      { recipientHash: undefined }, { recipientHash: "not-a-hash" }, { recipientHash: "Fixture recipient name" }]) {
      assert.equal((await invoke(weddings, "simple-payout-request", { ...request, ...patch })).statusCode, 400);
      assert.equal(calls.length, 0);
    }
    rejected = true;
    assert.equal((await invoke(weddings, "simple-payout-request", request)).statusCode, 409);
  } finally { globalThis.fetch = oldFetch; for (const [k,v] of Object.entries(saved)) v===undefined ? delete process.env[k] : process.env[k]=v; }
});
