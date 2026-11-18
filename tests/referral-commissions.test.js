import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import weddings from "../api/weddings.js";
import admin from "../api/admin.js";
import { referralError } from "../server/referral-errors.js";

const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const referral = (req, res) => weddings({ ...req, query: { ...req.query, client_referrals: "1" } }, res);
const uuid = "550e8400-e29b-41d4-a716-446655440000";
const response = () => ({
  setHeader() {}, status(code) { this.statusCode = code; return this; },
  json(data) { this.data = data; }, end(text) { this.data = JSON.parse(text); }
});

test("referral HTTP calls use actor JWT only, validate consent, and never invoke a provider", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, "https://db.example");
    if (path === "/auth/v1/user") return Response.json({ id: uuid });
    assert.match(path, /^\/rest\/v1\/rpc\/referral_/);
    calls.push({ path, options });
    return Response.json({ valid: true });
  };
  const invoke = async (action, method, body, authenticated = true) => {
    const res = response();
    await referral({ method, query: { action, code: "a".repeat(32) }, headers: authenticated ? { authorization: "Bearer actor-token" } : {}, body }, res);
    return res;
  };
  try {
    assert.equal((await invoke("validate", "GET", null, false)).statusCode, 200);
    assert.equal(calls.at(-1).options.headers.Authorization, "Bearer anon-fixture");
    assert.equal((await invoke("summary", "GET", null, false)).statusCode, 401);
    for (const action of ["summary", "disclosure"]) {
      assert.equal((await invoke(action, "GET")).statusCode, 200);
      assert.equal(calls.at(-1).options.headers.Authorization, "Bearer actor-token");
    }
    assert.equal((await invoke("capture", "POST", { code: "a".repeat(32), userId: "forged" })).statusCode, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { p_code: "a".repeat(32) });
    const count = calls.length;
    for (const body of [null, "not-json", { optedIn: true, termsVersion: "old" }, { optedIn: "true", termsVersion: "client-referrals-v1" }]) {
      assert.equal((await invoke("consent", "POST", body)).statusCode, 400);
    }
    assert.equal(calls.length, count);
    assert.equal((await invoke("consent", "POST", { optedIn: true, termsVersion: "client-referrals-v1" })).statusCode, 200);
    assert.equal((await invoke("capture", "GET", {})).statusCode, 405);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("referral leadership HTTP boundaries and stale Owner CAS are explicit", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  let role, stale = false;
  const calls = [];
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") return Response.json({ id: uuid });
    if (path === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    assert.match(path, /^\/rest\/v1\/rpc\/referral_/);
    calls.push(path);
    if (stale) return Response.json({ message: "REFERRAL_CONFLICT: Referral policy changed; reload." }, { status: 400 });
    return Response.json({});
  };
  const invoke = async (action, method = "GET") => {
    const res = response();
    await admin({ method, query: { action }, headers: { authorization: "Bearer actor-token" }, body: {
      enabled: true, rateBasisPoints: 100, revision: uuid, confirmed: true
    } }, res);
    return res;
  };
  try {
    for (role of ["client", "admin", "superadmin", "owner"]) {
      for (const action of ["referral-policy", "referral-history", "referral-ledger"]) {
        calls.length = 0;
        assert.equal((await invoke(action)).statusCode, ["owner", "superadmin"].includes(role) ? 200 : 403);
        if (!["owner", "superadmin"].includes(role)) assert.deepEqual(calls, []);
      }
      assert.equal((await invoke("referral-policy-save", "POST")).statusCode, role === "owner" ? 200 : 403);
    }
    role = "owner"; stale = true;
    const result = await invoke("referral-policy-save", "POST");
    assert.equal(result.statusCode, 409);
    assert.match(result.data.error, /policy changed/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("funding evidence requires leadership and never invokes payment providers", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  let role = "admin";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://db.example");
    if (parsed.pathname === "/auth/v1/user") return Response.json({ id: uuid });
    if (parsed.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    assert.match(parsed.pathname, /^\/rest\/v1\/rpc\/(?:referral|facilitator)_funding_/);
    calls.push({ path: parsed.pathname, body: JSON.parse(options.body), authorization: options.headers.Authorization });
    return Response.json(parsed.pathname.endsWith("_list") ? [] : uuid);
  };
  const invoke = async (action, method, body) => {
    const res = response();
    await admin({ method, query: { action }, headers: { authorization: "Bearer fixture" }, body }, res);
    return res;
  };
  const review = { contribution: uuid, settled: 1000, cost: 100, losses: 0, holds: 0,
    commitments: 0, reference: uuid, sha256: "a".repeat(64), confirmed: true };
  try {
    assert.equal((await invoke("referral-funding-create", "POST", review)).statusCode, 403);
    assert.equal((await invoke("referral-funding-reviews", "GET")).statusCode, 403);
    assert.equal(calls.length, 0);
    role = "superadmin";
    assert.equal((await invoke("referral-funding-create", "POST", review)).statusCode, 403);
    assert.equal((await invoke("referral-funding-check", "POST", { id: uuid, owner_solo: true, confirmed: true })).statusCode, 400);
    assert.equal((await invoke("referral-funding-check", "POST", { id: uuid, owner_solo: false, confirmed: true })).statusCode, 200);
    assert.equal(calls.at(-1).authorization, "Bearer fixture");
    role = "owner";
    for (const bad of [null, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await invoke("referral-funding-create", "POST", { ...review, cost: bad })).statusCode, 400);
    }
    assert.equal((await invoke("referral-funding-create", "POST", review)).statusCode, 200);
    assert.deepEqual(calls.at(-1).body, { p_contribution: uuid, p_settled: 1000, p_cost: 100,
      p_losses: 0, p_holds: 0, p_commitments: 0, p_reference: uuid, p_sha256: "a".repeat(64), p_confirmed: true });
    const inventory = { key: uuid, currency: "KES", custody_scope_reference: uuid,
      period_start: "2026-01-01T00:00:00Z", as_of: "2026-01-02T00:00:00Z",
      expires_at: "2026-01-03T00:00:00Z", cash_minor: 10000, unpaid_costs_minor: 500,
      holds_minor: 200, other_commitments_minor: 300, evidence_reference: uuid,
      evidence_sha256: "b".repeat(64), exclusive_platform_funded: true, confirmed: true };
    assert.equal((await invoke("facilitator-funding-create", "POST", { ...inventory, exclusive_platform_funded: false })).statusCode, 400);
    assert.equal((await invoke("facilitator-funding-create", "POST", inventory)).statusCode, 200);
    assert.equal(calls.at(-1).body.p_cash_minor, 10000);
    assert.equal(calls.at(-1).body.p_exclusive_platform_funded, true);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("adjustment conflict review requires leadership, actor JWT and an audited RPC", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  let role = "admin", fail = false;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://db.example");
    if (parsed.pathname === "/auth/v1/user") return Response.json({ id: uuid });
    if (parsed.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    assert.equal(parsed.pathname, "/rest/v1/rpc/admin_verified_adjustment_conflicts");
    calls.push({ authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    if (fail) return Response.json({ message: "database unavailable" }, { status: 500 });
    return Response.json([{ provider: "stripe", conflict_kind: "changed_delivery" }]);
  };
  const invoke = async method => {
    const headers = {};
    const res = response();
    res.setHeader = (key, value) => { headers[key] = value; };
    await admin({ method, query: { action: "verified-adjustment-conflicts" },
      headers: { authorization: "Bearer fixture-actor" }, body: {} }, res);
    return { res, headers };
  };
  try {
    for (role of ["client", "admin"]) {
      assert.equal((await invoke("POST")).res.statusCode, 403);
      assert.equal(calls.length, 0);
    }
    for (role of ["superadmin", "owner"]) {
      const { res, headers } = await invoke("POST");
      assert.equal(res.statusCode, 200);
      assert.equal(headers["Cache-Control"], "no-store");
      assert.deepEqual(res.data.conflicts, [{ provider: "stripe", conflict_kind: "changed_delivery" }]);
      assert.deepEqual(calls.at(-1), { authorization: "Bearer fixture-actor", body: {} });
    }
    assert.equal((await invoke("GET")).res.statusCode, 404);
    assert.equal(calls.length, 2);
    fail = true;
    assert.equal((await invoke("POST")).res.statusCode, 503);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("held-only schema, signed netting and grants have no financial activation", () => {
  const policy = read("supabase/migrations/202611040001_referral_attribution_policy.sql");
  const estimates = read("supabase/migrations/202611040002_referral_held_estimates.sql");
  assert.match(policy, /enabled boolean not null default false/);
  assert.match(policy, /rate_basis_points integer not null default 0/);
  assert.match(policy, /p_revision is distinct from p\.revision/);
  assert.match(policy, /referral_first_pending/);
  assert.match(policy, /referral_attribution_immutable/);
  assert.match(policy, /referral_snapshot_contribution after insert/);
  assert.match(estimates, /payment_environment='live'/);
  assert.match(estimates, /target-coalesce\(b\.held_estimate_minor,0\)/);
  assert.match(estimates, /'payable_minor','0'/);
  assert.match(estimates, /deferrable initially deferred/);
  assert.doesNotMatch(policy + estimates, /(?:update|insert into|alter table) public\.(?:payout|wedding_team|paystack)/i);
  assert.doesNotMatch(read("server/referrals.js"), /payment-adapters|paystack|checkout|service:\s*true/);
  assert.deepEqual(referralError(new Error("Self referral")), [403, "You cannot refer your own wedding or a linked client account."]);
  assert.deepEqual(referralError(new Error("opaque secret diagnostic")), [503, "The referral service could not complete the request."]);
});

test("client referral URL shares the wedding function within the Hobby deployment limit", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.deepEqual(config.rewrites.find(route => route.source === "/api/referrals"),
    { source: "/api/referrals", destination: "/api/weddings?client_referrals=1" });
  const apiFunctions = readdirSync(new URL("../api", import.meta.url)).filter(file => file.endsWith(".js"));
  assert.ok(apiFunctions.length + 1 <= 12, "API functions plus middleware must fit the 12-function deployment limit");
  assert.ok(!apiFunctions.includes("referrals.js"));
});
