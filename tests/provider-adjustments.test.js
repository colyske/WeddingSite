import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePaystackAdjustment, normalizeStripeAdjustment } from "../server/payment-adapters.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(join(root, file), "utf8");

test("Stripe refund and dispute events normalize provider IDs, amounts and event timestamps", () => {
  const refund = normalizeStripeAdjustment({
    id: "evt_refund_1",
    created: 1793149600,
    type: "refund.updated",
    data: { object: {
      id: "re_123", charge: "ch_123", payment_intent: "pi_123",
      amount: 1250, currency: "kes", status: "succeeded"
    } }
  });
  assert.deepEqual(refund, {
    provider: "stripe", eventId: "evt_refund_1", eventType: "refund.updated",
    adjustmentId: "re_123", paymentReference: "pi_123", amountMinor: 1250,
    currency: "KES", state: "refund_processed", occurredAt: "2026-10-28T01:06:40.000Z"
  });
  const dispute = normalizeStripeAdjustment({
    id: "evt_dispute_1", created: 1793149600, type: "charge.dispute.funds_withdrawn",
    data: { object: {
      id: "dp_123", charge: "ch_123", payment_intent: "pi_123",
      amount: 2500, currency: "kes", status: "lost"
    } }
  });
  assert.equal(dispute.state, "dispute_withdrawn");
  assert.equal(dispute.adjustmentId, "dp_123");
  const chargeRefund = normalizeStripeAdjustment({
    id: "evt_charge_refund_1",
    created: 1793149600,
    type: "charge.refunded",
    data: { object: {
      id: "ch_123", payment_intent: "pi_123", currency: "kes",
      refunds: { data: [{ id: "re_456", amount: 1250, currency: "kes", status: "succeeded", charge: "ch_123" }] }
    } }
  });
  assert.equal(chargeRefund.adjustmentId, "re_456");
  assert.equal(chargeRefund.paymentReference, "pi_123");
  assert.equal(chargeRefund.state, "refund_processed");
});

test("Paystack refunds without a stable adjustment reference are held for review", () => {
  const digest = "a".repeat(64);
  const result = normalizePaystackAdjustment({
    event: "refund.processed",
    data: { transaction_reference: "txn-1", amount: "500", currency: "KES", createdAt: "2026-10-28T01:06:40.000Z" }
  }, digest);
  assert.equal(result.adjustmentId, digest);
  assert.equal(result.paymentReference, "txn-1");
  assert.equal(result.state, "review");
});

test("Paystack stable refund reference is normalized and incomplete dispute results stay reviewed", () => {
  const refund = normalizePaystackAdjustment({
    event: "refund.processed",
    data: {
      refund_reference: "refund-1", transaction_reference: "txn-1",
      amount: "500", currency: "KES", createdAt: "2026-10-28T01:06:40.000Z"
    }
  }, "digest-1");
  assert.equal(refund.adjustmentId, "refund-1");
  assert.equal(refund.state, "refund_processed");
  const dispute = normalizePaystackAdjustment({
    event: "charge.dispute.resolve",
    data: {
      dispute_reference: "dispute-1", transaction_reference: "txn-1",
      amount: 500, currency: "KES", status: "pending",
      createdAt: "2026-10-28T01:06:40.000Z"
    }
  }, "digest-2");
  assert.equal(dispute.state, "review");
});

test("provider adjustment migration is idempotent, role-safe and holds unresolved amounts", async () => {
  const sql = await read("supabase/migrations/202610300004_provider_adjustments.sql");
  assert.match(sql, /unique \(provider, provider_event_id\)/i);
  assert.match(sql, /unique \(provider, adjustment_kind, provider_adjustment_id\)/i);
  assert.match(sql, /financial_adjustment_ledger_immutable/i);
  assert.match(sql, /refund_couple_delta_minor\(5000, 10000, 500, 200, 'platform'\) <> -4650/i);
  assert.match(sql, /refund_couple_delta_minor\(10000, 10000, 500, 200, 'platform'\) <> -9300/i);
  assert.match(sql, /refund_couple_delta_minor\(5000, 10000, 500, 200, 'couple'\) <> -5000/i);
  assert.match(sql, /revoke all on function public\.record_provider_adjustment[\s\S]+grant execute[\s\S]+to service_role/i);
  assert.match(sql, /refund_fee_allocation text not null default 'manual_review'/i);
  assert.match(sql, /p_event_type = 'charge\.refunded'/i);
  assert.match(sql, /provider_fee_unknown/i);
  assert.match(sql, /available_minor := greatest\(reserved_minor \+ coalesce\(adjustment_delta, 0\)[\s\S]+coalesce\(held_minor, 0\)/i);
  assert.match(sql, /admin_resolve_provider_refund/i);
  assert.match(sql, /admin_match_unresolved_refund/i);
  assert.match(sql, /current_platform_role\(\) is distinct from 'owner'/i);
  assert.match(sql, /admin_provider_adjustment_queue/i);
  assert.match(sql, /older_than_latest_provider_event/i);
  assert.match(sql, /select currency into workspace_currency from public\.weddings where id = p_wedding_id for update/i);
  assert.match(sql, /admin_resolve_provider_refund[\s\S]+perform public\.require_staff\(\)/i);
  assert.match(sql, /select \* into c from public\.contributions where id = a\.contribution_id for update;[\s\S]+perform 1 from public\.weddings where id = c\.wedding_id for update;[\s\S]+select \* into a from public\.payment_adjustments where id = p_adjustment_id for update;/i);
  assert.match(sql, /entry_type in \('refund', 'refund_reviewed'\)/i);
  assert.match(sql, /create policy payment_adjustment_workspace_read/i);
});

test("webhook signatures precede adjustment processing and Admin/Owner surfaces are wired", async () => {
  const webhook = await read("api/webhooks.js");
  assert.ok(webhook.indexOf("verifyStripeSignature(raw") < webhook.indexOf("normalizeStripeAdjustment(event)"));
  assert.ok(webhook.indexOf("verifyPaystackSignature(raw") < webhook.indexOf("normalizePaystackAdjustment(event"));
  assert.match(webhook, /record_provider_adjustment/);
  assert.match(webhook, /createHash\("sha256"\)/);
  const api = await read("api/admin.js");
  assert.match(api, /admin_provider_adjustment_queue/);
  assert.match(api, /admin_resolve_provider_refund/);
  assert.match(api, /admin_match_unresolved_refund/);
  assert.match(api, /admin_set_refund_policy/);
  const ui = await read("backoffice.js");
  assert.match(ui, /Refund fee allocation/);
  assert.match(ui, /refunds and disputes/i);
  assert.match(ui, /does not initiate a refund/);
  assert.match(ui, /Match & hold/);
  assert.match(ui, /financial\.count/);
});
