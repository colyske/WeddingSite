import { authenticatedUser, methodOnly, sendJson, supabaseConfig, supabaseRequest } from "./supabase.js";
import { timingSafeEqual } from "node:crypto";
import { b2cReadiness, dispatchB2c, receiveB2cCallback, runB2cWorker } from "./b2c.js";

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const rpc = (name, token, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", token, body });

async function phoneAuth(path, token, method, body) {
  const { url, apiKey } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1${path}`, {
    method, headers: { apikey: apiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000), cache: "no-store"
  });
  if (!response.ok) throw new Error("B2C: Phone verification unavailable, rate-limited or code invalid. Check configured Supabase SMS provider and retry only as instructed.");
}

export default async function handler(req, res) {
  const action = req.query?.action || "status";
  try {
    if (action === "worker") {
      if (!methodOnly(req, res, "GET")) return;
      const actual = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET || ""}`);
      if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return sendJson(res, 401, { error: "Scheduler authentication required." });
      }
      return sendJson(res, 200, await runB2cWorker());
    }
    if (action === "result" || action === "timeout") {
      if (!methodOnly(req, res, "POST")) return;
      if (!uuid(req.query.dispatch) || !req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Buffer.byteLength(JSON.stringify(req.body)) > 16000) return sendJson(res, 400, { error: "Invalid callback." });
      const observation = await receiveB2cCallback(req.query.dispatch, req.query.token, action, req.body);
      return sendJson(res, 200, { received: true, ...observation });
    }
    const session = await authenticatedUser(req);
    if (!session) return sendJson(res, 401, { error: "Authentication required." });
    if (action === "readiness" || action === "policy") {
      if (!methodOnly(req, res, "GET")) return;
      return sendJson(res, 200, { policy: await rpc("owner_get_b2c_policy", session.token), readiness: b2cReadiness() });
    }
    if (action === "controls") {
      if (!methodOnly(req, res, "GET")) return;
      return sendJson(res, 200, { policy: await rpc("staff_b2c_controls", session.token), readiness: b2cReadiness() });
    }
    if (action === "status") {
      if (!methodOnly(req, res, "GET")) return;
      return sendJson(res, 200, { dispatches: await rpc("b2c_status", session.token) });
    }
    if (action === "recipient-context") {
      if (!methodOnly(req, res, "GET")) return;
      if (!uuid(req.query.wedding)) return sendJson(res, 400, { error: "Wedding required." });
      return sendJson(res, 200, await rpc("b2c_recipient_context", session.token, { p_wedding: req.query.wedding }));
    }
    if (!methodOnly(req, res, "POST")) return;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true ||
      Buffer.byteLength(JSON.stringify(body)) > 16000) return sendJson(res, 400, { error: "Explicit confirmation and structured fields required." });
    if (action === "policy-save") {
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) return sendJson(res, 400, { error: "Current policy revision required." });
      return sendJson(res, 200, { policy: await rpc("owner_update_b2c_policy", session.token,
        { p_revision: body.revision, p_changes: body.changes, p_reason: body.reason }) });
    }
    if (action === "intake") return sendJson(res, 200, await rpc("b2c_intake", session.token, { p_action: body.kind, p_data: body.data }));
    if (action === "phone-start") {
      if (!uuid(body.weddingId) || !/^254[17]\d{8}$/.test(body.msisdn || "")) return sendJson(res, 400, { error: "Wedding and canonical partner phone required." });
      await rpc("b2c_phone_start", session.token, { p_wedding: body.weddingId, p_msisdn: body.msisdn });
      await phoneAuth("/user", session.token, "PUT", { phone: body.msisdn });
      return sendJson(res, 200, { requested: true, message: "Complete Supabase phone-change verification. Phone control does not verify identity." });
    }
    if (action === "phone-confirm") {
      if (!/^254[17]\d{8}$/.test(body.msisdn || "") || !/^\d{6,10}$/.test(body.code || "")) return sendJson(res, 400, { error: "Phone and verification code required." });
      await phoneAuth("/verify", session.token, "POST", { phone: body.msisdn, token: body.code, type: "phone_change" });
      return sendJson(res, 200, { submitted: true, message: "Code accepted. Bind the reviewed recipient revision to confirm current phone control." });
    }
    if (action === "bind") {
      if (!uuid(body.recipientId)) return sendJson(res, 400, { error: "Recipient revision required." });
      await rpc("b2c_bind_destination", session.token, { p_recipient: body.recipientId });
      return sendJson(res, 200, { bound: true, identitySource: "independently_reviewed_evidence_not_otp" });
    }
    if (action === "request") {
      if (![body.key, body.weddingId, body.custodyId, body.recipientId].every(uuid) ||
        !Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0 || body.amountMinor % 100 !== 0) {
        return sendJson(res, 400, { error: "Request key, wedding, custody, recipient and whole-KES amount required." });
      }
      return sendJson(res, 200, { id: await rpc("b2c_request", session.token, {
        p_key: body.key, p_wedding: body.weddingId, p_custody: body.custodyId, p_recipient: body.recipientId, p_amount: body.amountMinor
      }) });
    }
    if (action === "approve") {
      if (!uuid(body.payoutId)) return sendJson(res, 400, { error: "Payout required." });
      await rpc("staff_approve_b2c", session.token, { p_id: body.payoutId });
      return sendJson(res, 200, { approved: true });
    }
    if (action === "cancel") {
      if (!uuid(body.payoutId)) return sendJson(res, 400, { error: "Payout request required." });
      await rpc("b2c_cancel", session.token, { p_id: body.payoutId });
      return sendJson(res, 200, { cancelled: true });
    }
    if (action === "dispatch") {
      if (!uuid(body.payoutId) || !uuid(body.idempotencyKey)) return sendJson(res, 400, { error: "Payout and idempotency key required." });
      await rpc("b2c_status", session.token); // Role check before the service-only execution wrapper.
      return sendJson(res, 200, await dispatchB2c(body.payoutId, body.idempotencyKey));
    }
    if (action === "reconcile") {
      if (![body.dispatchId, body.receiptEvidenceId, body.evidenceId, body.accountId, body.statementId, body.lineId].every(uuid) ||
        !Number.isSafeInteger(body.amountMinor) || !Number.isSafeInteger(body.feeMinor) ||
        body.provider !== "daraja" || body.currency !== "KES") {
        return sendJson(res, 400, { error: "Distinct checked receipt/reconciliation evidence, exact provider/account/statement/line and amount/fee/currency required." });
      }
      return sendJson(res, 200, { state: await rpc("b2c_reconcile", session.token, {
        p_id: body.dispatchId, p_receipt: body.receiptEvidenceId, p_evidence: body.evidenceId,
        p_provider: body.provider, p_account: body.accountId, p_statement: body.statementId, p_line: body.lineId,
        p_reference: body.transactionId, p_actual: body.amountMinor, p_fee: body.feeMinor, p_currency: body.currency,
        p_msisdn: body.msisdn, p_at: body.transferredAt, p_booked_at: body.bookedAt
      }) });
    }
    if (action === "resolve") {
      if (!uuid(body.dispatchId) || !uuid(body.evidenceId) || typeof body.confirmResolution !== "boolean" ||
        body.actualFeeMinor !== 0) return sendJson(res, 400, { error: "Conclusive checked no-transfer and explicit zero-fee evidence required; otherwise retain holds." });
      return sendJson(res, 200, { state: await rpc("b2c_resolve", session.token, {
        p_id: body.dispatchId, p_evidence: body.evidenceId, p_confirm: body.confirmResolution, p_actual_fee: body.actualFeeMinor
      }) });
    }
    return sendJson(res, 400, { error: "Unknown B2C action." });
  } catch (error) {
    console.error("B2C action failed", action, error.status || "held");
    const callback = action === "result" || action === "timeout";
    return sendJson(res, callback ? 403 : 409, { error: callback ? "Callback authentication or processing failed; no settlement occurred."
      : /^(B2C[:_]|PAYOUT_KYC_REQUIRED)/.test(error.message) ? error.message
        : "B2C action held. Check authorization, policy revision, independently checked evidence, available custody, recipient and reservations." });
  }
}
