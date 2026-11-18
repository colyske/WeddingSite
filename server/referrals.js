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
    if (!["consent", "capture", "recipient-mine", "recipient-submit", ...ownerActions].includes(action)) {
      return sendJson(res, 404, { error: "Unknown referral action." });
    }
    if (!methodOnly(req, res, action === "recipient-mine" || action === "recipient-workspace" ? "GET" : "POST")) return;
    const session = ownerActions.includes(action) || action === "recipient-workspace"
      ? await requireRole(req, res, ["owner", "superadmin"])
      : await requireAuth(req, res);
    if (!session) return;
    if (action === "recipient-mine") {
      return sendJson(res, 200, await rpc("facilitator_recipient_mine", session.token));
    }
    if (action === "recipient-workspace") {
      return sendJson(res, 200, { recipients: await rpc("facilitator_recipient_workspace", session.token) });
    }
    const body = parseBody(req);
    if (!body) return sendJson(res, 400, { error: "Invalid referral request." });
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
