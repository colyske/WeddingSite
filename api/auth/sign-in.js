import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

// POST /api/auth/sign-in
// Request { email, password }
// Response { accessToken, user, profile }
export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { email, password } = body;

  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    return sendJson(res, 400, { error: "Email and password are required." });
  }

  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !apiKey) {
    return sendJson(res, 503, { error: "Auth service not configured." });
  }

  try {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
      cache: "no-store"
    });

    if (!response.ok) {
      const error = await response.json();
      return sendJson(res, 401, { error: error.error_description || "Sign-in failed." });
    }

    const result = await response.json();
    const accessToken = result.access_token;
    const user = result.user;

    // Fetch the user's profile and role
    let profile = null;
    try {
      const profiles = await supabaseRequest(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,display_name,platform_role`,
        { token: accessToken }
      );
      profile = profiles?.[0];
    } catch (profileError) {
      console.warn("profile lookup failed during sign-in", profileError.message);
    }

    return sendJson(res, 200, {
      accessToken,
      user: { id: user.id, email: user.email },
      profile
    });
  } catch (error) {
    console.error("sign-in failed", error.message);
    return sendJson(res, 503, { error: "Authentication service unavailable." });
  }
}
