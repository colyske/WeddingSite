import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import admin from "../api/admin.js";
import weddings from "../api/weddings.js";
import { manualPayoutCommand } from "../server/manual-payouts.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const request = { key: id, wedding: id, custody: id, recipient: id, amount: 1000, fee: 0, currency: "KES", confirmed: true };
const res = () => ({
  status(code) { this.statusCode = code; return this; }, setHeader() {},
  end(body) { this.data = JSON.parse(body); }, json(body) { this.data = body; }
});

test("manual payout commands whitelist immutable inputs, reject unsafe values and protect Owner policy", () => {
  const command = manualPayoutCommand("request", request, "superadmin");
  assert.equal(command.rpc, "manual_payout_request");
  assert.deepEqual(command.args, { p_key: id, p_wedding: id, p_custody: id, p_recipient: id, p_amount: 1000, p_fee: 0, p_currency: "KES" });
  for (const patch of [{ amount: 0 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { fee: -1 }, { fee: null },
    { key: "not-an-id" }, { currency: "kes" }, { confirmed: false }, { bankAccount: "never accepted" }, { note: "no free text" }]) {
    assert.equal(manualPayoutCommand("request", { ...request, ...patch }, "owner").status, 400);
  }
  for (const role of ["admin", "client", "helper", undefined]) {
    assert.equal(manualPayoutCommand("request", request, role).status, 403);
  }
  const policy = { kind: "policy", reference: id, sha256: "a".repeat(64), confirmed: true };
  assert.equal(manualPayoutCommand("evidence", policy, "superadmin").status, 403);
  assert.equal(manualPayoutCommand("evidence", policy, "owner").rpc, "manual_payout_submit_evidence");
  assert.equal(manualPayoutCommand("transition", { id, action: "executing", key: id, evidence: null, confirmed: true }, "owner").rpc, "manual_payout_transition");
  assert.equal(manualPayoutCommand("transition", { id, action: "sent", key: null, evidence: null, confirmed: true }, "owner").status, 400);
});

test("manual payout API rejects nonleaders, preserves token, surfaces OFF and retires legacy sent", async () => {
  const oldFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "fixture" });
  let role = "admin", blocked = true, calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    if (url.pathname === "/rest/v1/weddings") return Response.json([{ id, currency: "KES" }]);
    calls.push({ path: url.pathname, body: JSON.parse(init.body || "{}"), token: init.headers.Authorization });
    if (url.pathname === "/rest/v1/rpc/manual_payout_request") {
      if (blocked) return Response.json({ message: "MANUAL_PAYOUT_BLOCKED: separate approval required" }, { status: 400 });
      return Response.json(id);
    }
    if (url.pathname === "/rest/v1/rpc/manual_payout_overview") return Response.json({ enabled: false, requests: [] });
    if (url.pathname === "/rest/v1/rpc/manual_payout_history") return Response.json([{ id, status: "reported", amount_minor: 1000, currency: "KES" }]);
    if (url.pathname === "/rest/v1/payout_records") return Response.json([]);
    throw new Error("Unexpected RPC: " + url.pathname);
  };
  const invoke = async (action, body = {}, method = "POST", handler = admin) => {
    calls = [];
    const response = res();
    await handler({ method, query: { action, weddingId: id }, headers: { authorization: "Bearer fixture" }, body }, response);
    return response;
  };
  try {
    for (const action of ["manual-payout-request", "manual-payout-transition", "manual-payouts", "payout-status"]) {
      assert.equal((await invoke(action, request, action === "manual-payouts" ? "GET" : "POST")).statusCode, 403);
      assert.equal(calls.length, 0);
    }
    role = "superadmin";
    assert.equal((await invoke("manual-payout-request", request)).statusCode, 409);
    assert.equal(calls[0].token, "Bearer fixture");
    blocked = false;
    assert.equal((await invoke("manual-payout-request", request)).statusCode, 200);
    assert.equal(calls[0].body.p_fee, 0);
    for (const status of ["approved", "sent"]) {
      assert.equal((await invoke("payout-status", { payout_id: id, status })).statusCode, 409);
      assert.equal(calls.length, 0);
    }
    assert.equal((await invoke("manual-payout-evidence", { kind: "policy", reference: id, sha256: "a".repeat(64), confirmed: true })).statusCode, 403);
    assert.equal(calls.length, 0);
    const history = await invoke("withdrawals", {}, "GET", weddings);
    assert.equal(history.statusCode, 200);
    assert.equal(history.data.manualEnabled, false);
    assert.equal(history.data.manualWithdrawals[0].status, "reported");
    assert.equal(calls.find(c => c.path.endsWith("manual_payout_history")).body.p_wedding, id);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("manual payout schema keeps legacy live gate and immutable single execution controls", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202611110001_controlled_manual_payouts.sql", import.meta.url), "utf8");
  assert.match(sql, /enabled boolean not null default false check \(enabled = false\)/);
  assert.doesNotMatch(sql, /create or replace function public\.live_payouts_enabled|update public\.contributions|update public\.payout_records/i);
  assert.match(sql, /payout_id uuid primary key references public.manual_payout_requests/);
  assert.match(sql, /unique\(provider, account_reference, transaction_reference\)/);
  assert.match(sql, /contribution_id uuid primary key/);
  assert.match(sql, /execution_channel<>'manual_external'/);
  assert.match(sql, /if p_kind = 'policy' then perform public.require_staff\('owner'\)/);
  assert.doesNotMatch(sql, /interval '[^']+'|grant .* to service_role/i);
});
