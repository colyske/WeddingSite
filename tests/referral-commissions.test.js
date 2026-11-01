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
