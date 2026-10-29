import test from "node:test";
import assert from "node:assert/strict";
import admin from "../api/admin.js";
import weddings from "../api/weddings.js";

test("moderation API requires actionable reasons, preserves caller credentials, and forwards revision checks", async () => {
  const savedFetch = globalThis.fetch;
  const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  Object.assign(process.env, { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "fixture" });
  const id = "550e8400-e29b-41d4-a716-446655440000";
  let role = "admin", calls = [], failure = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: role }]);
    calls.push({ path: url.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (failure) return Response.json({ message: "MODERATION: This case changed since you opened it. Reload before deciding." }, { status: 400 });
    return Response.json({ status: "submitted", revision: 2 });
  };
  const invoke = async (handler, action, body = {}, method = "POST") => {
    calls = [];
    const res = { setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(data) { this.data = data; }, end(text) { this.data = JSON.parse(text); } };
    await handler({ method, query: { action }, headers: { authorization: "Bearer moderation-fixture" }, body }, res);
    return res;
  };
  try {
    let result = await invoke(admin, "wedding-action", { wedding_id: id, action: "unpublish" });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(calls, []);
    const reason = { reason_code: "inaccurate_details", reason: "The venue address is inaccurate.", required_action: "Correct the venue address and map." };
    result = await invoke(admin, "wedding-action", { wedding_id: id, action: "unpublish", ...reason });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls[0].body, { p_wedding_id: id, p_action: "unpublish", p_reason_code: reason.reason_code, p_reason: reason.reason, p_required_action: reason.required_action });
    assert.equal(calls[0].auth, "Bearer moderation-fixture");
    result = await invoke(admin, "moderation-review", { case_id: id, decision: "return", expected_revision: 2, confirmed: true });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(calls, []);
    result = await invoke(admin, "moderation-review", { case_id: id, decision: "return", note: "Please correct the map link.", expected_revision: 2, confirmed: true });
    assert.equal(result.statusCode, 200);
    assert.equal(calls[0].body.p_expected_revision, 2);
    failure = true;
    result = await invoke(admin, "moderation-review", { case_id: id, decision: "lift", expected_revision: 2, confirmed: true });
    assert.equal(result.statusCode, 409);
    assert.match(result.data.error, /Reload/);
    failure = false;
    result = await invoke(admin, "payout-status", { payout_id: id, status: "cancelled" });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(calls, []);
    result = await invoke(admin, "payout-status", { payout_id: id, status: "cancelled", note: "Correct the payout account details." });
    assert.equal(result.statusCode, 200);
    role = "client";
    result = await invoke(admin, "moderation", {}, "GET");
    assert.equal(result.statusCode, 403);
    assert.deepEqual(calls, []);
    result = await invoke(weddings, "moderation-correction", { caseId: id, note: "short", expectedRevision: 1 });
    assert.equal(result.statusCode, 400);
    assert.deepEqual(calls, []);
    result = await invoke(weddings, "moderation-correction", { caseId: id, note: "I corrected the map link.", expectedRevision: 1 });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls[0].body, { p_case_id: id, p_note: "I corrected the map link.", p_expected_revision: 1 });
    assert.equal(calls[0].auth, "Bearer moderation-fixture");
    failure = true;
    result = await invoke(weddings, "moderation-correction", { caseId: id, note: "I corrected the map link.", expectedRevision: 1 });
    assert.equal(result.statusCode, 409);
    assert.match(result.data.error, /Reload/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
