import { methodOnly, sendJson } from "../../server/supabase.js";

// POST /api/auth/sign-out
// Invalidates the current session by clearing httpOnly cookies
export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  res.setHeader("Set-Cookie", [
    "sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);

  return sendJson(res, 200, { message: "Signed out." });
}
