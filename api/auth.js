import { methodOnly, sendJson, supabaseConfig, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";
import { platformOrigins } from "../server/site-hosts.js";
import { contentError } from "../server/content-policy.js";

const GENERIC_LINK_MESSAGE = "If that email belongs to a Join Our Wedding account, a sign-in link is on its way.";
const isEmail = value => typeof value === "string" && value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const SAFE_RETURN_PATHS = new Set(["/dashboard.html", "/wedding.html", "/account.html", "/admin.html", "/owner.html", "/team.html", "/team-invite.html", "/verify.html", "/referrals.html", "/b2c-recipient.html"]);
const REFERRAL_CODE = /^[a-f0-9]{32}$/;
const DEFAULT_REFERRAL_CODE = "3b79b3fbb32894bf82dbaf21d2765deb";
const DEFAULT_REFERRAL_WARNING = "The JoinOurWedding referral is currently unavailable. You can still create or use your account; contact support if you expected referral attribution.";
const REFERRAL_VALIDATION_WARNING = "The referral link could not be verified. You can still create or use your account; contact support if you expected referral attribution.";
const REFERRAL_SAVE_WARNING = "Your account was created, but referral attribution could not be saved. You can still sign in; contact support if you expected referral attribution.";

function siteOrigin(req) {
  const configured = process.env.WEDDINGSITE_PUBLIC_ORIGIN;
  if (configured && /^https:\/\//.test(configured)) return configured.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}`;
}

function safeReturnPath(value, req) {
  try {
    const origin = siteOrigin(req);
    const destination = new URL(value || "/dashboard.html", origin);
    if (destination.origin !== origin || !SAFE_RETURN_PATHS.has(destination.pathname)) return "/dashboard.html";
    return destination.pathname + destination.search + destination.hash;
  } catch {
    return "/dashboard.html";
  }
}

async function registrationReferral(returnTo, req) {
  const destination = new URL(safeReturnPath(returnTo, req), siteOrigin(req));
  if (destination.pathname !== "/dashboard.html") return { referral: null, warning: null };
  const hasExplicitCode = destination.searchParams.has("client_ref");
  const explicitCode = destination.searchParams.get("client_ref");
  if (hasExplicitCode && !REFERRAL_CODE.test(explicitCode || "")) return { referral: null, warning: null };
  const code = hasExplicitCode ? explicitCode : DEFAULT_REFERRAL_CODE;
  let validation;
  try {
    validation = await supabaseRequest("/rest/v1/rpc/referral_validate_code", {
      method: "POST", body: { p_code: code }
    });
  } catch (error) {
    console.error(hasExplicitCode
      ? "Registration referral validation failed; continuing without attribution:"
      : "JoinOurWedding default referral validation failed; continuing without attribution:", error.message);
    return {
      referral: null,
      warning: hasExplicitCode ? REFERRAL_VALIDATION_WARNING : DEFAULT_REFERRAL_WARNING
    };
  }
  if (!validation?.valid) {
    if (hasExplicitCode) return { referral: null, warning: null };
    console.error("JoinOurWedding default referral is missing or withdrawn; continuing without attribution.");
    return { referral: null, warning: DEFAULT_REFERRAL_WARNING };
  }
  return { referral: { code, isDefault: !hasExplicitCode }, warning: null };
}

async function saveRegistrationReferral(userId, referral) {
  if (!referral) return null;
  try {
    await supabaseRequest("/rest/v1/rpc/referral_register_intent", {
      service: true,
      method: "POST",
      body: { p_creator: userId, p_code: referral.code, p_is_default: referral.isDefault }
    });
    return null;
  } catch (error) {
    console.error(referral.isDefault
      ? "JoinOurWedding default referral intent could not be saved; account access will continue:"
      : "New account referral intent could not be saved; account access will continue:", error.message);
    return referral.isDefault ? DEFAULT_REFERRAL_WARNING : REFERRAL_SAVE_WARNING;
  }
}

function isNewGoogleAccount(user) {
  const createdAt = Date.parse(user?.created_at || "");
  const lastSignInAt = Date.parse(user?.last_sign_in_at || "");
  const age = Date.now() - createdAt;
  const signInAge = lastSignInAt - createdAt;
  return Number.isFinite(createdAt) && Number.isFinite(lastSignInAt) &&
    age >= 0 && age <= 10 * 60 * 1000 &&
    signInAge >= 0 && signInAge <= 60 * 1000 &&
    Date.now() - lastSignInAt >= 0;
}

function validOAuthOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
  } catch {
    return false;
  }
}

function requestOAuthOrigin(req) {
  const origin = String(req.headers.origin || "");
  const configured = process.env.WEDDINGSITE_PUBLIC_ORIGIN?.replace(/\/+$/, "");
  if (!validOAuthOrigin(origin) || (configured && origin !== configured && !platformOrigins().includes(origin))) return null;
  return origin;
}

async function authCall(path, { method = "POST", body, token } = {}) {
  const { url, apiKey } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1${path}`, {
    method,
    headers: { apikey: apiKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

async function googleStatus(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  try {
    const { url, apiKey } = supabaseConfig();
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    const settings = await response.json().catch(() => null);
    if (!response.ok || !settings) return sendJson(res, 503, { enabled: false, error: "Google sign-in availability could not be checked." });
    return sendJson(res, 200, { enabled: settings.external?.google === true });
  } catch (error) {
    console.error("Google provider status check failed", error.message);
    return sendJson(res, 503, { enabled: false, error: "Google sign-in availability could not be checked." });
  }
}

async function startGoogleOAuth(req, res, body) {
  if (!methodOnly(req, res, "POST")) return;
  const origin = requestOAuthOrigin(req);
  const state = String(body.state || "");
  const codeChallenge = String(body.codeChallenge || "");
  if (!origin || !/^[A-Za-z0-9_-]{43,128}$/.test(state) ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return sendJson(res, 400, { error: "Google sign-in could not be started securely. Reload and try again." });
  }
  try {
    const { url, apiKey } = supabaseConfig();
    const authorization = new URL(`${url.replace(/\/+$/, "")}/auth/v1/authorize`);
    authorization.searchParams.set("provider", "google");
    authorization.searchParams.set("redirect_to", `${origin}/signin.html?oauth_state=${encodeURIComponent(state)}`);
    authorization.searchParams.set("code_challenge", codeChallenge);
    authorization.searchParams.set("code_challenge_method", "s256");
    authorization.searchParams.set("apikey", apiKey);
    return sendJson(res, 200, { authorizationUrl: authorization.toString() });
  } catch (error) {
    console.error("Google OAuth start failed", error.message);
    return sendJson(res, 503, { error: "Google sign-in is unavailable. Use email sign-in or try again later." });
  }
}

async function exchangeGoogleCode(req, res, body) {
  if (!methodOnly(req, res, "POST")) return;
  if (!requestOAuthOrigin(req)) return sendJson(res, 403, { error: "Google sign-in callback origin is invalid." });
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
  if (!code || code.length > 2048 || /[\u0000-\u0020]/.test(code) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    return sendJson(res, 400, { error: "Google sign-in could not be verified. Start again." });
  }
  try {
    const result = await authCall("/token?grant_type=pkce", {
      body: { auth_code: code, code_verifier: codeVerifier }
    });
    if (!result.ok || !result.data?.access_token || !result.data?.refresh_token || !result.data?.user?.id) {
      return sendJson(res, 401, { error: "Google sign-in could not be completed. Start again or use email sign-in." });
    }
    const { access_token: accessToken, refresh_token: refreshToken, user } = result.data;
    const role = await roleFor(user.id, accessToken);
    if (!role) return sendJson(res, 503, { error: "Your Join Our Wedding profile is not ready yet. Try again or contact support." });
    let referralWarning = null;
    const hasExplicitReferral = new URL(safeReturnPath(body.returnTo, req), siteOrigin(req))
      .searchParams.has("client_ref");
    if (isNewGoogleAccount(user) && (body.registration === true || hasExplicitReferral)) {
      const selected = await registrationReferral(body.returnTo, req);
      referralWarning = selected.warning || await saveRegistrationReferral(user.id, selected.referral);
    }
    const userData = user.user_metadata || {};
    return sendJson(res, 200, {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: userData.display_name || userData.full_name || ""
      },
      role,
      ...(referralWarning ? { referralWarning } : {})
    });
  } catch (error) {
    console.error("Google OAuth code exchange failed", error.message);
    return sendJson(res, 503, { error: "Google sign-in could not be completed. Start again or use email sign-in." });
  }
}

async function roleFor(userId, token) {
  try {
    const rows = await supabaseRequest(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=platform_role`, { token });
    return rows?.[0]?.platform_role || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const invalidContent = contentError(body);
  if (req.method === "POST" && invalidContent) return sendJson(res, 400, { error: invalidContent });

  try {
    if (action === "google-status") return await googleStatus(req, res);
    if (action === "google-start") return await startGoogleOAuth(req, res, body);
    if (action === "google-exchange") return await exchangeGoogleCode(req, res, body);
    if (action === "sign-in") {
      if (!methodOnly(req, res, "POST")) return;
      if (!isEmail(body.email) || typeof body.password !== "string" || !body.password) {
        return sendJson(res, 400, { error: "Enter your email and password." });
      }
      const result = await authCall("/token?grant_type=password", { body: { email: body.email.trim().toLowerCase(), password: body.password } });
      if (!result.ok || !result.data?.access_token) return sendJson(res, 401, { error: "Email or password is incorrect." });
      const { access_token: accessToken, refresh_token: refreshToken, user } = result.data;
      const userData = user.user_metadata || {};
      return sendJson(res, 200, {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: userData.display_name || userData.full_name || ""
        },
        role: await roleFor(user.id, accessToken)
      });
    }

    if (action === "email-link") {
      if (!methodOnly(req, res, "POST")) return;
      if (!isEmail(body.email)) return sendJson(res, 400, { error: "Enter a valid email address." });
      const email = body.email.trim().toLowerCase();
      const redirectTo = `${siteOrigin(req)}/signin.html?next=${encodeURIComponent(safeReturnPath(body.returnTo, req))}`;
      if (body.mode === "recovery") {
        await authCall(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email } });
      } else {
        await authCall(`/otp?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email, create_user: false } });
      }
      return sendJson(res, 200, { message: GENERIC_LINK_MESSAGE });
    }

    if (action === "refresh") {
      if (!methodOnly(req, res, "POST")) return;
      if (typeof body.refreshToken !== "string" || !body.refreshToken) return sendJson(res, 400, { error: "refreshToken is required." });
      const result = await authCall("/token?grant_type=refresh_token", { body: { refresh_token: body.refreshToken } });
      if (!result.ok || !result.data?.access_token) return sendJson(res, 401, { error: "Session expired. Sign in again." });
      return sendJson(res, 200, { accessToken: result.data.access_token, refreshToken: result.data.refresh_token });
    }

    if (action === "set-password") {
      if (!methodOnly(req, res, "POST")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
        return sendJson(res, 400, { error: "Use a password of 12 to 128 characters." });
      }
      const result = await authCall("/user", { method: "PUT", token: session.token, body: { password: body.password } });
      if (!result.ok) return sendJson(res, 400, { error: result.data?.msg || result.data?.message || "Could not set the password. Request a new link and try again." });
      return sendJson(res, 200, { passwordSet: true });
    }

    if (action === "update-profile") {
      if (!methodOnly(req, res, "POST")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (!displayName || displayName.length > 100) {
        return sendJson(res, 400, { error: "Enter a display name of 1 to 100 characters." });
      }
      const result = await authCall("/user", {
        method: "PUT",
        token: session.token,
        body: { data: { display_name: displayName } }
      });
      if (!result.ok) return sendJson(res, 400, { error: "Could not update profile. Please try again." });
      return sendJson(res, 200, { displayName });
    }

    if (action === "register") {
      if (!methodOnly(req, res, "POST")) return;
      if (!isEmail(body.email)) return sendJson(res, 400, { error: "Enter a valid email address." });
      if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
        return sendJson(res, 400, { error: "Use a password of 12 to 128 characters." });
      }
      if (body.password !== body.confirmPassword) {
        return sendJson(res, 400, { error: "Passwords do not match." });
      }
      const email = body.email.trim().toLowerCase();
      const returnTo = safeReturnPath(body.returnTo, req);
      const selectedReferral = await registrationReferral(returnTo, req);
      const redirectTo = `${siteOrigin(req)}/signin.html?next=${encodeURIComponent(returnTo)}`;
      const result = await authCall(`/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
        body: { email, password: body.password, data: { registration_ip: req.ip || req.headers["x-forwarded-for"] || "unknown" } }
      });
      if (!result.ok) {
        if (result.data?.msg?.includes("already registered")) {
          return sendJson(res, 409, { error: "That email is already registered. Try signing in or use forgot password." });
        }
        return sendJson(res, 400, { error: result.data?.msg || "Could not create account. Please try again." });
      }
      // Account created. Supabase auth trigger will auto-create profile via handle_new_user() trigger.
      // If trigger fails or is not set up, create profile now using service role key.
      try {
        const userId = result.data?.user?.id;
        if (userId && process.env.SUPABASE_SERVICE_ROLE_KEY) {
          const { url } = supabaseConfig();
          await fetch(`${url}/rest/v1/profiles`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify({ id: userId, platform_role: "Client" })
          }).catch(err => console.warn("Could not create profile (will retry on sign-in):", err.message));
        }
      } catch (e) {
        console.warn("Profile creation error (non-fatal):", e.message);
      }
      const referralWarning = selectedReferral.warning ||
        await saveRegistrationReferral(result.data?.user?.id, selectedReferral.referral);
      const message = "Account created. Check your email to verify your address and sign in.";
      return sendJson(res, 201, {
        message: referralWarning ? `${message} ${referralWarning}` : message,
        ...(referralWarning ? { referralWarning } : {})
      });
    }

    if (action === "me") {
      if (!methodOnly(req, res, "GET")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      const userData = session.user.user_metadata || {};
      return sendJson(res, 200, {
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: userData.display_name || userData.full_name || ""
        },
        role: await roleFor(session.user.id, session.token)
      });
    }

    return sendJson(res, 404, { error: "Unknown auth action." });
  } catch (error) {
    console.error("auth endpoint failed", error.message);
    return sendJson(res, 503, { error: "Authentication is temporarily unavailable." });
  }
}
