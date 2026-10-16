import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

const safeInteger = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
};

export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const weddingId = String(req.query.weddingId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(weddingId)) {
    return sendJson(res, 400, { error: "A valid weddingId is required." });
  }
  const limit = Math.max(1, safeInteger(req.query.limit, 10, 50));
  const page = safeInteger(req.query.page, 0, 10000);
  const from = page * limit;
  const to = from + limit - 1;
  try {
    const rows = await supabaseRequest(
      `/rest/v1/public_contribution_ledger?wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,stream_name,display_name,visibility,pledged_amount_minor,paid_amount_minor,currency,payment_status,created_at&order=created_at.desc&limit=${limit}&offset=${from}`,
      { }
    );
    return sendJson(res, 200, { page, pageSize: limit, entries: rows || [], hasMore: (rows || []).length === limit });
  } catch (error) {
    console.error("public ledger read failed", error.message);
    return sendJson(res, error.status || 503, { error: "The public contribution ledger is unavailable." });
  }
}
