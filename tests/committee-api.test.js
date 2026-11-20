import test from "node:test";
import assert from "node:assert/strict";
import team from "../api/team.js";

const weddingId = "52000000-0000-4000-8000-000000000001";
const recordId = "52000000-0000-4000-8000-000000000002";
const response = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const makeResponse = () => ({
  status(code) { this.statusCode = code; return this; },
  setHeader() {},
  end(value) { this.body = JSON.parse(value); }
});

test("committee API validates input, uses caller token and preserves authorization failures", async t => {
  const originalFetch = globalThis.fetch;
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_ANON_KEY = "test-anon";
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === "/auth/v1/user") return response({ id: recordId });
    calls.push({ path, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
    if (path.endsWith("review_committee_suggestion")) {
      return new Response(JSON.stringify({ message: "Only the couple can review committee suggestions." }), { status: 403 });
    }
    return response(recordId);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const invoke = async (action, body, method = "POST") => {
    const res = makeResponse();
    await team({ method, query: { action, weddingId }, headers: { authorization: "Bearer helper-token" }, body }, res);
    return res;
  };
  const body = { weddingId, meetingDate: "2026-11-19", committee: "Planning", notes: "Private", category: "guest", suggestion: "Guest wording" };
  assert.equal((await invoke("committee-create", { ...body, meetingDate: "2026-02-30" })).statusCode, 400);
  assert.equal((await invoke("committee-create", { ...body, notes: "  " })).statusCode, 400);
  assert.equal((await invoke("committee-create", body)).statusCode, 201);
  assert.equal(calls[0].authorization, "Bearer helper-token");
  assert.equal(calls[0].body.p_suggestion, "Guest wording");
  assert.equal((await invoke("committee-task", { weddingId, recordId, done: "true" })).statusCode, 400);
  assert.equal((await invoke("committee-review", { weddingId, recordId, status: "approved" })).statusCode, 403);
  assert.equal((await invoke("committee-list", {}, "GET")).statusCode, 200);
  assert.deepEqual(calls.map(call => call.path.split("/").pop()), ["create_committee_record", "review_committee_suggestion", "get_committee_records"]);
});
