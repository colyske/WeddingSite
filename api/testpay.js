import { methodOnly, sendJson } from "../server/supabase.js";

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  if (!["purchase", "publication"].includes(action)) return sendJson(res, 404, { error: "Unknown action." });
  if (!methodOnly(req, res, "POST")) return;
  return sendJson(res, 410, {
    error: "Simulated payments are disabled. Use the configured test payment provider; no paid action was recorded."
  });
}
