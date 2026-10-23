import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

// POST /api/wedding/:weddingId/publish
// Publish a wedding: atomically charge publication fee, record it, and make site public
// Request: { confirmed: true }
// Response: { published: true, feeAmount, feeCurrency }
export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  const session = await requireAuth(req, res);
  if (!session) return;

  const weddingId = req.url.split("/").reverse()[1];
  const body = req.body && typeof req.body === "object" ? req.body : {};

  if (!body.confirmed) {
    return sendJson(res, 400, { error: "Publication requires explicit confirmation." });
  }

  try {
    // Call publish RPC
    const result = await supabaseRequest(`/rest/v1/rpc/publish_wedding_with_fee`, {
      method: "POST",
      token: session.token,
      body: { p_wedding_id: weddingId, p_confirmed: true }
    });

    // Fetch the recorded publication fee
    const fees = await supabaseRequest(
      `/rest/v1/publication_fees?wedding_id=eq.${encodeURIComponent(weddingId)}&select=amount_minor,currency`,
      { token: session.token }
    );
    const fee = fees?.[0];

    return sendJson(res, 200, {
      published: true,
      feeAmount: fee?.amount_minor || 0,
      feeCurrency: fee?.currency || "USD",
      message: "Wedding published. Guests can now RSVP and contribute."
    });
  } catch (error) {
    console.error("publish wedding failed", error.message);
    return sendJson(res, error.status || 400, { error: "Could not publish wedding. Check capacity and content." });
  }
}
