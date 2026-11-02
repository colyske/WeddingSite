import { methodOnly, sendJson, supabaseRequest } from "./supabase.js";
import { requireAuth } from "./auth-middleware.js";
import { referralError } from "./referral-errors.js";

const CODE = /^[a-f0-9]{32}$/;
const rpc = (name, token, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, { token, method: "POST", body });

export default async function handler(req, res) {
  const action = String(req.query?.action || "summary");
  try {
    if (action === "validate") {
      if (!methodOnly(req, res, "GET")) return;
      const code = String(req.query?.code || "");
      if (!CODE.test(code)) return sendJson(res, 400, { error: "Invalid referral code." });
      return sendJson(res, 200, await rpc("referral_validate_code", undefined, { p_code: code }));
    }
    const session = await requireAuth(req, res);
    if (!session) return;
    if (action === "summary" || action === "disclosure") {
      if (!methodOnly(req, res, "GET")) return;
      return sendJson(res, 200, await rpc(action === "summary" ? "referral_my_summary" : "referral_disclosure", session.token));
    }
    if (!["consent", "capture"].includes(action)) return sendJson(res, 404, { error: "Unknown referral action." });
    if (!methodOnly(req, res, "POST")) return;
    let body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { return sendJson(res, 400, { error: "Invalid JSON request." }); }
    if (!body || Array.isArray(body) || typeof body !== "object") return sendJson(res, 400, { error: "Invalid referral request." });
    if (action === "capture") {
      if (!CODE.test(body.code || "")) return sendJson(res, 400, { error: "Invalid referral code." });
      const intentId = await rpc("referral_capture", session.token, { p_code: body.code });
      return sendJson(res, 200, { intent_id: intentId });
    }
    if (typeof body.optedIn !== "boolean" || body.termsVersion !== "client-referrals-v1") {
      return sendJson(res, 400, { error: "Review the current referral terms." });
    }
    return sendJson(res, 200, await rpc("referral_set_consent", session.token, {
      p_opted_in: body.optedIn, p_terms_version: body.termsVersion
    }));
  } catch (error) {
    const [status, message] = referralError(error);
    console.error("Referral request failed:", action, status);
    return sendJson(res, status, { error: message });
  }
}
