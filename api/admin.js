import { sendJson, supabaseRequest } from "../server/supabase.js";
import { requireRole } from "../server/auth-middleware.js";
import { contentError } from "../server/content-policy.js";
import { referralError } from "../server/referral-errors.js";
import b2cHandler from "../server/b2c-api.js";
import { darajaCollectionStatus, paymentProviderReadiness } from "./checkout.js";

import { checkProviderHealth, darajaConfiguredEnvironment, isSecurePublicOrigin } from "../server/payment-adapters.js";
import {
  paystackEnvironment, paystackMerchant, paystackCredentialFingerprint, paystackReadiness,
  verifiedSubaccount, reconcilePaystackSettlement
} from "../server/paystack.js";

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
  "referral-policy": async t => ({ policy: await rpc("referral_admin_policy", t) }),
  "referral-history": async t => ({ history: await rpc("referral_admin_history", t) }),
  "referral-ledger": async (t, q) => {
    if (q.before !== undefined && !/^[1-9][0-9]{0,18}$/.test(q.before)) throw new Error("Invalid referral cursor.");
    return rpc("referral_admin_ledger", t, { p_before: q.before || null });
  },
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
  "payment-controls": async t => ({ enabled: await rpc("admin_get_payment_controls", t), providers: paymentProviderReadiness(), daraja: await darajaCollectionStatus(), paystack: await paystackReadiness() }),
  "paystack-readiness": async () => paystackReadiness(),
  "paystack-publication-adjustments": async t => ({ adjustments: await rpc("admin_paystack_publication_adjustments", t) }),
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
const LEADERSHIP_ACTIONS = new Set(["overview", "ledger", "payouts", "audit", "policies", "refund-policy", "payment-controls", "policy-history", "set-role", "payment-controls-save", "paystack-settlement", "paystack-publication-adjustments"]);
const OWNER_ACTIONS = new Set(["policies-save", "refund-policy-save", "daraja-readiness", "daraja-approval", "paystack-readiness", "paystack-policy", "paystack-settlement-mode", "paystack-destination", "paystack-publication-resolution"]);

function safeMessage(error) {
  const m = String(error?.message || "");
  if (/REFERRAL_CONFLICT:/.test(m)) return referralError(error);
  const moderation = m.match(/MODERATION:\s*([^\n]{1,300})/);
  if (moderation) return [409, moderation[1].trim()];
  if (/another staff|different/i.test(m)) return [409, "A different staff member must approve this payout."];
  if (/Access denied|permission|not allowed|only the owner|superadmin/i.test(m)) return [403, "Your role does not allow this action."];
  if (/cannot change your own/i.test(m)) return [400, "You cannot change your own role."];
  if (/invalid|must be|required|choose|cannot move/i.test(m)) return [400, "The request was not valid."];
  return [503, "The admin service could not complete the request."];
}

export default async function handler(req, res) {
  if (req.query?.b2c === "1") return b2cHandler(req, res);
  const session = await requireRole(req, res, ["owner", "superadmin", "admin"]);
  if (!session) return;
  const role = session.profile.platform_role;
  const action = String(req.query?.action || "role");
  const token = session.token;
  if ((["referral-policy", "referral-history", "referral-ledger"].includes(action) && !["owner", "superadmin"].includes(role)) ||
      (action === "referral-policy-save" && role !== "owner")) {
    return sendJson(res, 403, { error: "Your role does not allow this referral action." });
  }
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
    if (action === "referral-policy-save") {
      if (typeof body.enabled !== "boolean" || !Number.isInteger(body.rateBasisPoints) ||
          body.rateBasisPoints < 0 || body.rateBasisPoints > 10000 || !UUID.test(String(body.revision || "")) || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm valid referral settings and the current revision." });
      }
      return sendJson(res, 200, { policy: await rpc("referral_owner_policy", token, {
        p_enabled: body.enabled, p_rate_basis_points: body.rateBasisPoints, p_revision: body.revision, p_confirmed: true
      }) });
    }

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
      // Approval binds the deployment's own configured shortcode (already equal to the explicit
      // confirmation variable for a production environment); the value is never typed or returned.
      const configured = String(process.env.DARAJA_SHORTCODE || "");
      if (body.approved && (body.confirmed !== true || darajaConfiguredEnvironment() !== "production" || !/^\d{5,7}$/.test(configured))) {
        return sendJson(res, 400, { error: "Confirm the real-charge warning. The deployment must be configured for production with a valid, confirmed shortcode." });
      }
      if (body.approved && !await checkProviderHealth("daraja")) {
        return sendJson(res, 409, { error: "Daraja readiness check failed (OAuth health). Approval was not granted; run the readiness check and fix configuration first." });
      }
      await rpc("owner_set_daraja_live_approval", token, { p_approved: body.approved, p_shortcode: body.approved ? configured : null });
      return sendJson(res, 200, { ok: true, daraja: await darajaCollectionStatus() });
    }
    if (action === "paystack-policy") {
      if (typeof body.approved !== "boolean" || body.confirmed !== true || !UUID.test(body.policyRevision || "") ||
          (body.approved && (body.eligibilityConfirmed !== true || paystackEnvironment() !== "live" ||
            !paystackMerchant() || process.env.PAYSTACK_LIVE_MERCHANT_CONFIRMED !== paystackMerchant() ||
            !Array.isArray(body.capabilities) || body.capabilities.some(pair =>
              !/^[A-Z]{2}$/.test(pair?.market || "") || !globalThis.WSCurrencies.supportsAccounting(pair?.currency)) ||
            typeof body.standardEnabled !== "boolean" || typeof body.splitEnabled !== "boolean" || typeof body.publicationEnabled !== "boolean" ||
            !["account","subaccount"].includes(body.feeBearer)))) {
        return sendJson(res, 400, { error: "Reload and confirm the current policy, account-specific collection capabilities, approved scopes and live-charge warning." });
      }
      await rpc("owner_set_paystack_policy", token, {
        p_approved: body.approved, p_merchant_id: paystackMerchant(),
        p_credential_fingerprint: paystackCredentialFingerprint(), p_capabilities: body.capabilities || [],
        p_split_enabled: body.splitEnabled === true, p_publication_enabled: body.publicationEnabled === true,
        p_fee_bearer: body.feeBearer || "subaccount", p_confirmed: true,
        p_standard_enabled: body.standardEnabled === true, p_expected_revision: body.policyRevision
      });
      return sendJson(res, 200, { ok: true, paystack: await paystackReadiness() });
    }
    if (action === "paystack-settlement-mode") {
      if (!["standard","split"].includes(body.mode) || !UUID.test(body.policyRevision || "") || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm the current standard or split settlement mode." });
      }
      if (body.mode === "split") {
        const readiness = await paystackReadiness();
        if (!readiness.splitReady) return sendJson(res, 409, { error: readiness.splitHoldingReason });
      }
      await rpc("owner_set_paystack_settlement_mode", token, {
        p_mode: body.mode, p_revision: body.policyRevision, p_confirmed: true
      });
      return sendJson(res, 200, { ok: true, paystack: await paystackReadiness() });
    }
    if (action === "paystack-destination") {
      if (!UUID.test(body.weddingId || "") || body.confirmed !== true || paystackEnvironment() !== "live") {
        return sendJson(res, 400, { error: "Confirm a valid wedding and pre-existing Paystack destination." });
      }
      const wedding = (await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&select=currency`, { service: true }))?.[0];
      if (!wedding) return sendJson(res, 404, { error: "Wedding not found." });
      const verified = await verifiedSubaccount(body.subaccountCode, wedding.currency);
      await rpc("owner_verify_paystack_destination", token, { p_wedding_id: body.weddingId, p_data: verified, p_confirmed: true });
      return sendJson(res, 200, { ok: true, message: "Destination verified. Couple consent is required before direct settlement." });
    }
    if (action === "paystack-settlement") {
      if (!UUID.test(body.contributionId || "") || !/^[1-9]\d{0,19}$/.test(body.settlementId || "") || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm the contribution and provider settlement statement ID." });
      }
      await reconcilePaystackSettlement(body.contributionId, body.settlementId, session.user.id);
      return sendJson(res, 200, { ok: true });
    }
    if (action === "paystack-publication-resolution") {
      if (!/^[a-f0-9]{64}$/.test(body.eventId || "") || !["retain_paid","require_payment","waive"].includes(body.outcome) ||
          body.confirmed !== true || text(body.reason).length < 10 || text(body.reason).length > 240) {
        return sendJson(res, 400, { error: "Confirm the publication entitlement decision and give a reason (10-240 characters)." });
      }
      await rpc("owner_resolve_paystack_publication", token, {
        p_event_id: body.eventId, p_outcome: body.outcome, p_reason: text(body.reason), p_confirmed: true
      });
      return sendJson(res, 200, { ok: true });
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
