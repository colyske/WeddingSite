import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import team from "../api/team.js";
import guest from "../api/guest.js";
import { readFile } from "node:fs/promises";

const weddingId = "52000000-0000-4000-8000-000000000001";
const inviteId = "52000000-0000-4000-8000-000000000002";
const response = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const makeResponse = () => ({
  statusCode: 200,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name] = value; },
  json(body) { this.body = body; },
  end(body) { this.body = JSON.parse(body); }
});

test("wedding-team migration separates least-privilege team roles from workspace membership", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202611030001_wedding_team_delegation.sql", import.meta.url), "utf8");
  assert.match(migration, /role in \('checkin', 'usher', 'coordinator', 'rsvp_support', 'dj'\)/);
  assert.match(migration, /token_hash text not null unique/);
  assert.match(migration, /for update/);
  assert.match(migration, /on conflict on constraint wedding_team_members_pkey do update/);
  assert.match(migration, /expires_at = excluded\.expires_at/);
  assert.match(migration, /v_date \+ 2/);
  assert.match(migration, /set_wedding_team_member_expiry/);
  assert.match(migration, /w\.client_owner_id = i\.created_by/);
  assert.match(migration, /select lower\(u\.email\) into v_email from auth\.users u where u\.id = auth\.uid\(\)/);
  assert.match(migration, /v_email = i\.invitee_email/);
  assert.match(migration, /m\.revoked_at is null/);
  assert.match(migration, /m\.expires_at > now\(\)/);
  assert.match(migration, /b\.payment_status = 'paid'/);
  assert.doesNotMatch(migration, /insert into public\.wedding_memberships/);
  assert.doesNotMatch(migration, /alter type public\.workspace_role/);
  assert.match(migration, /revoke all on function public\.get_guest_verification\(uuid\) from public, anon/);
});

test("invite API stores only a hash and reports link-only delivery", async t => {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
  };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/auth/v1/user") return response({ id: "51000000-0000-4000-8000-000000000001", email: "couple@example.test" });
    if (url.pathname === "/rest/v1/rpc/create_wedding_team_invite") return response(inviteId);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const res = makeResponse();
  await team({
    method: "POST",
    query: { action: "invite" },
    headers: { authorization: "Bearer user-token" },
    body: { weddingId, role: "usher", email: " Usher@Example.Test " }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.delivery, "link_created_not_sent");
  assert.equal(res.body.expiresInDays, 7);
  assert.match(res.body.inviteLink, /^\/team-invite\.html\?token=[A-Za-z0-9_-]{43}$/);
  const rawToken = new URL(res.body.inviteLink, "https://wedding.example.test").searchParams.get("token");
  assert.notEqual(calls[1].body.p_token_hash, rawToken);
  assert.equal(calls[1].body.p_token_hash, createHash("sha256").update(rawToken).digest("hex"));
  assert.equal(calls[1].body.p_invitee_email, "usher@example.test");
  assert.equal(calls[1].body.p_expires_days, 7);
  assert.equal(calls[1].body.p_grant_expires_at, null);
  assert.equal(calls[1].body.p_no_expiry, false);
  assert.deepEqual(calls.map(call => call.path), ["/auth/v1/user", "/rest/v1/rpc/create_wedding_team_invite"]);
});

test("team API validates grant expiry and forwards only explicit expiry choices", async t => {
  const originalFetch = globalThis.fetch;
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(input).pathname;
    if (path === "/auth/v1/user") return response({ id: weddingId, email: "couple@example.test" });
    calls.push({ path, body: JSON.parse(init.body) });
    return response(path.endsWith("create_wedding_team_invite") ? inviteId : true);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const invoke = async (action, body, method = "POST") => {
    const res = makeResponse();
    await team({ method, query: { action }, headers: { authorization: "Bearer expiry-test" }, body }, res);
    return res;
  };
  const base = { weddingId, role: "dj", email: "dj@example.test" };
  for (const choice of [
    { expiryMode: "none" },
    { expiryMode: "custom", grantExpiresAt: "2099-01-01T12:00:00+03:00" }
  ]) {
    assert.equal((await invoke("invite", { ...base, ...choice })).statusCode, 201);
  }
  assert.equal(calls[0].body.p_no_expiry, true);
  assert.equal(calls[0].body.p_grant_expires_at, null);
  assert.equal(calls[1].body.p_no_expiry, false);
  assert.equal(calls[1].body.p_grant_expires_at, "2099-01-01T09:00:00.000Z");
  for (const choice of [
    { expiryMode: "forever" },
    { expiryMode: "custom", grantExpiresAt: "not-a-date" },
    { expiryMode: "custom", grantExpiresAt: "2000-01-01T00:00:00Z" },
    { expiryMode: "none", grantExpiresAt: "2099-01-01T00:00:00Z" }
  ]) {
    assert.equal((await invoke("invite", { ...base, ...choice })).statusCode, 400);
  }
  assert.equal(calls.length, 2);
  assert.equal((await invoke("set-expiry", {
    weddingId, userId: inviteId, expiryMode: "custom", grantExpiresAt: "2000-01-01T00:00:00Z"
  })).statusCode, 200);
  assert.equal(calls[2].path, "/rest/v1/rpc/set_wedding_team_member_expiry");
  assert.equal(calls[2].body.p_grant_expires_at, "2000-01-01T00:00:00.000Z");
  assert.equal((await invoke("set-expiry", { weddingId, userId: inviteId, expiryMode: "none" })).statusCode, 200);
  assert.equal(calls[3].body.p_no_expiry, true);
  assert.equal((await invoke("set-expiry", {}, "GET")).statusCode, 405);
});

test("team API preserves expired or revoked role denials from SQL", async t => {
  const originalFetch = globalThis.fetch;
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  let role = "checkin";
  globalThis.fetch = async input => {
    const path = new URL(input).pathname;
    if (path === "/auth/v1/user") return response({ id: inviteId, email: `${role}@example.test` });
    return new Response(JSON.stringify({ message: "Wedding team access denied." }), {
      status: 403, headers: { "Content-Type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (role of ["checkin", "usher", "dj", "rsvp_support"]) {
    const res = makeResponse();
    await team({ method: "GET", query: { action: "workspace", weddingId },
      headers: { authorization: "Bearer expired-helper" } }, res);
    assert.equal(res.statusCode, 403, role);
    assert.equal(res.body.workspace, undefined);
  }
});

test("team API requires auth, validates roles and exposes invite acceptance only as POST", async t => {
  const originalFetch = globalThis.fetch;
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
  };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/auth/v1/user") {
      if (init.headers.Authorization !== "Bearer user-token") return new Response("{}", { status: 401 });
      return response({ id: "51000000-0000-4000-8000-000000000001", email: "helper@example.test" });
    }
    if (url.pathname === "/rest/v1/rpc/get_wedding_team_invite") {
      return response([{ wedding_id: weddingId, couple_names: "Couple", role: "usher", invitee_email: "helper@example.test" }]);
    }
    if (url.pathname === "/rest/v1/rpc/redeem_wedding_team_invite") {
      return response([{ wedding_id: weddingId, couple_names: "Couple", role: "usher" }]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const token = "A".repeat(43);
  let res = makeResponse();
  await team({ method: "GET", query: { action: "invite-details", token }, headers: { authorization: "Bearer user-token" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invite.role, "usher");
  assert.equal(calls[1].body.p_token_hash, createHash("sha256").update(token).digest("hex"));

  res = makeResponse();
  await team({ method: "GET", query: { action: "accept" }, headers: { authorization: "Bearer user-token" } }, res);
  assert.equal(res.statusCode, 405);

  res = makeResponse();
  await team({
    method: "POST",
    query: { action: "accept" },
    headers: { authorization: "Bearer user-token" },
    body: { token }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted.role, "usher");

  res = makeResponse();
  await team({
    method: "POST",
    query: { action: "invite" },
    headers: { authorization: "Bearer user-token" },
    body: { weddingId, role: "admin", email: "helper@example.test" }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.filter(call => call.path.startsWith("/rest/v1/rpc/")).length, 2);

  res = makeResponse();
  await team({ method: "GET", query: { action: "workspace", weddingId }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("QR verification API requires a signed-in wedding helper and calls the authorized RPC", async t => {
  const originalFetch = globalThis.fetch;
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
  };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, authorization: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/auth/v1/user") return response({ id: "51000000-0000-4000-8000-000000000011" });
    if (url.pathname === "/rest/v1/rpc/get_guest_verification") return response([{
      rsvp_id: "53000000-0000-4000-8000-000000000001",
      wedding_id: weddingId,
      guest_name: "Guest"
    }]);
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let res = makeResponse();
  await guest({
    method: "GET",
    query: { action: "verify-qr", code: "53000000-0000-4000-8000-000000000001" },
    headers: { authorization: "Bearer helper-token" },
    socket: {}
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[1].path, "/rest/v1/rpc/get_guest_verification");
  assert.equal(calls[1].authorization, "Bearer helper-token");

  res = makeResponse();
  await guest({
    method: "GET",
    query: { action: "verify-qr", code: "53000000-0000-4000-8000-000000000001" },
    headers: {},
    socket: {}
  }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.filter(call => call.path === "/rest/v1/rpc/get_guest_verification").length, 1);
});
