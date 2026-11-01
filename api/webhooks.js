import { createHash } from "node:crypto";
import { sendJson, supabaseRequest } from "../server/supabase.js";
import {
  darajaConfiguredEnvironment, normalizeStripeAdjustment, normalizeStripePayment, verifyStripeSignature,
  normalizePaystackAdjustment, normalizePaystackPayment, verifyPaystackSignature,
  verifyProviderPayment
} from "../server/payment-adapters.js";
import { recordPublicationPayment, reconcilePublicationCallback } from "../server/publication-payments.js";
import { recoverVerifiedDaraja } from "../server/daraja-recovery.js";
import { paystackEnvironment, recordPaystackPayment, fetchPaystack, verifyPaystackContext, parsePaystackJson } from "../server/paystack.js";

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
    if (event.data.object.metadata?.payment_kind === "publication") {
      const result = await recordPublicationPayment(payment, payment.contributionId);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
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
  if (!paystackEnvironment() || (paystackEnvironment() === "live" && process.env.PAYSTACK_RECONCILIATION_ENABLED !== "true")) {
    return sendJson(res, 503, { error: "Paystack webhook reconciliation is not configured for this mode." });
  }
  try {
    const raw = await rawBody(req);
    if (!verifyPaystackSignature(raw, req.headers["x-paystack-signature"], secret)) {
      return sendJson(res, 400, { error: "Invalid Paystack signature." });
    }
    const event = parsePaystackJson(raw.toString("utf8"));
    const digest = createHash("sha256").update(raw).digest("hex");
    const adjustment = normalizePaystackAdjustment(event, digest);
    if (adjustment) {
      if (paystackEnvironment() === "live") {
        if (!adjustment.paymentReference) throw new Error("Paystack adjustment lacks a transaction reference.");
        const original = (await fetchPaystack(`/transaction/verify/${encodeURIComponent(adjustment.paymentReference)}`)).data;
        const contribution = (await supabaseRequest(
          `/rest/v1/contributions?provider_name=eq.paystack&provider_reference=eq.${encodeURIComponent(adjustment.paymentReference)}&select=id,paystack_context`, { service: true }
        ))?.[0];
        const publication = contribution ? null : (await supabaseRequest(
          `/rest/v1/publication_checkouts?provider=eq.paystack&provider_reference=eq.${encodeURIComponent(adjustment.paymentReference)}&select=*`, { service: true }
        ))?.[0];
        const context = contribution?.paystack_context || publication?.paystack_context;
        if (!context || original?.reference !== adjustment.paymentReference) throw new Error("Paystack adjustment has no matching live admission.");
        verifyPaystackContext(original, context);
        if (publication) {
          await supabaseRequest("/rest/v1/rpc/record_paystack_publication_adjustment", {
            service: true, method: "POST", body: {
              p_checkout_id: publication.id, p_event_id: digest, p_state: adjustment.state,
              p_adjustment_id: adjustment.adjustmentId, p_amount_minor: adjustment.amountMinor,
              p_currency: adjustment.currency, p_occurred_at: adjustment.occurredAt
            }
          });
          return sendJson(res, 200, { received: true, processed: true });
        }
      }
      const result = await recordAdjustment(adjustment);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
    const payment = normalizePaystackPayment(event);
    if (!payment) return sendJson(res, 200, { received: true, processed: false });
    if (event.data.metadata?.payment_kind === "publication") {
      const row = (await supabaseRequest(`/rest/v1/publication_checkouts?id=eq.${encodeURIComponent(payment.contributionId)}&select=*`, { service: true }))?.[0];
      if (!row) throw new Error("Paystack publication checkout was not found.");
      const verified = await verifyProviderPayment("paystack", row.provider_reference, row.id, row.amount_minor, row.currency,
        row.paystack_context ? { context: row.paystack_context } : null);
      if (!verified.verified) throw new Error("Paystack publication payment is not independently verified.");
      const result = await recordPublicationPayment(verified, row.id);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
    const row = (await supabaseRequest(
      `/rest/v1/contributions?id=eq.${encodeURIComponent(payment.contributionId)}&select=id,provider_reference,pledged_amount_minor,currency,paystack_context`, { service: true }
    ))?.[0];
    if (!row) throw new Error("Paystack contribution was not found.");
    if (payment.reference !== row.provider_reference || payment.amountMinor !== Number(row.pledged_amount_minor) ||
        payment.currency !== row.currency) throw new Error("Signed Paystack event differs from admission.");
    if (row.paystack_context) verifyPaystackContext(event.data, row.paystack_context);
    const verified = await verifyProviderPayment("paystack", row.provider_reference, row.id, row.pledged_amount_minor, row.currency,
      row.paystack_context ? { context: row.paystack_context, signedSplit: event.data.split } : null);
    if (!verified.verified) throw new Error("Paystack contribution is not independently verified.");
    if (row.paystack_context) {
      const result = await recordPaystackPayment(verified, row.id);
      return sendJson(res, 200, { received: true, processed: Boolean(result) });
    }
    const result = await supabaseRequest("/rest/v1/rpc/record_verified_payment", {
      service: true,
      method: "POST",
      body: {
        p_provider: verified.provider,
        p_provider_event_id: verified.eventId,
        p_contribution_id: row.id,
        p_amount_minor: verified.amountMinor,
        p_currency: verified.currency,
        p_provider_reference: verified.reference,
        p_provider_fee_minor: verified.providerFeeMinor,
        p_provider_paid_at: verified.providerPaidAt,
        p_provider_payment_reference: verified.providerPaymentReference
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(result) });
  } catch (error) {
    console.error("Paystack webhook processing failed", error.message);
    return sendJson(res, error.status || 500, { error: "Verified provider event could not be recorded; provider retry is required." });
  }
}

async function handleDarajaCallback(req, res) {
  const environment = darajaConfiguredEnvironment();
  if (!environment) {
    return sendJson(res, 503, { error: "Daraja callbacks are not enabled." });
  }
  let contributionId = "";
  try {
    const raw = await rawBody(req, 64_000);
    const body = JSON.parse(raw.toString("utf8"));
    if (req.query.kind === "publication") {
      // Publication checkout is sandbox-only; never reconcile it with production credentials.
      if (environment !== "sandbox") return sendJson(res, 200, { received: true, processed: false });
      const processed = await reconcilePublicationCallback(body);
      return sendJson(res, 200, { received: true, processed });
    }
    const checkoutRequestId = String(body?.Body?.stkCallback?.CheckoutRequestID || "");
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(checkoutRequestId)) {
      return sendJson(res, 400, { error: "Invalid Daraja callback reference." });
    }
    const contributions = await supabaseRequest(
      `/rest/v1/contributions?provider_name=eq.daraja&provider_reference=eq.${encodeURIComponent(checkoutRequestId)}&select=id,pledged_amount_minor,currency,payment_status,payment_environment,daraja_shortcode,daraja_merchant_request_id&limit=1`,
      { service: true }
    );
    const contribution = contributions?.[0];
    if (!contribution) return sendJson(res, 200, { received: true, processed: false });
    const recoverable = contribution.payment_status === "cancelled";
    if (contribution.payment_status !== "pending" && !recoverable) {
      return sendJson(res, 200, { received: true, processed: false });
    }
    contributionId = contribution.id;
    const live = contribution.payment_environment === "live";
    if (environment !== (live ? "production" : "sandbox")) {
      return sendJson(res, 200, { received: true, processed: false });
    }
    const callbackMerchantId = body?.Body?.stkCallback?.MerchantRequestID;
    if (live && (!contribution.daraja_merchant_request_id ||
        (callbackMerchantId !== undefined && String(callbackMerchantId) !== contribution.daraja_merchant_request_id))) {
      console.error("Daraja callback merchant request mismatch", contribution.id);
      return sendJson(res, 200, { received: true, processed: false });
    }

    // The callback payload is unsigned. If it carries an Amount that disagrees with the
    // server-created immutable amount, treat it as suspicious and confirm nothing.
    const metaItems = body?.Body?.stkCallback?.CallbackMetadata?.Item;
    const callbackAmount = Array.isArray(metaItems) ? metaItems.find(item => item?.Name === "Amount")?.Value : undefined;
    if (callbackAmount !== undefined && Math.round(Number(callbackAmount) * 100) !== Number(contribution.pledged_amount_minor)) {
      console.error("Daraja callback amount mismatch", contribution.id);
      return sendJson(res, 200, { received: true, processed: false });
    }

    // Daraja callbacks are not treated as signed payment evidence. Confirm the
    // exact stored CheckoutRequestID through the authenticated STK Query API.
    // STK Query returns only status fields (ResponseCode/ResultCode/ResultDesc and the
    // request IDs) — not the amount. The recorded amount is the server-created, immutable
    // contribution amount bound to that CheckoutRequestID at STK Push initiation.
    const payment = await verifyProviderPayment(
      "daraja", checkoutRequestId, contribution.id,
      contribution.pledged_amount_minor, contribution.currency,
      { environment: contribution.payment_environment, shortcode: contribution.daraja_shortcode,
        merchantRequestId: contribution.daraja_merchant_request_id }
    );
    if (payment.terminal) {
      console.info("Daraja STK Query terminal result", { resultCode: payment.resultCode || null });
      if (recoverable) return sendJson(res, 200, { received: true, processed: false });
      await supabaseRequest(
        `/rest/v1/contributions?id=eq.${encodeURIComponent(contribution.id)}&payment_status=eq.pending`,
        { service: true, method: "PATCH", body: { payment_status: "cancelled" }, prefer: "return=minimal" }
      );
      return sendJson(res, 200, { received: true, processed: false });
    }
    if (!payment.verified) return sendJson(res, 200, { received: true, processed: false });
    if (recoverable) {
      const recovered = await recoverVerifiedDaraja(payment, contribution.id);
      return sendJson(res, 200, { received: true, processed: Boolean(recovered) });
    }
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
