import { sendJson, supabaseRequest } from "../../server/supabase.js";
import { normalizePaystackPayment, verifyPaystackSignature } from "../../server/payment-adapters.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return sendJson(res, 503, { error: "Paystack webhooks are disabled until separately approved and configured." });
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
        p_provider_reference: payment.reference
      }
    });
    return sendJson(res, 200, { received: true, processed: Boolean(result) });
  } catch (error) {
    console.error("Paystack webhook processing failed", error.message);
    return sendJson(res, error.status || 500, { error: "Verified provider event could not be recorded; provider retry is required." });
  }
}
