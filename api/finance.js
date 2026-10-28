import { authenticatedUser, csvCell, methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

function toCsv(rows) {
  if (!rows.length) return "No records\n";
  const columns = Object.keys(rows[0]);
  return [columns.map(csvCell).join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n");
}

const isId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;

const financeActions = {
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

async function handleReportQuery(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const weddingId = String(req.query.weddingId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(weddingId)) {
    return sendJson(res, 400, { error: "A valid weddingId is required." });
  }
  let session;
  try {
    session = await authenticatedUser(req);
  } catch (error) {
    console.error("private finance authentication failed", error.message);
    return sendJson(res, 503, { error: "Authentication service is unavailable or misconfigured." });
  }
  if (!session) return sendJson(res, 401, { error: "Sign in to view private financial records." });
  try {
    const filter = `wedding_id=eq.${encodeURIComponent(weddingId)}`;
    const [summary, contributions, expenses, payouts, budgets, reconciliations, alerts, adjustmentData, audit] = await Promise.all([
      supabaseRequest(`/rest/v1/finance_summary?${filter}&select=*`, { token: session.token }),
      supabaseRequest(`/rest/v1/contributions?${filter}&select=id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,currency,payment_status,created_at&order=created_at.desc&limit=1000`, { token: session.token }),
      supabaseRequest(`/rest/v1/expenses?${filter}&select=id,category,description,amount_minor,currency,status,due_on,created_at&order=created_at.desc&limit=1000`, { token: session.token }),
      supabaseRequest(`/rest/v1/payout_records?${filter}&select=id,amount_minor,currency,status,requested_at,confirmed_at&order=requested_at.desc&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/budget_lines?${filter}&select=id,category,planned_minor,actual_minor,currency,updated_at&order=category&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/reconciliation_records?${filter}&select=id,provider,statement_reference,expected_minor,reported_minor,difference_minor,currency,status,created_at&order=created_at.desc&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/finance_alerts?wedding_id=eq.${encodeURIComponent(weddingId)}&select=*&order=occurred_at.desc&limit=500`, { token: session.token }),
      supabaseRequest("/rest/v1/rpc/get_wedding_financial_adjustments", {
        method: "POST", token: session.token, body: { p_wedding_id: weddingId }
      }),
      supabaseRequest(`/rest/v1/audit_events?wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,actor_id,source,action,table_name,record_id,changed_fields,created_at&order=created_at.desc&limit=1000`, { token: session.token })
    ]);
    const report = { summary: summary || [], contributions: contributions || [], expenses: expenses || [], payouts: payouts || [], budgets: budgets || [], reconciliations: reconciliations || [], alerts: alerts || [], adjustments: adjustmentData?.adjustments || [], adjustmentLedger: adjustmentData?.ledger || [], audit: audit || [] };
    if (req.query.format === "csv") {
      const rows = [
        ...report.contributions.map(row => ({ record_type: "contribution", ...row })),
        ...report.expenses.map(row => ({ record_type: "expense", ...row })),
        ...report.payouts.map(row => ({ record_type: "payout_record", ...row })),
        ...report.reconciliations.map(row => ({ record_type: "reconciliation", ...row })),
        ...report.adjustments.map(row => ({ record_type: "provider_adjustment", ...row })),
        ...report.adjustmentLedger.map(row => ({ record_type: "adjustment_ledger", ...row })),
        ...report.audit.map(row => ({ record_type: "audit_event", ...row }))
      ];
      res.status(200).setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="weddingsite-finance-export.csv"');
      res.setHeader("Cache-Control", "no-store");
      return res.end(toCsv(rows));
    }
    return sendJson(res, 200, report);
  } catch (error) {
    console.error("private finance report failed", error.message);
    return sendJson(res, error.status || 503, { error: "Financial report access failed. Verify workspace membership and database configuration." });
  }
}

async function handleAction(req, res) {
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
  const action = financeActions[body.action];
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

export default async function handler(req, res) {
  const action = String(req.query.action || "report").toLowerCase();
  if (action === "report") return handleReportQuery(req, res);
  if (action === "record") return handleAction(req, res);
  return sendJson(res, 400, { error: "Unknown action." });
}
