import { authenticatedUser, csvCell, methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";

function toCsv(rows) {
  if (!rows.length) return "No records\n";
  const columns = Object.keys(rows[0]);
  return [columns.map(csvCell).join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n");
}

export default async function handler(req, res) {
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
    const [summary, contributions, expenses, payouts, budgets, reconciliations, alerts, audit] = await Promise.all([
      supabaseRequest(`/rest/v1/finance_summary?${filter}&select=*`, { token: session.token }),
      supabaseRequest(`/rest/v1/contributions?${filter}&select=id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,currency,payment_status,created_at&order=created_at.desc&limit=1000`, { token: session.token }),
      supabaseRequest(`/rest/v1/expenses?${filter}&select=id,category,description,amount_minor,currency,status,due_on,created_at&order=created_at.desc&limit=1000`, { token: session.token }),
      supabaseRequest(`/rest/v1/payout_records?${filter}&select=id,amount_minor,currency,status,requested_at,confirmed_at&order=requested_at.desc&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/budget_lines?${filter}&select=id,category,planned_minor,actual_minor,currency,updated_at&order=category&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/reconciliation_records?${filter}&select=id,provider,statement_reference,expected_minor,reported_minor,difference_minor,currency,status,created_at&order=created_at.desc&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/finance_alerts?wedding_id=eq.${encodeURIComponent(weddingId)}&select=*&order=occurred_at.desc&limit=500`, { token: session.token }),
      supabaseRequest(`/rest/v1/audit_events?wedding_id=eq.${encodeURIComponent(weddingId)}&select=id,actor_id,source,action,table_name,record_id,changed_fields,created_at&order=created_at.desc&limit=1000`, { token: session.token })
    ]);
    const report = { summary: summary || [], contributions: contributions || [], expenses: expenses || [], payouts: payouts || [], budgets: budgets || [], reconciliations: reconciliations || [], alerts: alerts || [], audit: audit || [] };
    if (req.query.format === "csv") {
      const rows = [
        ...report.contributions.map(row => ({ record_type: "contribution", ...row })),
        ...report.expenses.map(row => ({ record_type: "expense", ...row })),
        ...report.payouts.map(row => ({ record_type: "payout_record", ...row })),
        ...report.reconciliations.map(row => ({ record_type: "reconciliation", ...row })),
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
