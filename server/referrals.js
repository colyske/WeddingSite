import { methodOnly, sendJson, supabaseRequest } from "./supabase.js";
import { requireAuth, requireRole } from "./auth-middleware.js";
import { referralError } from "./referral-errors.js";

const CODE = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RECIPIENT_CONSENT = "facilitator-mpesa-recipient-v1";
const rpc = (name, token, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, { token, method: "POST", body });
const parseBody = req => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    return body && !Array.isArray(body) && typeof body === "object" ? body : null;
  } catch { return null; }
};
const exactFields = (body, fields) => body && Object.keys(body).every(key => fields.includes(key));
const normalizeMpesaPhone = value => {
  const phone = String(value || "").replace(/[\s()-]/g, "");
  if (/^0[17]\d{8}$/.test(phone)) return `254${phone.slice(1)}`;
  if (/^\+254[17]\d{8}$/.test(phone)) return phone.slice(1);
  return /^254[17]\d{8}$/.test(phone) ? phone : null;
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "summary");
  try {
    if (action === "validate") {
      if (!methodOnly(req, res, "GET")) return;
      const code = String(req.query?.code || "");
      if (!CODE.test(code)) return sendJson(res, 400, { error: "Invalid referral code." });
      return sendJson(res, 200, await rpc("referral_validate_code", undefined, { p_code: code }));
    }
    if (action === "summary" || action === "disclosure") {
      if (!methodOnly(req, res, "GET")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      return sendJson(res, 200, await rpc(action === "summary" ? "referral_my_summary" : "referral_disclosure", session.token));
    }
    const ownerActions = ["recipient-workspace", "recipient-evidence", "recipient-verify"];
    const staffActions = ["manual-staff-workspace", "manual-staff-action", "manual-sender-snapshot",
      "manual-sender-current", "manual-incident-evidence", "manual-incident-review"];
    const readActions = ["recipient-mine", "recipient-workspace", "manual-workspace", "manual-staff-workspace",
      "manual-sender-snapshot", "manual-sender-current"];
    if (!["consent", "capture", "recipient-mine", "recipient-submit", "manual-workspace", "manual-submit",
      ...ownerActions, ...staffActions].includes(action)) {
      return sendJson(res, 404, { error: "Unknown referral action." });
    }
    if (!methodOnly(req, res, readActions.includes(action) ? "GET" : "POST")) return;
    const session = ownerActions.includes(action)
      ? await requireRole(req, res, ["owner", "superadmin"])
      : staffActions.includes(action) ? await requireRole(req, res, ["admin", "owner", "superadmin"])
        : await requireAuth(req, res);
    if (!session) return;
    if (action === "manual-workspace" || action === "manual-staff-workspace") {
      return sendJson(res, 200, await rpc(action === "manual-workspace"
        ? "facilitator_manual_workspace" : "facilitator_manual_staff_workspace", session.token));
    }
    if (action === "manual-sender-snapshot" || action === "manual-sender-current") {
      if (!UUID.test(String(req.query?.id || ""))) return sendJson(res, 400, { error: "Select a valid request." });
      return sendJson(res, 200, await rpc(action === "manual-sender-current" ?
        "facilitator_manual_sender_current" : "facilitator_manual_sender_snapshot", session.token, { p_request: req.query.id }));
    }
    if (action === "recipient-mine") {
      return sendJson(res, 200, await rpc("facilitator_recipient_mine", session.token));
    }
    if (action === "recipient-workspace") {
      return sendJson(res, 200, { recipients: await rpc("facilitator_recipient_workspace", session.token) });
    }
    const body = parseBody(req);
    if (!body) return sendJson(res, 400, { error: "Invalid referral request." });
    if (action === "manual-incident-evidence" || action === "manual-incident-review") {
      if (typeof body.incident !== "string" || !/^[1-9][0-9]{0,18}$/.test(body.incident) ||
        BigInt(body.incident) > 9223372036854775807n || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm a valid incident." });
      }
      if (action === "manual-incident-evidence") {
        if (!exactFields(body, ["incident", "key", "reference", "sha256", "confirmed"]) ||
          !UUID.test(body.key || "") || !UUID.test(body.reference || "") || !SHA256.test(body.sha256 || "")) {
          return sendJson(res, 400, { error: "Provide confirmed investigation evidence and its digest." });
        }
        return sendJson(res, 200, { evidence_id: await rpc("facilitator_manual_incident_evidence_add", session.token,
          { p_incident: body.incident, p_key: body.key, p_reference: body.reference, p_sha256: body.sha256, p_confirmed: true }) });
      }
      if (!exactFields(body, ["incident", "evidence", "ownerSolo", "confirmed"]) ||
        !UUID.test(body.evidence || "") || typeof body.ownerSolo !== "boolean") {
        return sendJson(res, 400, { error: "Confirm the investigation and reviewer mode." });
      }
      if (body.ownerSolo && session.profile.platform_role !== "owner") {
        return sendJson(res, 403, { error: "Only the Owner can review solo." });
      }
      await rpc("facilitator_manual_incident_review", session.token, { p_incident: body.incident,
        p_evidence: body.evidence, p_owner_solo: body.ownerSolo, p_confirmed: true });
      return sendJson(res, 200, { reviewed: true, do_not_resend: true });
    }
    if (action === "manual-submit") {
      if (!exactFields(body, ["key", "recipient", "review", "amount", "confirmed"]) ||
        !UUID.test(body.key || "") || !UUID.test(body.recipient || "") || !UUID.test(body.review || "") ||
        !Number.isSafeInteger(body.amount) || body.amount < 1 || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm a valid recipient, source and amount." });
      }
      return sendJson(res, 200, { request_id: await rpc("facilitator_manual_submit", session.token, {
        p_key: body.key, p_recipient: body.recipient, p_review: body.review, p_amount: body.amount, p_confirmed: true
      }) });
    }
    if (action === "manual-staff-action") {
      if (!exactFields(body, ["id", "key", "action", "reason", "fee", "reference", "ownerSolo", "confirmed"]) ||
        !UUID.test(body.id || "") || !UUID.test(body.key || "") ||
        !["reviewed", "processing", "hold", "paid", "cancelled"].includes(body.action) ||
        typeof body.ownerSolo !== "boolean" || body.confirmed !== true ||
        !((body.fee === null) || (Number.isSafeInteger(body.fee) && body.fee >= 0)) ||
        !((body.reason === null) || typeof body.reason === "string") ||
        !((body.reference === null) || typeof body.reference === "string")) {
        return sendJson(res, 400, { error: "Confirm a valid payout action and its fields." });
      }
      if (body.ownerSolo && session.profile.platform_role !== "owner") {
        return sendJson(res, 403, { error: "Only the Owner can claim solo." });
      }
      return sendJson(res, 200, await rpc("facilitator_manual_staff_action", session.token, {
        p_request: body.id, p_key: body.key, p_action: body.action, p_reason: body.reason,
        p_fee: body.fee, p_reference: body.reference, p_owner_solo: body.ownerSolo, p_confirmed: true
      }));
    }
    if (action === "capture") {
      // Preserve the established capture contract: caller-supplied identity fields are ignored.
      if (!CODE.test(body.code || "")) return sendJson(res, 400, { error: "Invalid referral code." });
      const intentId = await rpc("referral_capture", session.token, { p_code: body.code });
      return sendJson(res, 200, { intent_id: intentId });
    }
    if (action === "consent") {
      if (!exactFields(body, ["optedIn", "termsVersion"]) || typeof body.optedIn !== "boolean" ||
        body.termsVersion !== "client-referrals-v1") {
        return sendJson(res, 400, { error: "Review the current referral terms." });
      }
      return sendJson(res, 200, await rpc("referral_set_consent", session.token, {
        p_opted_in: body.optedIn, p_terms_version: body.termsVersion
      }));
    }
    if (action === "recipient-submit") {
      if (!exactFields(body, ["requestKey", "fullName", "phone", "consent", "consentVersion"]) ||
        !UUID.test(body.requestKey || "") || typeof body.fullName !== "string" ||
        body.fullName.trim().length < 2 || body.fullName.trim().length > 120 ||
        body.consent !== true || body.consentVersion !== RECIPIENT_CONSENT) {
        return sendJson(res, 400, { error: "Provide your own name and phone and explicitly consent to the current recipient terms." });
      }
      const phone = normalizeMpesaPhone(body.phone);
      if (!phone) return sendJson(res, 400, { error: "Enter a valid Kenyan M-Pesa phone number." });
      return sendJson(res, 200, await rpc("facilitator_recipient_submit", session.token, {
        p_request_key: body.requestKey, p_full_name: body.fullName.trim(), p_phone: phone,
        p_consent: true, p_consent_version: RECIPIENT_CONSENT
      }));
    }
    if (action === "recipient-evidence") {
      if (!exactFields(body, ["revision", "reference", "sha256", "confirmed"]) ||
        !UUID.test(body.revision || "") || !UUID.test(body.reference || "") ||
        !SHA256.test(body.sha256 || "") || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Provide a current revision, external evidence reference, SHA-256 digest, and explicit confirmation." });
      }
      return sendJson(res, 200, { evidence_id: await rpc("facilitator_recipient_evidence_add", session.token, {
        p_revision: body.revision, p_reference: body.reference, p_sha256: body.sha256, p_confirmed: true
      }) });
    }
    if (action === "recipient-verify") {
      if (!exactFields(body, ["revision", "evidenceId", "ownerSolo", "confirmed"]) ||
        !UUID.test(body.revision || "") || !UUID.test(body.evidenceId || "") ||
        typeof body.ownerSolo !== "boolean" || body.confirmed !== true) {
        return sendJson(res, 400, { error: "Confirm the exact current revision, its checked evidence, and reviewer mode." });
      }
      if (body.ownerSolo && session.profile.platform_role !== "owner") {
        return sendJson(res, 403, { error: "Only the protected Owner may explicitly attest solo review." });
      }
      await rpc("facilitator_recipient_verify", session.token, {
        p_revision: body.revision, p_evidence: body.evidenceId,
        p_owner_solo: body.ownerSolo, p_confirmed: true
      });
      return sendJson(res, 200, { verified: true, revision: body.revision });
    }
    return sendJson(res, 400, { error: "Invalid referral action." });
  } catch (error) {
    const [status, message] = referralError(error);
    console.error("Referral request failed:", action, status);
    return sendJson(res, status, { error: message });
  }
}
