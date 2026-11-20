import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import authHandler from "../api/auth.js";

const environmentKeys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "WEDDINGSITE_PUBLIC_ORIGIN"];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

function configureAuth() {
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_ANON_KEY: "test-public-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite-six-bice.vercel.app"
  });
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function responseRecorder() {
  return {
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; }
  };
}

async function call(action, { method = "GET", body, origin } = {}) {
  const res = responseRecorder();
  await authHandler({
    method,
    query: { action },
    headers: origin ? { origin } : {},
    body
  }, res);
  return { ...res, data: JSON.parse(res.body || "{}") };
}

test("New account registration records default and explicit referrals without replacing invalid codes", async () => {
  configureAuth();
  for (const [returnTo, expected, referral] of [
    ["/dashboard.html?style=showcase-wedding#step=couple", "/dashboard.html?style=showcase-wedding#step=couple",
      { code: "3b79b3fbb32894bf82dbaf21d2765deb", isDefault: true }],
    ["https://untrusted.example/collect", "/dashboard.html",
      { code: "3b79b3fbb32894bf82dbaf21d2765deb", isDefault: true }],
    ["/dashboard.html?client_ref=" + "a".repeat(32), "/dashboard.html?client_ref=" + "a".repeat(32),
      { code: "a".repeat(32), isDefault: false }],
    ["/dashboard.html?client_ref=invalid", "/dashboard.html?client_ref=invalid", null],
    ["/referrals.html", "/referrals.html", null]
  ]) {
    let signup;
    let registeredReferral;
    let validatedCode;
    globalThis.fetch = async (input, init = {}) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname === "/rest/v1/rpc/referral_validate_code") {
        validatedCode = JSON.parse(init.body).p_code;
        return response({ valid: true });
      }
      if (requestUrl.pathname === "/rest/v1/rpc/referral_register_intent") {
        registeredReferral = JSON.parse(init.body);
        assert.equal(init.headers.Authorization, "Bearer test-service-role-key");
        return response("intent-id");
      }
      if (requestUrl.pathname === "/rest/v1/profiles") return response([]);
      if (requestUrl.pathname === "/auth/v1/signup") {
        signup = requestUrl;
        return response({ user: { id: "new-client" } });
      }
      throw new Error("Unexpected request.");
    };
    const result = await call("register", { method: "POST", body: {
      email: "couple@example.test", password: "a secure long password", confirmPassword: "a secure long password", returnTo
    } });
    assert.equal(result.statusCode, 201);
    assert.equal(signup.pathname, "/auth/v1/signup");
    const callback = new URL(signup.searchParams.get("redirect_to"));
    assert.equal(callback.origin, "https://weddingsite-six-bice.vercel.app");
    assert.equal(callback.pathname, "/signin.html");
    assert.equal(callback.searchParams.get("next"), expected);
    assert.deepEqual(registeredReferral, referral ? {
      p_creator: "new-client", p_code: referral.code, p_is_default: referral.isDefault
    } : undefined);
    assert.equal(validatedCode, referral?.code);
  }
});

test("A missing default referral does not block email registration or later sign-in", async () => {
  configureAuth();
  console.error = () => {};
  const requestedActions = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/referral_validate_code") return response({ valid: false });
    if (url.pathname === "/auth/v1/signup") {
      requestedActions.push("signup");
      return response({ user: { id: "new-client" } });
    }
    if (url.pathname === "/rest/v1/profiles") {
      if (init.method === "GET") return response([{ platform_role: "client" }]);
      return response([], 201);
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      requestedActions.push("sign-in");
      return response({
        access_token: "test-access-token", refresh_token: "test-refresh-token",
        user: { id: "new-client", email: "couple@example.test", user_metadata: {} }
      });
    }
    throw new Error("Unexpected request.");
  };

  const registration = await call("register", { method: "POST", body: {
    email: "couple@example.test", password: "a secure long password",
    confirmPassword: "a secure long password"
  } });
  assert.equal(registration.statusCode, 201);
  assert.match(registration.data.referralWarning, /JoinOurWedding referral is currently unavailable/);
  assert.match(registration.data.message, /You can still create or use your account/);
  assert.deepEqual(requestedActions, ["signup"]);

  const signIn = await call("sign-in", { method: "POST", body: {
    email: "couple@example.test", password: "a secure long password"
  } });
  assert.equal(signIn.statusCode, 200);
  assert.equal(signIn.data.user.id, "new-client");
  assert.deepEqual(requestedActions, ["signup", "sign-in"]);
});

test("Referral intent persistence failure after account creation remains recoverable", async () => {
  configureAuth();
  console.error = () => {};
  let accountCreated = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/referral_validate_code") return response({ valid: true });
    if (url.pathname === "/auth/v1/signup") {
      accountCreated = true;
      return response({ user: { id: "new-client" } });
    }
    if (url.pathname === "/rest/v1/rpc/referral_register_intent") {
      assert.equal(accountCreated, true);
      return response({ message: "temporary database failure" }, 503);
    }
    if (url.pathname === "/rest/v1/profiles") {
      if (init.method === "GET") return response([{ platform_role: "client" }]);
      return response([], 201);
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      return response({
        access_token: "test-access-token", refresh_token: "test-refresh-token",
        user: { id: "new-client", email: "couple@example.test", user_metadata: {} }
      });
    }
    throw new Error("Unexpected request.");
  };

  const registration = await call("register", { method: "POST", body: {
    email: "couple@example.test", password: "a secure long password",
    confirmPassword: "a secure long password"
  } });
  assert.equal(registration.statusCode, 201);
  assert.match(registration.data.referralWarning, /JoinOurWedding referral is currently unavailable/i);
  assert.equal(accountCreated, true);

  const signIn = await call("sign-in", { method: "POST", body: {
    email: "couple@example.test", password: "a secure long password"
  } });
  assert.equal(signIn.statusCode, 200);
  assert.equal(signIn.data.user.id, "new-client");
});

test("Google status reveals only whether the Supabase provider is enabled", async () => {
  configureAuth();
  let observedApiKey = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://supabase.example/auth/v1/settings");
    observedApiKey = init.headers.apikey;
    return response({ external: { google: true }, site_url: "https://weddingsite-six-bice.vercel.app" });
  };
  const result = await call("google-status");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data, { enabled: true });
  assert.equal(observedApiKey, "test-public-anon-key");
});

test("Google OAuth start binds PKCE and state to the fixed app callback", async () => {
  configureAuth();
  const state = "s".repeat(43);
  const codeChallenge = "c".repeat(43);
  const result = await call("google-start", {
    method: "POST",
    origin: "https://weddingsite-six-bice.vercel.app",
    body: { state, codeChallenge }
  });
  assert.equal(result.statusCode, 200);
  const authorization = new URL(result.data.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_to"));
  assert.equal(authorization.origin, "https://supabase.example");
  assert.equal(authorization.pathname, "/auth/v1/authorize");
  assert.equal(authorization.searchParams.get("provider"), "google");
  assert.equal(authorization.searchParams.get("code_challenge"), codeChallenge);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "s256");
  assert.equal(callback.origin, "https://weddingsite-six-bice.vercel.app");
  assert.equal(callback.pathname, "/signin.html");
  assert.equal(callback.searchParams.get("oauth_state"), state);

  const wrongOrigin = await call("google-start", {
    method: "POST", origin: "https://attacker.example", body: { state, codeChallenge }
  });
  assert.equal(wrongOrigin.statusCode, 400);
});

test("Google PKCE exchange returns the profile-backed Client role, and rejects bad origins", async () => {
  configureAuth();
  let exchanged;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://supabase.example/auth/v1/token?grant_type=pkce") {
      exchanged = JSON.parse(init.body);
      return response({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        user: {
          id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112", email: "guest@example.test",
          created_at: "2020-01-01T00:00:00.000Z", user_metadata: { full_name: "Test Guest" }
        }
      });
    }
    if (url.startsWith("https://supabase.example/rest/v1/profiles")) {
      return response([{ platform_role: "client" }]);
    }
    throw new Error("Unexpected request.");
  };
  const invalidOrigin = await call("google-exchange", {
    method: "POST", origin: "https://attacker.example",
    body: {
      code: "authorization-code", codeVerifier: "v".repeat(43),
      returnTo: `/dashboard.html?client_ref=${"a".repeat(32)}`
    }
  });
  assert.equal(invalidOrigin.statusCode, 403);
  assert.equal(exchanged, undefined);

  const invalidVerifier = await call("google-exchange", {
    method: "POST", origin: "https://weddingsite-six-bice.vercel.app",
    body: { code: "authorization-code", codeVerifier: "short" }
  });
  assert.equal(invalidVerifier.statusCode, 400);
  assert.equal(exchanged, undefined);

  const result = await call("google-exchange", {
    method: "POST", origin: "https://weddingsite-six-bice.vercel.app",
    body: {
      code: "authorization-code", codeVerifier: "v".repeat(43),
      returnTo: `/dashboard.html?client_ref=${"a".repeat(32)}`
    }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(exchanged, { auth_code: "authorization-code", code_verifier: "v".repeat(43) });
  assert.equal(result.data.role, "client");
  assert.equal(result.data.user.displayName, "Test Guest");
});

test("New Google accounts receive the explicit referral selected by their return destination", async () => {
  configureAuth();
  const referralCode = "b".repeat(32);
  let registeredReferral;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/token") {
      return response({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        user: {
          id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112",
          email: "new@example.test",
          created_at: new Date().toISOString(),
          last_sign_in_at: new Date().toISOString()
        }
      });
    }
    if (url.pathname === "/rest/v1/profiles" && init.method === "GET") return response([{ platform_role: "client" }]);
    if (url.pathname === "/rest/v1/rpc/referral_validate_code") return response({ valid: true });
    if (url.pathname === "/rest/v1/rpc/referral_register_intent") {
      registeredReferral = JSON.parse(init.body);
      return response("intent-id");
    }
    throw new Error("Unexpected request.");
  };
  const result = await call("google-exchange", {
    method: "POST", origin: "https://weddingsite-six-bice.vercel.app",
    body: {
      code: "authorization-code", codeVerifier: "v".repeat(43), registration: true,
      returnTo: `/dashboard.html?client_ref=${referralCode}`
    }
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.data));
  assert.deepEqual(registeredReferral, {
    p_creator: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112",
    p_code: referralCode,
    p_is_default: false
  });
});

test("A missing default referral does not block a new Google account from signing in", async () => {
  configureAuth();
  console.error = () => {};
  const now = new Date().toISOString();
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/token") {
      return response({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        user: {
          id: "new-google-client", email: "new@example.test",
          created_at: now, last_sign_in_at: now
        }
      });
    }
    if (url.pathname === "/rest/v1/profiles") return response([{ platform_role: "client" }]);
    if (url.pathname === "/rest/v1/rpc/referral_validate_code") return response({ valid: false });
    throw new Error("Unexpected request.");
  };

  const result = await call("google-exchange", {
    method: "POST", origin: "https://weddingsite-six-bice.vercel.app",
    body: { code: "authorization-code", codeVerifier: "v".repeat(43), registration: true }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.user.id, "new-google-client");
  assert.match(result.data.referralWarning, /JoinOurWedding referral is currently unavailable/);
});

test("Existing Google accounts are not attributed by a registration return destination", async () => {
  configureAuth();
  let registeredReferral;
  const now = Date.now();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/token") {
      return response({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        user: {
          id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112",
          email: "existing@example.test",
          created_at: new Date(now - 2 * 60 * 1000).toISOString(),
          last_sign_in_at: new Date(now).toISOString()
        }
      });
    }
    if (url.pathname === "/rest/v1/profiles") return response([{ platform_role: "client" }]);
    if (url.pathname === "/rest/v1/rpc/referral_validate_code") return response({ valid: true });
    if (url.pathname === "/rest/v1/rpc/referral_register_intent") {
      registeredReferral = JSON.parse(init.body);
      return response("intent-id");
    }
    throw new Error("Unexpected request.");
  };
  const result = await call("google-exchange", {
    method: "POST", origin: "https://weddingsite-six-bice.vercel.app",
    body: {
      code: "authorization-code", codeVerifier: "v".repeat(43), registration: true,
      returnTo: `/dashboard.html?client_ref=${"b".repeat(32)}`
    }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(registeredReferral, undefined);
});
