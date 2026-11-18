import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import referrals from "../server/referrals.js";
import { referralError } from "../server/referral-errors.js";

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const response = () => ({
  setHeader() {},
  status(code) { this.statusCode = code; return this; },
  end(text) { this.data = JSON.parse(text); },
  json(data) { this.data = data; }
});

test("facilitator recipient API uses actor JWT, validates own consent and normalizes Kenyan M-Pesa numbers", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: uuid });
    assert.equal(url.origin, "https://db.example");
    calls.push({ path: url.pathname, options });
    return Response.json({ revision: uuid, status: "pending", idempotent: false });
  };
  const invoke = async (action, method, body) => {
    const res = response();
    await referrals({ method, query: { action }, headers: { authorization: "Bearer caller-token" }, body }, res);
    return res;
  };
  try {
    const payload = {
      requestKey: uuid, fullName: "  Facilitator Example ", phone: "0712 345 678",
      consent: true, consentVersion: "facilitator-mpesa-recipient-v1"
    };
    assert.equal((await invoke("recipient-submit", "POST", payload)).statusCode, 200);
    const savedCall = calls.at(-1);
    assert.equal(savedCall.path, "/rest/v1/rpc/facilitator_recipient_submit");
    assert.deepEqual(JSON.parse(savedCall.options.body), {
      p_request_key: uuid, p_full_name: "Facilitator Example", p_phone: "254712345678",
      p_consent: true, p_consent_version: "facilitator-mpesa-recipient-v1"
    });
    assert.equal(savedCall.options.headers.Authorization, "Bearer caller-token");

    const before = calls.length;
    for (const invalid of [
      { ...payload, consent: false },
      { ...payload, consentVersion: "old" },
      { ...payload, phone: "123" },
      { ...payload, requestKey: "bad" },
      { ...payload, other: "forged" }
    ]) assert.equal((await invoke("recipient-submit", "POST", invalid)).statusCode, 400);
    assert.equal(calls.length, before, "invalid registrations never reach PostgREST");
    assert.equal((await invoke("recipient-mine", "GET")).statusCode, 200);
    assert.equal(calls.at(-1).path, "/rest/v1/rpc/facilitator_recipient_mine");
    assert.equal((await invoke("recipient-submit", "GET", payload)).statusCode, 405);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("recipient review API is leadership-gated and makes owner-solo an explicit Owner-only choice", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon-fixture" });
  let role = "client";
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: uuid });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    calls.push({ path: url.pathname, options });
    return Response.json(url.pathname.endsWith("_workspace") ? [] : true);
  };
  const invoke = async (action, body, method = "POST") => {
    const res = response();
    await referrals({ method, query: { action }, headers: { authorization: "Bearer caller-token" }, body }, res);
    return res;
  };
  const verify = { revision: uuid, evidenceId: uuid, ownerSolo: false, confirmed: true };
  const evidence = { revision: uuid, reference: uuid, sha256: "a".repeat(64), confirmed: true };
  try {
    assert.equal((await invoke("recipient-workspace", null, "GET")).statusCode, 403);
    assert.equal((await invoke("recipient-evidence", evidence)).statusCode, 403);
    assert.equal(calls.length, 0);
    role = "superadmin";
    assert.equal((await invoke("recipient-workspace", null, "GET")).statusCode, 200);
    assert.equal(calls.at(-1).path, "/rest/v1/rpc/facilitator_recipient_workspace");
    assert.equal(calls.at(-1).options.headers.Authorization, "Bearer caller-token");
    assert.equal((await invoke("recipient-evidence", evidence)).statusCode, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
      p_revision: uuid, p_reference: uuid, p_sha256: "a".repeat(64), p_confirmed: true
    });
    assert.equal((await invoke("recipient-verify", { ...verify, ownerSolo: true })).statusCode, 403);
    assert.equal((await invoke("recipient-verify", verify)).statusCode, 200);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
      p_revision: uuid, p_evidence: uuid, p_owner_solo: false, p_confirmed: true
    });
    role = "owner";
    assert.equal((await invoke("recipient-verify", { ...verify, ownerSolo: true })).statusCode, 200);
    assert.equal(JSON.parse(calls.at(-1).options.body).p_owner_solo, true);
    assert.equal((await invoke("recipient-verify", { ...verify, unchecked: true })).statusCode, 400);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("recipient SQL contracts keep revisions immutable, private, audited and separate from payout processing", () => {
  const sql = read("supabase/migrations/202611240001_facilitator_recipients.sql");
  const fixture = read("tests/db/facilitator-recipients.sql");
  assert.match(sql, /ownership_attested boolean not null check \(ownership_attested\)/);
  assert.match(sql, /unique\(user_id, request_key\)/);
  assert.match(sql, /facilitator_recipient_versions_immutable/);
  assert.match(sql, /facilitator_recipient_evidence_immutable/);
  assert.match(sql, /facilitator_recipient_checks_immutable/);
  assert.match(sql, /facilitator_recipient_audit_immutable/);
  assert.match(sql, /action in\s*\('registered','self_reveal','owner_reveal','evidence_recorded','verified','payout_snapshot'\)/);
  assert.match(sql, /v\.revision_id is distinct from\s*\(select revision_id/);
  assert.match(sql, /p_owner_solo and role_name<>'owner'/);
  assert.match(sql, /facilitator_payout_recipient_ready\(p_user uuid,p_revision uuid\) returns boolean/);
  assert.match(sql, /facilitator_payout_recipient_details\(p_user uuid,p_revision uuid\) returns jsonb/);
  assert.match(sql, /revoke all on function public\.facilitator_payout_recipient_ready\(uuid,uuid\)/);
  assert.match(sql, /'expected_name',v\.full_name/);
  assert.match(sql, /auth\.uid\(\) is null or auth\.uid\(\) is distinct from p_user/);
  const ready = sql.split("create function public.facilitator_payout_recipient_ready")[1]
    .split("create function public.facilitator_payout_recipient_details")[0];
  assert.doesNotMatch(ready, /opted_in/);
  assert.match(sql, /where user_id=auth\.uid\(\)\) then/);
  assert.match(sql, /grant execute on function public\.facilitator_recipient_submit/);
  assert.doesNotMatch(sql, /wedding_kyc|daraja|paystack|update public\.payout_records|insert into public\.payout_records/i);
  assert.match(fixture, /withdrawing referral opt-in preserves verified recipient/);
  assert.match(fixture, /other user cannot reveal private recipient/);
  assert.match(fixture, /invalidates the previously checked destination/);
  assert.match(fixture, /explicit Owner-solo evidence review/);
  assert.match(fixture, /raw private recipient table is not directly readable/);
});

test("recipient UI requires own details and explicit consent and describes review honestly", () => {
  const html = read("referrals.html");
  const js = read("referrals.js");
  assert.match(html, /id="recipient-section"/);
  assert.match(html, /id="recipient-name"[^>]*required/);
  assert.match(html, /id="recipient-phone"[^>]*required/);
  assert.match(html, /id="recipient-consent" type="checkbox" required/);
  assert.match(html, /not provider identity verification or a payout/i);
  assert.match(html, /Updating these details supersedes older revisions/i);
  assert.match(js, /recipient-mine/);
  assert.match(js, /recipient-submit/);
  assert.match(js, /recipient-section"\)\.hidden = !account/);
  assert.match(js, /crypto\.randomUUID\(\)/);
  assert.match(js, /review of this exact revision/);
});

test("recipient database errors map to safe statuses without exposing arbitrary diagnostics", () => {
  assert.deepEqual(referralError(new Error("FACILITATOR_RECIPIENT_CONFLICT: Recipient revision is stale.")),
    [409, "Recipient revision is stale."]);
  assert.deepEqual(referralError(new Error("FACILITATOR_RECIPIENT_INPUT: Confirm the review.")),
    [400, "Confirm the review."]);
  assert.deepEqual(referralError(new Error("opaque database diagnostic")),
    [503, "The referral service could not complete the request."]);
});
