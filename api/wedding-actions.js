// POST /api/wedding-actions (publish, etc.), GET /api/wedding-actions?action=...
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  const weddingId = url.searchParams.get("weddingId");

  const session = await requireAuth(req, res);
  if (!session) return;

  if (!methodOnly(req, res, "POST")) return;
  if (!action || !weddingId || !/^[0-9a-f-]{36}$/.test(weddingId)) {
    return sendJson(res, 400, { error: "action and weddingId are required." });
  }

  if (action === "publish") {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!body.confirmed) {
      return sendJson(res, 400, { error: "Publication requires explicit confirmation." });
    }

    try {
      await supabaseRequest(`/rest/v1/rpc/publish_wedding_with_fee`, {
        method: "POST",
        token: session.token,
        body: { p_wedding_id: weddingId, p_confirmed: true }
      });

      const fees = await supabaseRequest(
        `/rest/v1/publication_fees?wedding_id=eq.${encodeURIComponent(weddingId)}&select=amount_minor,currency&limit=1`,
        { token: session.token }
      );
      const fee = fees?.[0];

      return sendJson(res, 200, {
        published: true,
        feeAmount: fee?.amount_minor || 0,
        feeCurrency: fee?.currency || "USD"
      });
    } catch (error) {
      console.error("publish failed", error.message);
      return sendJson(res, 400, { error: "Could not publish wedding." });
    }
  }

  return sendJson(res, 400, { error: `Unknown action: ${action}` });
}
