import { createHash } from "node:crypto";
import { sendJson, supabaseRequest } from "../server/supabase.js";
import {
  normalizeStripeAdjustment, normalizeStripePayment, verifyStripeSignature,
  normalizePaystackAdjustment, normalizePaystackPayment, verifyPaystackSignature,
  verifyProviderPayment
} from "../server/payment-adapters.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      const error = new Error("Provider payload is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function recordAdjustment(adjustment) {
  return supabaseRequest("/rest/v1/rpc/record_provider_adjustment", {
    service: true,
    method: "POST",
    body: {
      p_provider: adjustment.provider,
      p_provider_event_id: adjustment.eventId,
      p_event_type: adjustment.eventType,
      p_adjustment_id: adjustment.adjustmentId,
      p_payment_reference: adjustment.paymentReference,
      p_amount_minor: adjustment.amountMinor,
      p_currency: adjustment.currency,
      p_state: adjustment.state,
      p_occurred_at: adjustment.occurredAt
    }
  });
}

async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (process.env.WEDDINGSITE_PAYMENT_MODE !== "test" ||
      !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") || !secret) {
    return sendJson(res, 503, { error: "Test payment webhooks are unavailable until a test-mode provider and webhook secret are configured." });
  }
  try {
    const raw = await rawBody(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], secret)) return sendJson(res, 400, { error: "Invalid or expired provider signature." });
    const event = JSON.parse(raw.toString("utf8"));
    const adjustment = normalizeStripeAdjustment(event);
    if (adjustment) {
      const result = await recordAdjustment(adjustment);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
    const payment = normalizeStripePayment(event);
    if (!payment) return sendJson(res, 200, { received: true, processed: false });
    const result = await supabaseRequest("/rest/v1/rpc/record_verified_payment", {
      service: true,
      method: "POST",
      body: {
        p_provider: payment.provider,
        p_provider_event_id: payment.eventId,
        p_contribution_id: payment.contributionId,
        p_amount_minor: payment.amountMinor,
        p_currency: payment.currency,
        p_provider_reference: payment.reference,
        p_provider_fee_minor: payment.providerFeeMinor,
        p_provider_paid_at: payment.providerPaidAt,
        p_provider_payment_reference: payment.providerPaymentReference
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(result) });
  } catch (error) {
    console.error("Stripe webhook processing failed", error.message);
    return sendJson(res, error.status || 500, { error: "Verified provider event could not be recorded; provider retry is required." });
  }
}

async function handlePaystackWebhook(req, res) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (process.env.WEDDINGSITE_PAYMENT_MODE !== "test" || !secret?.startsWith("sk_test_")) {
    return sendJson(res, 503, { error: "Test payment webhooks are unavailable until Paystack test mode is configured." });
  }
  try {
    const raw = await rawBody(req);
    if (!verifyPaystackSignature(raw, req.headers["x-paystack-signature"], secret)) {
      return sendJson(res, 400, { error: "Invalid Paystack signature." });
    }
    const event = JSON.parse(raw.toString("utf8"));
    const digest = createHash("sha256").update(raw).digest("hex");
    const adjustment = normalizePaystackAdjustment(event, digest);
    if (adjustment) {
      const result = await recordAdjustment(adjustment);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
    const payment = normalizePaystackPayment(event);
    if (!payment) return sendJson(res, 200, { received: true, processed: false });
    const result = await supabaseRequest("/rest/v1/rpc/record_verified_payment", {
      service: true,
      method: "POST",
      body: {
        p_provider: payment.provider,
        p_provider_event_id: payment.eventId,
        p_contribution_id: payment.contributionId,
        p_amount_minor: payment.amountMinor,
        p_currency: payment.currency,
        p_provider_reference: payment.reference,
        p_provider_fee_minor: payment.providerFeeMinor,
        p_provider_paid_at: payment.providerPaidAt,
        p_provider_payment_reference: payment.providerPaymentReference
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(result) });
  } catch (error) {
    console.error("Paystack webhook processing failed", error.message);
    return sendJson(res, error.status || 500, { error: "Verified provider event could not be recorded; provider retry is required." });
  }
}

async function handleDarajaCallback(req, res) {
  if (process.env.WEDDINGSITE_PAYMENT_MODE !== "test" ||
      process.env.DARAJA_ENVIRONMENT !== "sandbox") {
    return sendJson(res, 503, { error: "Daraja callbacks are available only in the configured sandbox." });
  }
  let contributionId = "";
  try {
    const raw = await rawBody(req, 64_000);
    const body = JSON.parse(raw.toString("utf8"));
    const checkoutRequestId = String(body?.Body?.stkCallback?.CheckoutRequestID || "");
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(checkoutRequestId)) {
      return sendJson(res, 400, { error: "Invalid Daraja callback reference." });
    }
    const contributions = await supabaseRequest(
      `/rest/v1/contributions?provider_name=eq.daraja&provider_reference=eq.${encodeURIComponent(checkoutRequestId)}&select=id,pledged_amount_minor,currency,payment_status&limit=1`,
      { service: true }
    );
    const contribution = contributions?.[0];
    if (!contribution || contribution.payment_status !== "pending") {
      return sendJson(res, 200, { received: true, processed: false });
    }
    contributionId = contribution.id;

    // Daraja callbacks are not treated as signed payment evidence. Confirm the
    // exact stored CheckoutRequestID through the authenticated STK Query API.
    const payment = await verifyProviderPayment(
      "daraja", checkoutRequestId, contribution.id,
      contribution.pledged_amount_minor, contribution.currency
    );
    if (payment.terminal) {
      await supabaseRequest(
        `/rest/v1/contributions?id=eq.${encodeURIComponent(contribution.id)}&payment_status=eq.pending`,
        { service: true, method: "PATCH", body: { payment_status: "cancelled" }, prefer: "return=minimal" }
      );
      return sendJson(res, 200, { received: true, processed: false });
    }
    if (!payment.verified) return sendJson(res, 200, { received: true, processed: false });
    const recorded = await supabaseRequest("/rest/v1/rpc/record_verified_payment", {
      service: true,
      method: "POST",
      body: {
        p_provider: payment.provider,
        p_provider_event_id: payment.eventId,
        p_contribution_id: contribution.id,
        p_amount_minor: payment.amountMinor,
        p_currency: payment.currency,
        p_provider_reference: payment.reference,
        p_provider_fee_minor: payment.providerFeeMinor,
        p_provider_paid_at: payment.providerPaidAt,
        p_provider_payment_reference: payment.providerPaymentReference
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(recorded) });
  } catch (error) {
    console.error("Daraja callback reconciliation failed", contributionId || "unmatched");
    return sendJson(res, error.status || 503, { error: "Daraja payment could not be verified; no paid action was confirmed." });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  const provider = String(req.query.provider || "stripe").toLowerCase();
  if (provider === "stripe") return handleStripeWebhook(req, res);
  if (provider === "paystack") return handlePaystackWebhook(req, res);
  if (provider === "daraja") return handleDarajaCallback(req, res);
  return sendJson(res, 400, { error: "Unknown payment provider." });
}
