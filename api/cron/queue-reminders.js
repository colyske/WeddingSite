import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) return sendJson(res, 503, { error: "Reminder automation is not configured." });
  if (req.headers.authorization !== `Bearer ${secret}`) return sendJson(res, 401, { error: "Unauthorized." });
  try {
    const result = await supabaseRequest("/rest/v1/rpc/queue_due_reminders", { service: true, method: "POST", body: {} });
    return sendJson(res, 200, {
      queued: Number(result) || 0,
      sent: 0,
      message: "Due reminders were queued idempotently; no email or message was sent."
    });
  } catch (error) {
    console.error("reminder queue run failed", error.message);
    return sendJson(res, error.status || 503, { error: "Reminder queue run failed." });
  }
}
