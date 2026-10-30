import { sendJson, supabaseRequest } from "../server/supabase.js";
import { requireRole } from "../server/auth-middleware.js";
import { contentError } from "../server/content-policy.js";
import { darajaCollectionStatus, paymentProviderReadiness } from "./checkout.js";

import { checkProviderHealth, darajaConfiguredEnvironment, isSecurePublicOrigin } from "../server/payment-adapters.js";

const rpc = (name, token, body = {}) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { token, method: "POST", body });

// Owner-only diagnostics: booleans and the public callback address only. Never returns
// credentials, tokens or the shortcode. The optional health probe is OAuth token only
// (never STK push or query) and runs only when credentials point at production.
async function darajaReadiness(token, query) {
  const origin = String(process.env.WEDDINGSITE_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const shortcode = String(process.env.DARAJA_SHORTCODE || "");
  const configured = darajaConfiguredEnvironment();
  let approval = null;
  let approvalUnavailable = false;
  try { approval = await rpc("owner_get_daraja_live_approval", token); }
  catch { approvalUnavailable = true; console.error("Daraja Owner approval could not be read."); }
  const result = {
    configuredEnvironment: configured || "unconfigured",
    callback: { origin, path: "/api/webhooks?provider=daraja", url: `${origin}/api/webhooks?provider=daraja`, originSecure: isSecurePublicOrigin(origin) },
    shortcodeFormatValid: /^\d{5,7}$/.test(shortcode),
    shortcodeConfirmationMatches: Boolean(shortcode) && process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED === shortcode,
    credentialsPresent: {
      consumerKey: Boolean(process.env.DARAJA_CONSUMER_KEY), consumerSecret: Boolean(process.env.DARAJA_CONSUMER_SECRET),
      passkey: Boolean(process.env.DARAJA_PASSKEY)
    },
    modeIsLive: process.env.WEDDINGSITE_PAYMENT_MODE === "live",
    environmentIsProduction: process.env.DARAJA_ENVIRONMENT === "production",
    killSwitchOn: process.env.DARAJA_LIVE_COLLECTION_ENABLED === "true",
    ownerApproved: approvalUnavailable ? null : approval?.approved === true && approval.shortcode === shortcode,
    approvalUnavailable,
    payouts: "off",
    health: { checked: false, healthy: null }
  };
  if (query.health === "1" && configured === "production") {
    result.health = { checked: true, healthy: await checkProviderHealth("daraja") };
  }
  return result;
}

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
  "payment-controls": async t => ({ enabled: await rpc("admin_get_payment_controls", t), providers: paymentProviderReadiness(), daraja: await darajaCollectionStatus() }),
  "daraja-readiness": async (t, q) => darajaReadiness(t, q),
  "policy-history": async (t) => ({ history: await rpc("admin_policy_history", t, { p_limit: 50 }) }),
  "wedding-metrics": async (t, q) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(q.weddingId || ""))) throw new Error("Invalid wedding.");
    return { metrics: await rpc("admin_wedding_metrics", t, { p_wedding_id: q.weddingId }) };
  },
  moderation: async (t, q) => ({ cases: await rpc("admin_moderation_cases", t, { p_include_closed: q.closed === "1" }) })
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEDDING_ACTIONS = new Set(["archive", "restore", "unpublish", "waive_fee"]);
const RESTRICTING_ACTIONS = new Set(["archive", "unpublish"]);
const REASON_CODES = new Set(["content_policy", "inaccurate_details", "payment_issue", "legal_request", "safety", "other"]);
const REVIEW_DECISIONS = new Set(["republish", "lift", "return"]);
const text = value => typeof value === "string" ? value.trim() : "";
const ROLES = new Set(["client", "admin", "superadmin"]);
const PAYOUT_STATUSES = new Set(["approved", "sent", "cancelled"]);
const LEADERSHIP_ACTIONS = new Set(["overview", "ledger", "payouts", "audit", "policies", "refund-policy", "payment-controls", "policy-history", "set-role", "payment-controls-save"]);
const OWNER_ACTIONS = new Set(["policies-save", "refund-policy-save", "daraja-readiness", "daraja-approval"]);

function safeMessage(error) {
  const m = String(error?.message || "");
  const moderation = m.match(/MODERATION:\s*([^\n]{1,300})/);
  if (moderation) return [409, moderation[1].trim()];
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
      const note = text(body.note);
      if (body.status === "cancelled" && (note.length < 10 || note.length > 240)) {
        return sendJson(res, 400, { error: "Give the Client a cancellation reason in 10 to 240 characters." });
      }
      await rpc("admin_set_payout_status", token, { p_payout_id: body.payout_id, p_status: body.status, p_note: note.slice(0, 240) || null });
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
    if (action === "daraja-approval") {
      // Protected-Owner only (OWNER_ACTIONS); the database RPC re-checks the role and audits the change.
      if (typeof body.approved !== "boolean") return sendJson(res, 400, { error: "Choose approve or revoke." });
      if (body.approved) {
        const configured = String(process.env.DARAJA_SHORTCODE || "");
        if (body.confirmed !== true || darajaConfiguredEnvironment() !== "production" ||
            !/^\d{5,7}$/.test(String(body.shortcode || "")) || body.shortcode !== configured) {
          return sendJson(res, 400, { error: "Confirm the real-charge warning and enter the exact production shortcode configured for this deployment." });
        }
      }
      if (body.approved && !await checkProviderHealth("daraja")) {
        return sendJson(res, 409, { error: "Daraja readiness check failed (OAuth health). Approval was not granted; run the readiness check and fix configuration first." });
      }
      await rpc("owner_set_daraja_live_approval", token, { p_approved: body.approved, p_shortcode: body.approved ? body.shortcode : null });
      return sendJson(res, 200, { ok: true, daraja: await darajaCollectionStatus() });
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
      if (!WEDDING_ACTIONS.has(body.action) || !UUID.test(String(body.wedding_id || ""))) return sendJson(res, 400, { error: "Invalid wedding action." });
      const params = { p_wedding_id: body.wedding_id, p_action: body.action };
      if (RESTRICTING_ACTIONS.has(body.action)) {
        const reason = text(body.reason), requiredAction = text(body.required_action);
        if (!REASON_CODES.has(body.reason_code)) return sendJson(res, 400, { error: "Choose a reason category." });
        if (reason.length < 15 || reason.length > 1000) return sendJson(res, 400, { error: "Explain the reason for the Client in 15 to 1000 characters." });
        if (requiredAction.length < 10 || requiredAction.length > 1000) {
          return sendJson(res, 400, { error: "Describe what the Client must correct in 10 to 1000 characters." });
        }
        Object.assign(params, { p_reason_code: body.reason_code, p_reason: reason, p_required_action: requiredAction });
      }
      await rpc("admin_wedding_action", token, params);
      return sendJson(res, 200, { ok: true });
    }
    if (action === "moderation-review") {
      const note = text(body.note);
      if (!UUID.test(String(body.case_id || "")) || !REVIEW_DECISIONS.has(body.decision) ||
          !Number.isSafeInteger(body.expected_revision) || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Choose a case decision and confirm it." });
      }
      if (note.length > 1000 || (body.decision === "return" && note.length < 10)) {
        return sendJson(res, 400, { error: "Tell the Client what is still required in 10 to 1000 characters." });
      }
      const result = await rpc("admin_review_moderation_case", token, {
        p_case_id: body.case_id, p_decision: body.decision, p_note: note || null, p_expected_revision: body.expected_revision
      });
      return sendJson(res, 200, { ok: true, case: result });
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
