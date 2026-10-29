import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import checkoutHandler, { paymentAdaptersFor } from "../api/checkout.js";
import webhooks from "../api/webhooks.js";
import {
  darajaPassword, darajaTimestamp, initiateDarajaStkPush, verifyProviderPayment
} from "../server/payment-adapters.js";

const environmentKeys = [
  "WEDDINGSITE_PAYMENT_MODE", "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT",
  "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"
];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  globalThis.fetch = originalFetch;
});

function useSandbox() {
  Object.assign(process.env, {
    WEDDINGSITE_PAYMENT_MODE: "test",
    WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example",
    DARAJA_ENVIRONMENT: "sandbox",
    DARAJA_CONSUMER_KEY: "sandbox-consumer-key",
    DARAJA_CONSUMER_SECRET: "sandbox-consumer-secret",
    DARAJA_SHORTCODE: "174379",
    DARAJA_PASSKEY: "sandbox-passkey"
  });
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

test("Daraja configuration is sandbox-only and limited to Kenya KES", () => {
  useSandbox();
  assert.deepEqual(paymentAdaptersFor("KES", "KE").map(item => item.id), ["daraja"]);
  assert.deepEqual(paymentAdaptersFor("USD", "KE"), []);
  assert.deepEqual(paymentAdaptersFor("KES", "UG"), []);
  process.env.WEDDINGSITE_PAYMENT_MODE = "live";
  assert.deepEqual(paymentAdaptersFor("KES", "KE"), []);
});

test("Daraja STK Push normalizes and validates a whole-KES sandbox checkout", async () => {
  useSandbox();
  assert.equal(darajaTimestamp(new Date("2026-10-28T07:00:00.000Z")), "20261028100000");
  assert.equal(
    darajaPassword("174379", "sandbox-passkey", "20261028100000"),
    Buffer.from("174379sandbox-passkey20261028100000").toString("base64")
  );
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.includes("/mpesa/stkpush/v1/processrequest")) {
      return response({ ResponseCode: "0", CheckoutRequestID: "ws_STK_001", MerchantRequestID: "merchant-001" });
    }
    throw new Error("Unexpected network request.");
  };
  const result = await initiateDarajaStkPush({
    amountMinor: 12500,
    phoneNumber: "254712345678",
    callbackUrl: "https://weddingsite.example/api/webhooks?provider=daraja",
    accountReference: "WS1234567890",
    description: "Wedding fundraiser"
  });
  assert.equal(result.reference, "ws_STK_001");
  assert.equal(calls[0].url, "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials");
  const request = calls[1];
  assert.equal(request.url, "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest");
  const body = JSON.parse(request.init.body);
  assert.equal(body.Amount, 125);
  assert.equal(body.PartyA, "254712345678");
  assert.equal(body.BusinessShortCode, "174379");
  assert.equal(body.CallBackURL, "https://weddingsite.example/api/webhooks?provider=daraja");
  await assert.rejects(() => initiateDarajaStkPush({
    amountMinor: 12550, phoneNumber: "254712345678",
    callbackUrl: "https://weddingsite.example/api/webhooks?provider=daraja",
    accountReference: "WS1234567890"
  }), /invalid/i);
  await assert.rejects(() => initiateDarajaStkPush({
    amountMinor: 12500, phoneNumber: "0712345678",
    callbackUrl: "https://weddingsite.example/api/webhooks?provider=daraja",
    accountReference: "WS1234567890"
  }), /invalid/i);
  await assert.rejects(() => initiateDarajaStkPush({
    amountMinor: 12500, phoneNumber: "254712345678",
    callbackUrl: "https://attacker.example/api/webhooks?provider=daraja",
    accountReference: "WS1234567890"
  }), /callback/i);
});

test("Daraja status comes from authenticated STK Query, not the callback payload", async () => {
  useSandbox();
  let resultCode = "1032";
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.includes("/mpesa/stkpushquery/v1/query")) {
      return response({ ResponseCode: "0", CheckoutRequestID: "ws_STK_001", ResultCode: resultCode });
    }
    throw new Error("Unexpected network request.");
  };
  const failed = await verifyProviderPayment("daraja", "ws_STK_001", "f8e5022e-fad8-4dc7-b222-c55e4f6ce190", 12500, "KES");
  assert.equal(failed.verified, false);
  assert.equal(failed.terminal, true);
  assert.equal(failed.resultCode, String(resultCode));
  resultCode = undefined;
  const pending = await verifyProviderPayment("daraja", "ws_STK_001", "f8e5022e-fad8-4dc7-b222-c55e4f6ce190", 12500, "KES");
  assert.equal(pending.verified, false);
  assert.equal(pending.terminal, undefined);
  resultCode = "0";
  const paid = await verifyProviderPayment("daraja", "ws_STK_001", "f8e5022e-fad8-4dc7-b222-c55e4f6ce190", 12500, "KES");
  assert.equal(paid.verified, true);
  assert.equal(paid.amountMinor, 12500);
  assert.equal(paid.currency, "KES");
  assert.equal(paid.providerPaymentReference, "ws_STK_001");
});

test("unsigned Daraja callback cannot confirm payment without successful STK Query", async () => {
  useSandbox();
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.includes("/mpesa/stkpushquery/v1/query")) {
      return response({ ResponseCode: "0", CheckoutRequestID: "ws_STK_001", ResultCode: "1032" });
    }
    if (url.startsWith(process.env.SUPABASE_URL)) {
      const path = new URL(url).pathname;
      if (path === "/rest/v1/contributions" && init.method === "GET") {
        return response([{
          id: "f8e5022e-fad8-4dc7-b222-c55e4f6ce190",
          pledged_amount_minor: 12500, currency: "KES", payment_status: "pending"
        }]);
      }
      if (path === "/rest/v1/contributions" && init.method === "PATCH") {
        writes.push({ kind: "cancelled" });
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/v1/rpc/record_verified_payment") {
        writes.push({ kind: "paid", body: JSON.parse(init.body) });
        return response(true);
      }
    }
    throw new Error("Unexpected network request.");
  };
  const req = {
    method: "POST",
    query: { provider: "daraja" },
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        Body: { stkCallback: { CheckoutRequestID: "ws_STK_001", ResultCode: 0 } }
      }));
    }
  };
  const res = {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; }
  };
  await webhooks(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes.map(item => item.kind), ["cancelled"]);
});

test("terminal status returns a sanitized query code without payment or song credit", async () => {
  useSandbox();
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  let state = "pending";
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.includes("/mpesa/stkpushquery/v1/query")) {
      return response({ ResponseCode: "0", CheckoutRequestID: "ws_STK_001", ResultCode: "1032", ResultDesc: "untrusted provider text" });
    }
    if (url.startsWith(process.env.SUPABASE_URL) && new URL(url).pathname === "/rest/v1/contributions") {
      if (init.method === "PATCH") {
        writes.push(JSON.parse(init.body));
        state = "cancelled";
        return new Response(null, { status: 204 });
      }
      return response([{
        id: "f8e5022e-fad8-4dc7-b222-c55e4f6ce190", payment_status: state,
        provider_name: "daraja", provider_reference: "ws_STK_001",
        pledged_amount_minor: 12500, currency: "KES", purchase_action: "song_bid"
      }]);
    }
    throw new Error("Unexpected request, including any settlement RPC.");
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(body) { this.body = JSON.parse(body); }
  };
  await checkoutHandler({ method: "GET", query: { action: "status", id: "f8e5022e-fad8-4dc7-b222-c55e4f6ce190" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, "cancelled");
  assert.equal(res.body.providerResultCode, "1032");
  assert.equal(res.body.actionResult, null);
  assert.notEqual(res.body.actionStatus, "completed");
  assert.ok(!JSON.stringify(res.body).includes("untrusted provider text"));
  assert.deepEqual(writes, [{ payment_status: "cancelled" }]);
});

test("successful Daraja callback records only the independently queried KES payment", async () => {
  useSandbox();
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  let recorded;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.includes("/mpesa/stkpushquery/v1/query")) {
      return response({ ResponseCode: "0", CheckoutRequestID: "ws_STK_001", ResultCode: "0" });
    }
    if (url.startsWith(process.env.SUPABASE_URL)) {
      const path = new URL(url).pathname;
      if (path === "/rest/v1/contributions") {
        return response([{
          id: "f8e5022e-fad8-4dc7-b222-c55e4f6ce190",
          pledged_amount_minor: 12500, currency: "KES", payment_status: "pending"
        }]);
      }
      if (path === "/rest/v1/rpc/record_verified_payment") {
        recorded = JSON.parse(init.body);
        return response(true);
      }
    }
    throw new Error("Unexpected network request.");
  };
  const req = {
    method: "POST",
    query: { provider: "daraja" },
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        Body: { stkCallback: { CheckoutRequestID: "ws_STK_001", ResultCode: 1032, Amount: 1 } }
      }));
    }
  };
  const res = {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; }
  };
  await webhooks(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).processed, true);
  assert.equal(recorded.p_provider, "daraja");
  assert.equal(recorded.p_amount_minor, 12500);
  assert.equal(recorded.p_currency, "KES");
  assert.equal(recorded.p_provider_reference, "ws_STK_001");
  assert.equal(recorded.p_provider_payment_reference, "ws_STK_001");
});

test("Daraja migration preserves the nine-argument idempotent settlement RPC", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202610300005_daraja_sandbox_stk_push.sql", import.meta.url), "utf8");
  assert.match(sql, /provider in \('stripe', 'paystack', 'daraja'\)/);
  assert.match(sql, /p_market_codes is distinct from array\['KE'\]::text\[\]/);
  assert.match(sql, /create or replace function public\.record_verified_payment\([\s\S]*?p_provider_payment_reference text[\s\S]*?p_provider not in \('stripe', 'paystack', 'daraja'\)/);
  assert.match(sql, /grant execute on function public\.record_verified_payment\(text, text, uuid, bigint, text, text, bigint, timestamptz, text\) to service_role/);
});

test("Daraja callback whose metadata amount disagrees with the stored amount confirms nothing", async () => {
  useSandbox();
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(process.env.SUPABASE_URL) && new URL(url).pathname === "/rest/v1/contributions") {
      return response([{ id: "f8e5022e-fad8-4dc7-b222-c55e4f6ce190", pledged_amount_minor: 12500, currency: "KES", payment_status: "pending" }]);
    }
    throw new Error("Unexpected network request.");
  };
  const req = {
    method: "POST", query: { provider: "daraja" }, headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ Body: { stkCallback: {
        CheckoutRequestID: "ws_STK_001", ResultCode: 0,
        CallbackMetadata: { Item: [{ Name: "Amount", Value: 1 }, { Name: "MpesaReceiptNumber", Value: "X" }] }
      } } }));
    }
  };
  const res = { headers: {}, status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.body = body; } };
  await webhooks(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).processed, false);
  assert.ok(!calls.some(url => url.includes("stkpushquery") || url.includes("record_verified_payment")));
});

test("KES payment options are system-derived without per-wedding setup or the live flag", async () => {
  useSandbox();
  const saved = { live: process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED, ts: process.env.TURNSTILE_SECRET_KEY, tk: process.env.TURNSTILE_SITE_KEY };
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED = "false";
  process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
  process.env.TURNSTILE_SITE_KEY = "turnstile-test-site";
  const paths = [];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("/oauth/")) return response({ access_token: "sandbox-token", expires_in: "3599" });
    if (url.startsWith(process.env.SUPABASE_URL)) {
      paths.push(new URL(url).pathname);
      return response([{ id: "7c1b33e8-6b41-4f66-9169-54197263db7f", currency: "KES" }]);
    }
    throw new Error("Unexpected network request.");
  };
  try {
    const res = { headers: {}, statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.body = body; } };
    await checkoutHandler({ method: "GET", query: { action: "options", weddingId: "7c1b33e8-6b41-4f66-9169-54197263db7f", currency: "KES" } }, res);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.paymentAvailable, true);
    assert.deepEqual(body.providers.map(item => [item.id, item.market]), [["daraja", "KE"]]);
    assert.deepEqual(paths, ["/rest/v1/weddings", "/rest/v1/platform_policies"]);
  } finally {
    for (const [key, name] of [["live", "WEDDINGSITE_LIVE_PAYMENTS_ENABLED"], ["ts", "TURNSTILE_SECRET_KEY"], ["tk", "TURNSTILE_SITE_KEY"]]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
});
