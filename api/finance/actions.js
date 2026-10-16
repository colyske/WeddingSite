import { authenticatedUser, methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

const isId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;

const actions = {
  expense: {
    rpc: "record_expense",
    validate: body => isId(body.weddingId) && validText(body.category, 80) && validText(body.description, 240) &&
      Number.isSafeInteger(body.amountMinor) && body.amountMinor > 0 && /^[A-Z]{3}$/.test(body.currency) &&
      (body.dueOn === null || body.dueOn === undefined || /^\d{4}-\d{2}-\d{2}$/.test(body.dueOn)) && body.confirmed === true,
    args: body => ({
      p_wedding_id: body.weddingId, p_category: body.category.trim(), p_description: body.description.trim(),
      p_amount_minor: body.amountMinor, p_currency: body.currency, p_due_on: body.dueOn || null,
      p_confirmed: body.confirmed
    })
  },
  payout_request: {
    rpc: "request_payout",
    validate: body => isId(body.weddingId) && Number.isSafeInteger(body.amountMinor) && body.amountMinor > 0 &&
      /^[A-Z]{3}$/.test(body.currency) && (body.note === undefined || (typeof body.note === "string" && body.note.length <= 240)) &&
      body.confirmed === true,
    args: body => ({
      p_wedding_id: body.weddingId, p_amount_minor: body.amountMinor, p_currency: body.currency,
      p_note: body.note || null, p_confirmed: body.confirmed
    })
  },
  reconciliation: {
    rpc: "record_reconciliation",
    validate: body => isId(body.weddingId) && validText(body.provider, 60) &&
      validText(body.statementReference, 120) && Number.isSafeInteger(body.expectedMinor) &&
      Number.isSafeInteger(body.reportedMinor) && /^[A-Z]{3}$/.test(body.currency) &&
      (body.note === undefined || (typeof body.note === "string" && body.note.length <= 400)) && body.confirmed === true,
    args: body => ({
      p_wedding_id: body.weddingId, p_provider: body.provider.trim(),
      p_statement_reference: body.statementReference.trim(), p_expected_minor: body.expectedMinor,
      p_reported_minor: body.reportedMinor, p_currency: body.currency, p_note: body.note || null,
      p_confirmed: body.confirmed
    })
  },
  budget: {
    rpc: "save_budget_line",
    validate: body => isId(body.weddingId) && validText(body.category, 80) &&
      Number.isSafeInteger(body.plannedMinor) && body.plannedMinor >= 0 &&
      Number.isSafeInteger(body.actualMinor) && body.actualMinor >= 0 &&
      /^[A-Z]{3}$/.test(body.currency) && body.confirmed === true,
    args: body => ({
      p_wedding_id: body.weddingId, p_category: body.category.trim(),
      p_planned_minor: body.plannedMinor, p_actual_minor: body.actualMinor,
      p_currency: body.currency, p_confirmed: body.confirmed
    })
  },
  payment_provider: {
    rpc: "configure_payment_provider",
    validate: body => isId(body.weddingId) && ["stripe", "paystack"].includes(body.provider) &&
      typeof body.enabled === "boolean" && Array.isArray(body.marketCodes) && body.marketCodes.length <= 40 &&
      body.marketCodes.every(code => typeof code === "string" && /^[A-Z0-9_-]{2,12}$/.test(code)) &&
      Array.isArray(body.currencies) && body.currencies.length <= 30 &&
      body.currencies.every(code => typeof code === "string" && /^[A-Z]{3}$/.test(code)) && body.confirmed === true,
    args: body => ({
      p_wedding_id: body.weddingId, p_provider: body.provider, p_enabled: body.enabled,
      p_market_codes: body.marketCodes, p_currencies: body.currencies, p_confirmed: body.confirmed
    })
  }
};

export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;
  let session;
  try {
    session = await authenticatedUser(req);
  } catch (error) {
    console.error("finance action authentication failed", error.message);
    return sendJson(res, 503, { error: "Authentication service is unavailable or misconfigured." });
  }
  if (!session) return sendJson(res, 401, { error: "Sign in to submit a private finance record." });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const action = actions[body.action];
  if (!action || !action.validate(body)) {
    return sendJson(res, 400, { error: "Invalid finance action or fields; explicit confirmation is required." });
  }
  try {
    const recordId = await supabaseRequest(`/rest/v1/rpc/${action.rpc}`, {
      method: "POST",
      token: session.token,
      body: action.args(body)
    });
    const statuses = { payout_request: "requested", reconciliation: "pending_review", expense: "proposed", budget: "saved", payment_provider: "configured" };
    return sendJson(res, 201, { recordId, status: statuses[body.action] });
  } catch (error) {
    console.error("finance action failed", error.message);
    return sendJson(res, error.status || 403, { error: "Finance record was not created. Check your role, workspace access, and limits." });
  }
}
