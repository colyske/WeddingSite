// /api/auth?action=sign-in|sign-out|me, /api/auth/callback
import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isCallback = url.pathname === "/api/auth/callback";
  const action = url.searchParams.get("action");

  if (isCallback) {
    // GET /api/auth/callback - Supabase Auth callback
    const code = url.searchParams.get("code");
    const type = url.searchParams.get("type");
    const error = url.searchParams.get("error");

    if (error) {
      return res.redirect(302, `/?auth_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect(302, "/signin.html?error=missing_code");
    }

    try {
      const tokenRes = await fetch(
        `${process.env.SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1/verify`,
        {
          method: "POST",
          headers: { "apikey": process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ type: type || "recovery", token: code })
        }
      );

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return res.redirect(302, "/signin.html?error=auth_failed");
      }

      // Set httpOnly cookie with token
      res.setHeader("Set-Cookie", [
        `access-token=${tokenData.access_token}; HttpOnly; Secure; SameSite=Lax; Max-Age=3600; Path=/`,
        `refresh-token=${tokenData.refresh_token || ""}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`
      ]);

      // Redirect to dashboard or RSVP based on user's role
      const defaultRedirect = tokenData.user?.email?.includes("@") ? "/platform.html" : "/index.html";
      return res.redirect(302, defaultRedirect);
    } catch (error) {
      console.error("callback error", error.message);
      return res.redirect(302, "/signin.html?error=server_error");
    }
  }

  // POST /api/auth?action=sign-in
  if (action === "sign-in" && req.method === "POST") {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { email, password } = body;

    if (!email || !password) {
      return sendJson(res, 400, { error: "Email and password are required." });
    }

    try {
      const tokenRes = await fetch(
        `${process.env.SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: { "apikey": process.env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        }
      );

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return sendJson(res, 401, { error: tokenData.error_description || "Invalid credentials." });
      }

      // Fetch user profile and role
      let profile = null;
      try {
        const profiles = await supabaseRequest(
          `/rest/v1/profiles?id=eq.${encodeURIComponent(tokenData.user.id)}&select=id,platform_role`,
          { token: tokenData.access_token }
        );
        profile = profiles?.[0];
      } catch {}

      return sendJson(res, 200, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        user: { id: tokenData.user.id, email: tokenData.user.email },
        profile: { role: profile?.platform_role || "guest" }
      });
    } catch (error) {
      console.error("sign-in error", error.message);
      return sendJson(res, 500, { error: "Sign-in failed." });
    }
  }

  // POST /api/auth?action=sign-out
  if (action === "sign-out" && req.method === "POST") {
    res.setHeader("Set-Cookie", [
      "access-token=; HttpOnly; Max-Age=0; Path=/",
      "refresh-token=; HttpOnly; Max-Age=0; Path=/"
    ]);
    return sendJson(res, 200, { signedOut: true });
  }

  // GET /api/auth?action=me
  if (action === "me" && req.method === "GET") {
    const session = await requireAuth(req, res);
    if (!session) return;

    try {
      const profiles = await supabaseRequest(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(session.user.id)}&select=id,platform_role`,
        { token: session.token }
      );
      const profile = profiles?.[0];

      return sendJson(res, 200, {
        user: { id: session.user.id, email: session.user.email },
        profile: { role: profile?.platform_role || "guest" }
      });
    } catch (error) {
      console.error("me error", error.message);
      return sendJson(res, 500, { error: "Could not fetch profile." });
    }
  }

  return sendJson(res, 404, { error: "Auth endpoint not found." });
}
