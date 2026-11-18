import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import webhooks from "../api/webhooks.js";
import { runVerifiedAdjustmentWorker, stageVerifiedAdjustment } from "../server/verified-adjustment-inbox.js";

function response() {
  return {
    statusCode: 0, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = JSON.parse(value); }
  };
}

test("verified adjustment intake commits before processing and worker retries without provider calls", async () => {
  const savedFetch = globalThis.fetch;
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WEDDINGSITE_PAYMENT_MODE",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "VERIFIED_ADJUSTMENT_INBOX_ENABLED", "CRON_SECRET"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
    WEDDINGSITE_PAYMENT_MODE: "test", STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "synthetic-webhook-secret", VERIFIED_ADJUSTMENT_INBOX_ENABLED: "true",
    CRON_SECRET: "synthetic-cron-secret"
  });

  const calls = [];
  let processingFails = true;
  const id = "550e8400-e29b-41d4-a716-446655440000";
  globalThis.fetch = async (input, init) => {
    const name = new URL(input).pathname.split("/").at(-1);
    calls.push({ name, body: JSON.parse(init.body) });
    if (name === "stage_verified_adjustment") return Response.json({ id, conflict: false });
    if (name === "pending_verified_adjustments") return Response.json({ ids: [id], conflicts: 0 });
    if (name === "process_verified_adjustment") {
      return processingFails ? Response.json({ message: "Synthetic processing error" }, { status: 503 })
        : Response.json({ processed: true });
    }
    throw new Error(`Unexpected request: ${name}`);
  };
  try {
    const event = { id: "evt_inbox_test", type: "refund.created", created: 1794996000,
      data: { object: { id: "re_fixture", payment_intent: "pi_fixture", amount: 100,
        currency: "kes", status: "pending" } } };
    const raw = Buffer.from(JSON.stringify(event));
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${now}.${raw.toString("utf8")}`).digest("hex");
    const makeRequest = sig => {
      const req = Readable.from([raw]);
      req.method = "POST"; req.query = { provider: "stripe" };
      req.headers = { "stripe-signature": sig };
      return req;
    };
    let res = response();
    await webhooks(makeRequest("invalid"), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0, "Invalid signature cannot stage anything");
    res = response();
    await webhooks(makeRequest(`t=${now},v1=${signature}`), res);
    assert.equal(res.statusCode, 503, "Provider is asked to retry when processing fails");
    assert.deepEqual(calls.map(call => call.name), ["stage_verified_adjustment", "process_verified_adjustment"]);
    assert.equal(calls[0].body.p_payload_sha256, createHash("sha256").update(raw).digest("hex"));
    processingFails = false;
    res = response();
    await webhooks({ method: "GET", query: { action: "adjustment-worker" }, headers: {
      authorization: "Bearer synthetic-cron-secret"
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { processed: 1, failed: 0, conflicts: 0 });
    assert.deepEqual(calls.slice(2).map(call => call.name),
      ["pending_verified_adjustments", "process_verified_adjustment"]);
    res = response();
    await webhooks({ method: "GET", query: { action: "adjustment-worker" }, headers: {} }, res);
    assert.equal(res.statusCode, 401);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("worker reports conflicts and failed processing without dropping pending events", async () => {
  const savedFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-key";
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const name = new URL(input).pathname.split("/").at(-1);
    calls.push(name);
    if (name === "pending_verified_adjustments") return Response.json({ ids: ["fixture"], conflicts: 1 });
    if (name === "process_verified_adjustment") return Response.json({ message: "Synthetic failure" }, { status: 503 });
    if (name === "note_verified_adjustment_failure") return Response.json(null);
    if (name === "stage_verified_adjustment") return Response.json({ id: "fixture", conflict: true });
    throw new Error(`Unexpected request: ${name}`);
  };
  try {
    assert.deepEqual(await runVerifiedAdjustmentWorker(), { processed: 0, failed: 1, conflicts: 1 });
    assert.deepEqual(calls, ["pending_verified_adjustments", "process_verified_adjustment",
      "note_verified_adjustment_failure"]);
    await assert.rejects(stageVerifiedAdjustment({ provider: "stripe" }, "a".repeat(64)), /identity conflict/);
    assert.equal(calls.at(-1), "stage_verified_adjustment", "Conflicts never reach processing");
  } finally {
    globalThis.fetch = savedFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});
