import { sendJson, supabaseRequest } from "../server/supabase.js";
import { requireRole } from "../server/auth-middleware.js";

const rpc = (name, token, body = {}) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { token, method: "POST", body });

const GET_ACTIONS = {
  overview: (t) => rpc("admin_overview", t),
  weddings: async (t) => ({ weddings: await rpc("admin_list_weddings", t) }),
  users: async (t, q) => ({ users: await rpc("admin_list_users", t, { p_search: q.search || null }) }),
  ledger: async (t) => ({ ledger: await rpc("admin_ledger", t, { p_limit: 500 }) }),
  payouts: async (t) => ({ payouts: await rpc("admin_payouts", t) }),
  audit: async (t) => ({ audit: await rpc("admin_audit", t, { p_limit: 500 }) }),
  policies: async (t) => ({ policies: await rpc("admin_get_policies", t) }),
  "wedding-metrics": async (t, q) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(q.weddingId || ""))) throw new Error("Invalid wedding.");
    return { metrics: await rpc("admin_wedding_metrics", t, { p_wedding_id: q.weddingId }) };
  }
};

const WEDDING_ACTIONS = new Set(["archive", "restore", "unpublish", "waive_fee"]);
const ROLES = new Set(["client", "admin", "superadmin"]);
const PAYOUT_STATUSES = new Set(["approved", "sent", "cancelled"]);

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

  try {
    if (req.method === "GET") {
      if (action === "role") return sendJson(res, 200, { role });
      const fn = GET_ACTIONS[action];
      if (!fn) return sendJson(res, 404, { error: "Unknown action." });
      return sendJson(res, 200, await fn(token, req.query || {}));
    }

    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    if (action === "set-role") {
      if (!["owner", "superadmin"].includes(role)) return sendJson(res, 403, { error: "Only the Owner or a SuperAdmin can change roles." });
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
    if (action === "wedding-action") {
      if (!WEDDING_ACTIONS.has(body.action) || !body.wedding_id) return sendJson(res, 400, { error: "Invalid wedding action." });
      await rpc("admin_wedding_action", token, { p_wedding_id: body.wedding_id, p_action: body.action });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("admin endpoint failed", action, String(error?.message || "").slice(0, 300));
    const [status, message] = safeMessage(error);
    return sendJson(res, status, { error: message });
  }
}
