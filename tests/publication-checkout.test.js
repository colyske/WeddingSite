import test from "node:test";
import assert from "node:assert/strict";
import weddings from "../api/weddings.js";
import webhooks from "../api/webhooks.js";
import { createHmac } from "node:crypto";
import { reconcilePublicationCallback } from "../server/publication-payments.js";
import { Readable } from "node:stream";

const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const paymentId = "550e8400-e29b-41d4-a716-446655440001";
const clientId = "550e8400-e29b-41d4-a716-446655440002";
const result = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
  setHeader() {}, end(body) { this.body = JSON.parse(body); }, json(body) { this.body = body; return this; } });

test("authenticated publication checkout locks a server quote, blocks duplicates and independently verifies settlement", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    WEDDINGSITE_PAYMENT_MODE: "test", WEDDINGSITE_PUBLIC_ORIGIN: "https://www.joinourwedding.site",
    PAYSTACK_SECRET_KEY: "sk_test_publication", PAYSTACK_SUPPORTED_CURRENCIES: "KES", PAYSTACK_SUPPORTED_MARKETS: "KE",
    TURNSTILE_SITE_KEY: "fixture-site", TURNSTILE_SECRET_KEY: "fixture-secret" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  let owned = true, enabled = ["paystack"], quoteAmount = 5000, creates = 0, claims = 0, settlements = 0;
  let checkout = null, verifyStatus = "pending", badAmount = false, ambiguous = false;
  const paths = [];
  const quote = () => ({ fee_minor: quoteAmount, usd_amount_minor: 5000, fx_snapshot_id: paymentId,
    currency: "KES", code: "far_future", reason: "Far-future fee applies." });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    paths.push(url.pathname);
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : {};
    if (url.pathname === "/auth/v1/user") return Response.json({ id: clientId });
    if (url.pathname === "/rest/v1/weddings") return Response.json(owned ? [{ id: weddingId, currency: "KES" }] : []);
    if (url.pathname === "/rest/v1/rpc/publication_quote") return Response.json(quote());
    if (url.pathname === "/rest/v1/publication_fx_snapshots") return Response.json([
      { published_at: new Date().toISOString(), rates: { USD: 1, KES: 1 } }
    ]);
    if (url.pathname === "/rest/v1/platform_policies") return Response.json([{ enabled_payment_providers: enabled }]);
    if (url.pathname === "/integration/payment_session_timeout") return Response.json({ status: true });
    if (url.pathname === "/turnstile/v0/siteverify") return Response.json({ success: true, hostname: "www.joinourwedding.site" });
    if (url.pathname === "/rest/v1/rpc/begin_publication_checkout") {
      assert.equal(body.p_provider, "paystack");
      assert.equal(body.p_expected_amount, 5000);
      checkout ||= { id: paymentId, wedding_id: weddingId, client_id: clientId, amount_minor: 5000, currency: "KES",
        provider: "paystack", idempotency_key: paymentId, status: "pending", initialization_started_at: null };
      return Response.json({ ...checkout });
    }
    if (url.pathname === "/rest/v1/publication_checkouts") {
      if (init.method === "PATCH") {
        if (body.initialization_started_at) {
          claims++;
          if (checkout.initialization_started_at) return Response.json([]);
        }
        Object.assign(checkout, body);
        return Response.json(init.headers?.Prefer === "return=minimal" ? null : [{ ...checkout }]);
      }
      return Response.json(checkout ? [{ ...checkout }] : []);
    }
    if (url.pathname === "/transaction/initialize") {
      creates++;
      assert.equal(body.amount, 5000);
      assert.equal(body.metadata.payment_kind, "publication");
      assert.equal(new URL(body.callback_url).pathname, "/wedding.html");
      assert.equal(new URL(body.callback_url).searchParams.get("publicationReturn"), paymentId);
      if (ambiguous) throw new Error("Synthetic ambiguous provider timeout");
      return Response.json({ status: true, data: { reference: paymentId, authorization_url: "https://checkout.paystack.com/fixture" } });
    }
    if (url.pathname.startsWith("/transaction/verify/")) return Response.json({ status: true,
      data: { id: "fixture-payment", reference: paymentId, metadata: { contribution_id: paymentId },
        status: verifyStatus, amount: badAmount ? 1 : 5000, currency: "KES", fees: 100 } });
    if (url.pathname === "/rest/v1/rpc/record_verified_publication_payment") {
      if (body.p_amount_minor !== checkout.amount_minor) return Response.json({ message: "Verified publication payment does not match" }, { status: 400 });
      settlements++;
      checkout.status = "paid";
      return Response.json(true);
    }
    throw new Error(`Unexpected external request: ${url.pathname}`);
  };
  const invoke = async (action, body, extra = {}) => {
    const res = result();
    await weddings({ method: body ? "POST" : "GET", headers: { authorization: "Bearer fixture-token", origin: env.WEDDINGSITE_PUBLIC_ORIGIN },
      query: { action: `publication-${action}`, weddingId, ...extra }, body }, res);
    return res;
  };
  const body = { weddingId, method: "card", confirmed: true, expectedAmountMinor: 5000, expectedCurrency: "KES",
    expectedUsdAmountMinor: 5000, expectedFxId: paymentId,
    idempotencyKey: paymentId, email: "sample@example.com", captchaToken: "fixture-token", amountMinor: 1, provider: "daraja" };
  try {
    assert.deepEqual((await invoke("options")).body.methods.map(({ id, label }) => ({ id, label })), [{ id: "card", label: "Card" }]);
    owned = false;
    assert.equal((await invoke("create", body)).statusCode, 404);
    owned = true;
    quoteAmount = 9000;
    assert.equal((await invoke("create", body)).statusCode, 409);
    quoteAmount = 5000;
    enabled = [];
    assert.equal((await invoke("create", body)).statusCode, 409);
    enabled = ["paystack"];
    const created = await invoke("create", body);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.checkout.testMode, true);
    assert.equal(creates, 1);
    assert.equal((await invoke("create", body)).statusCode, 200);
    assert.equal(creates, 1, "duplicate request never calls initialize again");
    assert.equal(claims, 1);
    assert.equal((await invoke("status", null, { id: paymentId })).body.checkout.status, "pending");
    verifyStatus = "success";
    badAmount = true;
    assert.equal((await invoke("status", null, { id: paymentId })).statusCode, 503);
    assert.equal(settlements, 0);
    badAmount = false;
    enabled = [];
    assert.equal((await invoke("status", null, { id: paymentId })).body.checkout.status, "paid");
    assert.equal(settlements, 1, "disabled provider still verifies its existing payment");
    assert.equal((await invoke("status", null, { id: paymentId })).body.checkout.status, "paid");
    assert.equal(settlements, 1);
    assert.ok(!paths.some(path => path.includes("contributions") || path.includes("record_verified_payment")));
    checkout = null;
    enabled = ["paystack"];
    ambiguous = true;
    const uncertain = await invoke("create", body);
    assert.equal(uncertain.statusCode, 503);
    assert.equal(uncertain.body.checkout.status, "review");
    assert.equal((await invoke("create", body)).statusCode, 200);
    assert.equal(creates, 2, "uncertain provider initiation must never automatically retry");
    assert.equal((await invoke("options")).body.checkout.status, "review");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("unsigned publication STK callbacks require query confirmation and cannot credit the wedding", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    WEDDINGSITE_PAYMENT_MODE: "test", WEDDINGSITE_PUBLIC_ORIGIN: "https://www.joinourwedding.site",
    DARAJA_ENVIRONMENT: "sandbox", DARAJA_CONSUMER_KEY: "fixture-publication-callback",
    DARAJA_CONSUMER_SECRET: "fixture-secret", DARAJA_SHORTCODE: "174379", DARAJA_PASSKEY: "fixture-passkey" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  const row = { id: paymentId, provider: "daraja", provider_reference: "fixture-stk", amount_minor: 5000,
    currency: "KES", status: "pending" };
  let code = "1032", queries = 0, settled = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/rest/v1/publication_checkouts") {
      if (init.method === "PATCH") Object.assign(row, JSON.parse(init.body));
      return Response.json([{ ...row }]);
    }
    if (url.pathname === "/oauth/v1/generate") return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.pathname === "/mpesa/stkpushquery/v1/query") {
      queries++;
      return Response.json({ ResponseCode: "0", ResultCode: code, CheckoutRequestID: "fixture-stk" });
    }
    assert.equal(url.pathname, "/rest/v1/rpc/record_verified_publication_payment", "never touches the guest settlement/ledger");
    const body = JSON.parse(init.body);
    assert.equal(body.p_amount_minor, 5000);
    settled++;
    row.status = "paid";
    return Response.json(true);
  };
  try {
    const callback = amount => ({ Body: { stkCallback: { CheckoutRequestID: "fixture-stk",
      ResultCode: 0, CallbackMetadata: { Item: [{ Name: "Amount", Value: amount }] } } } });
    await assert.rejects(() => reconcilePublicationCallback(callback(1)), /amount does not match/);
    assert.equal(queries, 0);
    assert.equal(await reconcilePublicationCallback(callback(50)), false);
    assert.equal(row.status, "failed");
    assert.equal(settled, 0);
    row.status = "pending";
    code = "0";
    assert.equal(await reconcilePublicationCallback(callback(50)), true);
    assert.equal(queries, 2);
    assert.equal(settled, 1);
    assert.equal(await reconcilePublicationCallback(callback(50)), true);
    assert.equal(settled, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("signed publication webhook routes only to dedicated settlement, never to the wedding ledger", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    WEDDINGSITE_PAYMENT_MODE: "test", PAYSTACK_SECRET_KEY: "sk_test_publication_hook" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  const paths = [];
  globalThis.fetch = async (input, init) => {
    paths.push(new URL(input).pathname);
    assert.equal(new URL(input).pathname, "/rest/v1/rpc/record_verified_publication_payment");
    const body = JSON.parse(init.body);
    assert.equal(body.p_checkout_id, paymentId);
    assert.equal(body.p_amount_minor, 5000);
    return Response.json(true);
  };
  try {
    const raw = Buffer.from(JSON.stringify({ event: "charge.success", data: {
      id: 1, status: "success", reference: "fixture-reference", amount: 5000, currency: "KES", fees: 100,
      metadata: { contribution_id: paymentId, payment_kind: "publication" }
    } }));
    for (const signature of ["invalid", createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(raw).digest("hex")]) {
      const req = Readable.from([raw]);
      req.method = "POST"; req.query = { provider: "paystack" }; req.headers = { "x-paystack-signature": signature };
      const res = result();
      await webhooks(req, res);
      assert.equal(res.statusCode, signature === "invalid" ? 400 : 200);
    }
    assert.equal(paths.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
