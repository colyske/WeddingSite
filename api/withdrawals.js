import { authenticatedUser, sendJson, supabaseRequest } from "../server/supabase.js";

export default async function handler(req, res) {
  const action = String(req.query.action || "");
  const weddingId = String(req.query.weddingId || "");

  if (!weddingId.match(/^[0-9a-f-]{36}$/i)) {
    return sendJson(res, 400, { error: "Invalid wedding ID." });
  }

  let session;
  try {
    session = await authenticatedUser(req);
  } catch (error) {
    console.error("withdrawal authentication failed", error.message);
    return sendJson(res, 503, { error: "Authentication service unavailable." });
  }

  if (!session) return sendJson(res, 401, { error: "Sign in to manage withdrawals." });

  try {
    if (action === "balance") {
      // Get current payout balance (net contributions for this wedding)
      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,owner_id,currency`,
        { token: session.token }
      );

      if (!Array.isArray(wedding) || !wedding.length) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      if (wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized to access this wedding." });
      }

      const contributions = await supabaseRequest(
        `/rest/v1/contributions?wedding_id=eq.${encodeURIComponent(weddingId)}&payment_status=eq.paid&select=net_paid_minor`,
        { token: session.token }
      );

      const balance = (contributions || []).reduce((sum, c) => sum + (c.net_paid_minor || 0), 0);

      return sendJson(res, 200, {
        balance_minor: balance,
        currency: wedding[0].currency || "USD"
      });
    }

    if (action === "request") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST required." });

      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const amount = Number(body.amount_minor || 0);
      const notes = String(body.notes || "").slice(0, 200);

      if (!Number.isInteger(amount) || amount < 1) {
        return sendJson(res, 400, { error: "Amount must be at least 1 (minor unit)." });
      }

      // Verify ownership
      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,owner_id,currency,payout_preferences(*)`,
        { token: session.token }
      );

      if (!Array.isArray(wedding) || !wedding.length) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      if (wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized." });
      }

      // Check balance
      const contributions = await supabaseRequest(
        `/rest/v1/contributions?wedding_id=eq.${encodeURIComponent(weddingId)}&payment_status=eq.paid&select=net_paid_minor`,
        { token: session.token }
      );

      const balance = (contributions || []).reduce((sum, c) => sum + (c.net_paid_minor || 0), 0);

      if (amount > balance) {
        return sendJson(res, 400, { error: `Insufficient balance. Available: ${balance} minor units.` });
      }

      // Get payout method from preferences
      const payoutPrefs = wedding[0].payout_preferences?.[0];
      if (!payoutPrefs) {
        return sendJson(res, 400, { error: "Payout method not configured. Set it in your wedding settings first." });
      }

      // Create withdrawal request
      const withdrawal = {
        wedding_id: weddingId,
        amount_minor: amount,
        currency: wedding[0].currency || "USD",
        payout_method: payoutPrefs.method || "unknown",
        status: "pending",
        notes: notes
      };

      const result = await supabaseRequest(
        `/rest/v1/withdrawals`,
        {
          method: "POST",
          token: session.token,
          body: JSON.stringify(withdrawal)
        }
      );

      if (result.code) {
        return sendJson(res, 400, { error: result.message || "Could not create withdrawal request." });
      }

      return sendJson(res, 201, { withdrawal: result[0] || result });
    }

    if (action === "list") {
      // Get all withdrawals for this wedding (owner only)
      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,owner_id`,
        { token: session.token }
      );

      if (!Array.isArray(wedding) || !wedding.length) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      if (wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized." });
      }

      const withdrawals = await supabaseRequest(
        `/rest/v1/withdrawals?wedding_id=eq.${encodeURIComponent(weddingId)}&select=*&order=requested_at.desc`,
        { token: session.token }
      );

      return sendJson(res, 200, { withdrawals: withdrawals || [] });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });
  } catch (error) {
    console.error("withdrawal handler failed", error.message);
    return sendJson(res, 500, { error: "Withdrawal service failed." });
  }
}
