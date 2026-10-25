import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { csvCell } from "../server/supabase.js";
import {
  checkProviderHealth, isSecurePublicOrigin, normalizePaystackPayment, normalizeStripePayment,
  verifyPaystackSignature, verifyStripeSignature
} from "../server/payment-adapters.js";
import checkoutHandler from "../api/checkout.js";

const ownerMigration = readFileSync(new URL("../supabase/migrations/202610160002_protected_owner_identity.sql", import.meta.url), "utf8");
const platformMarkup = readFileSync(new URL("../demo.html", import.meta.url), "utf8");
const platformScript = readFileSync(new URL("../platform.js", import.meta.url), "utf8");

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; }
  };
}

test("CSV export escapes quotes and wraps values", () => {
  assert.equal(csvCell('A "quoted", name'), '"A ""quoted"", name"');
});

test("CSV export neutralizes spreadsheet formula injection", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://example.invalid\")"), `"'=HYPERLINK(""https://example.invalid"")"`);
  assert.equal(csvCell("-100"), `"'-100"`);
});

test("payment origins require HTTPS except for localhost testing", () => {
  assert.equal(isSecurePublicOrigin("https://weddingsite.example"), true);
  assert.equal(isSecurePublicOrigin("http://localhost:4173"), true);
  assert.equal(isSecurePublicOrigin("http://weddingsite.example"), false);
  assert.equal(isSecurePublicOrigin("https://weddingsite.example/path"), false);
});

test("protected Owner bootstrap binds only Colin's confirmed auth identity", () => {
  assert.match(ownerMigration, /lower\(u\.email\) = 'colyske@gmail\.com'/);
  assert.match(ownerMigration, /u\.email_confirmed_at is not null/);
  assert.match(ownerMigration, /old\.owner_user_id is not null\s+and new\.owner_user_id is distinct from old\.owner_user_id/);
  assert.match(ownerMigration, /before insert or update or delete on public\.profiles/);
  assert.match(ownerMigration, /revoke all on function public\.bootstrap_protected_owner\(uuid\) from public, anon, authenticated/);
  assert.match(ownerMigration, /grant execute on function public\.bootstrap_protected_owner\(uuid\) to service_role/);
  assert.match(ownerMigration, /source <> 'protected_owner_bootstrap'/);
});

test("non-owner role preview does not render Owner identity or controls", () => {
  assert.doesNotMatch(platformMarkup, /value="Owner"|OWNER · PROTECTED|Miriam Njeri/i);
  assert.doesNotMatch(platformScript, /"Owner"|OWNER · PROTECTED|Miriam Njeri/i);
  assert.match(platformMarkup, /option value="Client"/);
  assert.match(platformMarkup, /option value="Admin"/);
  assert.match(platformMarkup, /option value="SuperAdmin"/);
});

test("provider health checks fail closed without a configured key", async () => {
  const oldMode = process.env.WEDDINGSITE_PAYMENT_MODE;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  try {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.WEDDINGSITE_PAYMENT_MODE = "test";
    assert.equal(await checkProviderHealth("stripe"), false);
  } finally {
    if (oldMode === undefined) delete process.env.WEDDINGSITE_PAYMENT_MODE;
    else process.env.WEDDINGSITE_PAYMENT_MODE = oldMode;
    if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = oldKey;
  }
});

test("payment availability endpoint advertises no providers while payments are disabled", async () => {
  const previous = process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED;
  try {
    process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED = "false";
    const res = responseRecorder();
    await checkoutHandler({
      method: "GET",
      query: { action: "options", weddingId: "7c1b33e8-6b41-4f66-9169-54197263db7f", market: "US", currency: "USD" }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      providers: [], paymentAvailable: false, message: "Payments are not available yet. No payment gateway is enabled."
    });
  } finally {
    if (previous === undefined) delete process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED;
    else process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED = previous;
  }
});

test("checkout endpoint stays disabled until explicitly enabled", async () => {
  const previous = process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED;
  try {
    process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED = "false";
    const res = responseRecorder();
    await checkoutHandler({ method: "POST", query: { action: "create" }, body: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, "Live payments are disabled. The guest demo remains pledge-only.");
  } finally {
    if (previous === undefined) delete process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED;
    else process.env.WEDDINGSITE_LIVE_PAYMENTS_ENABLED = previous;
  }
});

test("Stripe webhook signature validation accepts a current exact-body signature", () => {
  const body = Buffer.from('{"type":"checkout.session.completed"}');
  const now = 1_800_000_000;
  const digest = createHmac("sha256", "test-secret").update(`${now}.${body.toString("utf8")}`).digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${digest}`, "test-secret", now), true);
});

test("Stripe webhook signature validation rejects tampering and stale timestamps", () => {
  const body = Buffer.from('{"type":"checkout.session.completed"}');
  const now = 1_800_000_000;
  const digest = createHmac("sha256", "test-secret").update(`${now}.${body.toString("utf8")}`).digest("hex");
  assert.equal(verifyStripeSignature(Buffer.from('{"type":"changed"}'), `t=${now},v1=${digest}`, "test-secret", now), false);
  assert.equal(verifyStripeSignature(body, `t=${now - 301},v1=${digest}`, "test-secret", now), false);
});

test("Paystack webhook signature is checked using SHA-512 over the raw body", () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const signature = createHmac("sha512", "test-secret").update(body).digest("hex");
  assert.equal(verifyPaystackSignature(body, signature, "test-secret"), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{"event":"charge.failed"}'), signature, "test-secret"), false);
});

test("Payment adapters normalize only paid, well-formed events", () => {
  const stripe = normalizeStripePayment({
    id: "evt_123",
    type: "checkout.session.completed",
    data: { object: { id: "cs_123", mode: "payment", payment_status: "paid", amount_total: 2500, currency: "usd", client_reference_id: "contribution-id" } }
  });
  assert.equal(stripe.provider, "stripe");
  assert.equal(stripe.amountMinor, 2500);
  assert.equal(normalizeStripePayment({ id: "evt_124", type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "unpaid" } } }), null);
  const paystack = normalizePaystackPayment({
    event: "charge.success",
    data: { id: 123, reference: "ref-123", status: "success", amount: 2500, currency: "USD", metadata: { contribution_id: "contribution-id" } }
  });
  assert.equal(paystack.provider, "paystack");
  assert.equal(paystack.eventId, "123");
  assert.equal(normalizePaystackPayment({ event: "charge.failed", data: {} }), null);
});
