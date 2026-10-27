import { sendJson, supabaseRequest } from "../server/supabase.js";
import { normalizeStripePayment, verifyStripeSignature, normalizePaystackPayment, verifyPaystackSignature } from "../server/payment-adapters.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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
    const payment = normalizeStripePayment(JSON.parse(raw.toString("utf8")));
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
        p_provider_paid_at: payment.providerPaidAt
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
    const payment = normalizePaystackPayment(JSON.parse(raw.toString("utf8")));
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
        p_provider_paid_at: payment.providerPaidAt
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(result) });
  } catch (error) {
    console.error("Paystack webhook processing failed", error.message);
    return sendJson(res, error.status || 500, { error: "Verified provider event could not be recorded; provider retry is required." });
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
  return sendJson(res, 400, { error: "Unknown payment provider." });
}
