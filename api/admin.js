import { sendJson, supabaseRequest } from "../server/supabase.js";
import { requireRole } from "../server/auth-middleware.js";
import { contentError } from "../server/content-policy.js";
import { paymentProviderReadiness } from "./checkout.js";

const rpc = (name, token, body = {}) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { token, method: "POST", body });

const GET_ACTIONS = {
  overview: async (t) => {
    const [overview, settlement] = await Promise.all([
      rpc("admin_overview", t),
      rpc("admin_settlement_overview", t)
    ]);
    return { ...overview, settlement };
  },
  weddings: async (t) => ({ weddings: await rpc("admin_list_weddings", t) }),
  users: async (t, q) => ({ users: await rpc("admin_list_users", t, { p_search: q.search || null }) }),
  ledger: async (t) => ({ ledger: await rpc("admin_ledger", t, { p_limit: 500 }) }),
  payouts: async (t) => ({ payouts: await rpc("admin_payouts", t) }),
  audit: async (t) => ({ audit: await rpc("admin_audit", t, { p_limit: 500 }) }),
  operations: async (t) => {
    const [queue, adjustments] = await Promise.all([
      rpc("admin_operations_queue", t),
      rpc("admin_provider_adjustment_queue", t)
    ]);
    return { queue, adjustments };
  },
  policies: async (t) => ({ policies: await rpc("admin_get_policies", t) }),
  "refund-policy": async (t) => ({ allocation: await rpc("admin_get_refund_policy", t) }),
  "payment-controls": async t => ({ enabled: await rpc("admin_get_payment_controls", t), providers: paymentProviderReadiness() }),
  "policy-history": async (t) => ({ history: await rpc("admin_policy_history", t, { p_limit: 50 }) }),
  "wedding-metrics": async (t, q) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(q.weddingId || ""))) throw new Error("Invalid wedding.");
    return { metrics: await rpc("admin_wedding_metrics", t, { p_wedding_id: q.weddingId }) };
  }
};

const WEDDING_ACTIONS = new Set(["archive", "restore", "unpublish", "waive_fee"]);
const ROLES = new Set(["client", "admin", "superadmin"]);
const PAYOUT_STATUSES = new Set(["approved", "sent", "cancelled"]);
const LEADERSHIP_ACTIONS = new Set(["overview", "ledger", "payouts", "audit", "policies", "refund-policy", "payment-controls", "policy-history", "set-role", "payment-controls-save"]);
const OWNER_ACTIONS = new Set(["policies-save", "refund-policy-save"]);

function safeMessage(error) {
  const m = String(error?.message || "");
  if (/another staff|different/i.test(m)) return [409, "A different staff member must approve this payout."];
  if (/Access denied|permission|not allowed|only the owner|superadmin/i.test(m)) return [403, "Your role does not allow this action."];
  if (/cannot change your own/i.test(m)) return [400, "You cannot change your own role."];
  if (/invalid|must be|required|choose|cannot move/i.test(m)) return [400, "The request was not valid."];
  return [503, "The admin service could not complete the request."];
}

export default async function handler(req, res) {
  const session = await requireRole(req, res, ["owner", "superadmin", "admin"]);
  if (!session) return;
  const role = session.profile.platform_role;
  const action = String(req.query?.action || "role");
  const token = session.token;
  if ((LEADERSHIP_ACTIONS.has(action) && !["owner", "superadmin"].includes(role)) ||
      (OWNER_ACTIONS.has(action) && role !== "owner")) {
    return sendJson(res, 403, { error: "Your role does not allow this action." });
  }

  try {
    if (req.method === "GET") {
      if (action === "role") return sendJson(res, 200, { role });
      const fn = GET_ACTIONS[action];
      if (!fn) return sendJson(res, 404, { error: "Unknown action." });
      return sendJson(res, 200, await fn(token, req.query || {}));
    }

    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const invalidContent = contentError(body);
    if (invalidContent) return sendJson(res, 400, { error: invalidContent });

    if (action === "set-role") {
      if (!ROLES.has(body.role) || !body.user_id) return sendJson(res, 400, { error: "Choose a user and a valid role." });
      await rpc("admin_set_role", token, { p_user_id: body.user_id, p_role: body.role });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "payout-status") {
      if (!PAYOUT_STATUSES.has(body.status) || !body.payout_id) return sendJson(res, 400, { error: "Invalid payout status." });
      await rpc("admin_set_payout_status", token, { p_payout_id: body.payout_id, p_status: body.status, p_note: body.note || null });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "policies-save") {
      await rpc("admin_save_policies", token, { p_data: body.policies || {} });
      return sendJson(res, 200, { ok: true, policies: await rpc("admin_get_policies", token) });
    }
    if (action === "refund-policy-save") {
      if (!["manual_review", "couple", "platform"].includes(body.allocation) || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Choose a refund allocation and confirm the policy change." });
      }
      await rpc("admin_set_refund_policy", token, { p_allocation: body.allocation, p_confirmed: true });
      return sendJson(res, 200, { ok: true, allocation: await rpc("admin_get_refund_policy", token) });
    }
    if (action === "payment-controls-save") {
      if (body.confirmed !== true || !Array.isArray(body.enabled) ||
          body.enabled.some(id => !["stripe", "paystack", "daraja"].includes(id)) ||
          new Set(body.enabled).size !== body.enabled.length) {
        return sendJson(res, 400, { error: "Choose the allowed payment methods and confirm the change." });
      }
      await rpc("admin_set_payment_controls", token, { p_enabled: body.enabled, p_confirmed: true });
      return sendJson(res, 200, { ok: true, enabled: await rpc("admin_get_payment_controls", token) });
    }
    if (action === "refund-resolution") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.adjustment_id || "")) ||
          !["couple", "platform"].includes(body.allocation) || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Choose a refund allocation and confirm the resolution." });
      }
      await rpc("admin_resolve_provider_refund", token, {
        p_adjustment_id: body.adjustment_id, p_allocation: body.allocation, p_confirmed: true
      });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "refund-match") {
      if (!Number.isSafeInteger(body.event_id) || body.event_id < 1 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.contribution_id || "")) ||
          body.confirmed !== true) {
        return sendJson(res, 400, { error: "Select a valid contribution and explicitly confirm the match." });
      }
      await rpc("admin_match_unresolved_refund", token, {
        p_event_id: body.event_id, p_contribution_id: body.contribution_id, p_confirmed: true
      });
      return sendJson(res, 200, { ok: true });
    }
    if (action === "wedding-action") {
      if (!WEDDING_ACTIONS.has(body.action) || !body.wedding_id) return sendJson(res, 400, { error: "Invalid wedding action." });
      await rpc("admin_wedding_action", token, { p_wedding_id: body.wedding_id, p_action: body.action });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("admin endpoint failed", action, String(error?.message || "").slice(0, 300));
    if (action === "payout-status" && error.message?.includes("PAYOUT_KYC_REQUIRED")) {
      return sendJson(res, 409, { error: "Complete KYC to receive your payout.", kycRequired: true });
    }
    const [status, message] = safeMessage(error);
    return sendJson(res, status, { error: message });
  }
}
