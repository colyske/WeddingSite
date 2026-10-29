import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import finance from "../api/finance.js";
import weddings from "../api/weddings.js";
import admin from "../api/admin.js";

const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const payoutId = "550e8400-e29b-41d4-a716-446655440001";
const userId = "550e8400-e29b-41d4-a716-446655440002";
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const res = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  setHeader() {},
  end(body) { this.body = JSON.parse(body); },
  json(body) { this.body = body; return this; }
});

test("payout migration guards requests, approvals and sent transitions without gating cancellation or publishing", async () => {
  const sql = await read("supabase/migrations/202610300008_payout_kyc_gate.sql");
  assert.equal((sql.match(/not public\.kyc_is_complete/g) || []).length, 2);
  assert.match(sql, /if p_status in \('approved', 'sent'\) then[\s\S]+not public\.kyc_is_complete\(p\.wedding_id\)/);
  assert.ok(sql.indexOf("PAYOUT_KYC_REQUIRED") < sql.indexOf("insert into public.payout_records"));
  assert.match(sql, /for share;/);
  assert.match(sql, /Another staff member must approve/);
  assert.match(sql, /settled net balance after provider fees, refunds, disputes and holds/);
  assert.doesNotMatch(sql, /create or replace function public\.publish_wedding/);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to anon/);
});

test("all payout APIs return a clear KYC-required error; completed KYC retains success paths", async () => {
  const env = { SUPABASE_URL: "https://db.example.test", SUPABASE_ANON_KEY: "test-anon" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  let blocked = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: userId });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{ platform_role: "admin" }]);
    if (url.pathname === "/rest/v1/weddings") return Response.json([{ id: weddingId, currency: "KES" }]);
    if (["/rest/v1/rpc/request_payout", "/rest/v1/rpc/admin_set_payout_status"].includes(url.pathname)) {
      assert.equal(init.method, "POST");
      if (blocked) return Response.json({ message: "PAYOUT_KYC_REQUIRED: Complete KYC to receive your payout." }, { status: 400 });
      return Response.json(url.pathname.endsWith("request_payout") ? payoutId : true);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const cases = [
    [finance, { action: "record" }, { action: "payout_request", weddingId, amountMinor: 1000, currency: "KES", confirmed: true }],
    [weddings, { action: "withdraw", weddingId }, { weddingId, amountMinor: 1000, confirmed: true }],
    [admin, { action: "payout-status" }, { payout_id: payoutId, status: "approved" }],
    [admin, { action: "payout-status" }, { payout_id: payoutId, status: "sent" }]
  ];
  try {
    for (const [handler, query, body] of cases) {
      const response = res();
      await handler({ method: "POST", query, body, headers: { authorization: "Bearer test-token" } }, response);
      assert.equal(response.statusCode, 409);
      assert.equal(response.body.error, "Complete KYC to receive your payout.");
      assert.equal(response.body.kycRequired, true);
      if (handler !== admin) assert.equal(response.body.kycUrl, `/wedding.html?id=${weddingId}#kyc-section`);
    }
    blocked = false;
    for (const [handler, query, body] of cases) {
      const response = res();
      await handler({ method: "POST", query, body, headers: { authorization: "Bearer test-token" } }, response);
      assert.equal(response.statusCode, handler === admin ? 200 : 201);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("payout notices link to KYC without adding it back into site setup", async () => {
  const [editor, backoffice, progress] = await Promise.all([
    read("wedding.html"), read("backoffice.js"), read("setup-progress.js")
  ]);
  assert.match(editor, /id="payout-kyc-notice"[\s\S]*?href="#kyc-section"/);
  assert.match(editor, /if \(data\.kycRequired\)[\s\S]*?\$\("kyc-section"\)\.scrollIntoView/);
  assert.match(backoffice, /wedding\.html\?id=\$\{encodeURIComponent\(p\.wedding_id\)\}#kyc-section/);
  assert.doesNotMatch(progress, /kyc-section/);
});
