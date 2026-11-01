import { authenticatedUser, methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { timingSafeEqual } from "node:crypto";
import { b2cReadiness, dispatchB2c, receiveB2cCallback, runB2cWorker } from "../server/b2c.js";

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const rpc = (name, token, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", token, body });

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
      if (!uuid(req.query.dispatch)) return sendJson(res, 400, { error: "Invalid dispatch." });
      if (typeof req.body !== "object" || req.body === null || Buffer.byteLength(JSON.stringify(req.body)) > 16000) {
        return sendJson(res, 400, { error: "Invalid callback payload." });
      }
      await receiveB2cCallback(req.query.dispatch, req.query.token, action, req.body);
      return sendJson(res, 200, { ResultCode: 0, ResultDesc: "Received" });
    }
    const session = await authenticatedUser(req);
    if (!session) return sendJson(res, 401, { error: "Staff authentication required." });
    if (action === "readiness" || action === "policy") {
      if (!methodOnly(req, res, "GET")) return;
      const policy = await rpc("owner_get_b2c_policy", session.token);
      return sendJson(res, 200, { policy, readiness: b2cReadiness(), recipientVerification: "independent_statement_review_required" });
    }
    if (action === "controls") {
      if (!methodOnly(req, res, "GET")) return;
      return sendJson(res, 200, { policy: await rpc("staff_b2c_controls", session.token), readiness: b2cReadiness() });
    }
    if (action === "status") {
      if (!methodOnly(req, res, "GET")) return;
      if (req.query.payout && !uuid(req.query.payout)) return sendJson(res, 400, { error: "Invalid payout." });
      return sendJson(res, 200, { dispatches: await rpc("b2c_status", session.token, { p_payout: req.query.payout || null }) });
    }
    if (!methodOnly(req, res, "POST")) return;
    const body = req.body;
    if (!body || typeof body !== "object" || body.confirmed !== true) return sendJson(res, 400, { error: "Explicit confirmation required." });
    if (action === "policy-save") {
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) return sendJson(res, 400, { error: "Policy revision required." });
      return sendJson(res, 200, { policy: await rpc("owner_update_b2c_policy", session.token,
        { p_revision: body.revision, p_changes: body.changes, p_reason: body.reason }) });
    }
    if (action === "recipient-review") {
      if (!uuid(body.weddingId) || (body.revoke !== true && !uuid(body.contributionId))) return sendJson(res, 400, { error: "Wedding and evidence contribution required." });
      await rpc("owner_review_b2c_recipient", session.token, {
        p_wedding: body.weddingId, p_msisdn: body.msisdn || null, p_contribution: body.contributionId || null,
        p_statement_reference: body.statementReference || null, p_revoke: body.revoke === true
      });
      return sendJson(res, 200, { reviewed: true });
    }
    if (action === "dispatch") {
      if (!uuid(body.payoutId) || !uuid(body.idempotencyKey)) return sendJson(res, 400, { error: "Payout and idempotency key required." });
      return sendJson(res, 200, await dispatchB2c(body.payoutId, body.idempotencyKey, session.token));
    }
    if (action === "reconcile") {
      if (!uuid(body.dispatchId) || !["succeeded", "failed", "inconclusive"].includes(body.outcome) ||
          (body.outcome !== "inconclusive" && (!Number.isSafeInteger(body.amountMinor) || body.amountMinor <= 0))) {
        return sendJson(res, 400, { error: "Dispatch and official statement evidence required." });
      }
      return sendJson(res, 200, { state: await rpc("staff_reconcile_b2c", session.token, {
        p_dispatch: body.dispatchId, p_reference: body.statementReference, p_outcome: body.outcome,
        p_transaction: body.transactionId || null, p_msisdn: body.msisdn || null, p_amount: body.amountMinor || null
      }) });
    }
    return sendJson(res, 400, { error: "Unknown B2C action." });
  } catch (error) {
    // Never log callback URLs, capabilities, credentials or raw provider payloads.
    console.error("B2C request failed", error.message);
    const callback = action === "result" || action === "timeout";
    return sendJson(res, callback ? 403 : 409, {
      error: callback ? "Callback authentication or correlation failed." : "B2C action blocked. Check role, approval, verification, policy revision, funding and deployment prerequisites."
    });
  }
}
