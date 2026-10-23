import { authenticatedUser, sendJson } from "../../server/supabase.js";

// Handle Supabase Auth callback after user confirms email or completes sign-in flow
export default async function handler(req, res) {
  const code = req.url.split("?")[1]?.split("&").find(p => p.startsWith("code="))?.split("=")[1];
  if (!code) {
    return res.status(400).setHeader("Content-Type", "text/html; charset=utf-8")
      .end(`<html><body><p>Auth callback error: no code received. <a href="/">Return to home</a>.</p></body></html>`);
  }

  // Exchange the code for a session at the Supabase Auth endpoint
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !apiKey) {
    return res.status(503).setHeader("Content-Type", "text/html; charset=utf-8")
      .end(`<html><body><p>Auth service is not configured. Try again later.</p></body></html>`);
  }

  try {
    const response = await fetch(`${url}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "recovery", token: code }),
      cache: "no-store"
    });

    let userData = null;
    if (response.ok) {
      const authResult = await response.json();
      userData = authResult?.user;
    }

    // Even if token exchange fails, attempt to read current session from cookies
    // Supabase Auth sets auth cookies after sign-up or password recovery
    if (!userData) {
      const session = await authenticatedUser(req);
      if (session) userData = session.user;
    }

    if (!userData) {
      return res.status(401).setHeader("Content-Type", "text/html; charset=utf-8")
        .end(`<html><body><p>Auth failed: session could not be established. <a href="/">Try signing in again</a>.</p></body></html>`);
    }

    // Successful auth: store session in httpOnly cookie and redirect to platform
    const accessToken = req.headers.cookie?.split("sb-access-token=")[1]?.split(";")[0] ||
                        req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const refreshToken = req.headers.cookie?.split("sb-refresh-token=")[1]?.split(";")[0];

    if (accessToken) {
      // Set secure httpOnly cookie to avoid XSS exposure of tokens
      res.setHeader("Set-Cookie", [
        `sb-access-token=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
        `sb-refresh-token=${refreshToken || ""}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      ]);
    }

    // Redirect to platform dashboard or RSVP page depending on profile role
    const redirectUrl = userData.email === "colyske@gmail.com" ? "/dashboard.html" : "/rsvp.html";
    return res.status(302).setHeader("Location", redirectUrl).end();
  } catch (error) {
    console.error("auth callback failed", error.message);
    return res.status(503).setHeader("Content-Type", "text/html; charset=utf-8")
      .end(`<html><body><p>Auth service error. <a href="/">Return home</a>.</p></body></html>`);
  }
}
