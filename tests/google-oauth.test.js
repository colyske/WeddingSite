import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import authHandler from "../api/auth.js";

const environmentKeys = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "WEDDINGSITE_PUBLIC_ORIGIN"];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  globalThis.fetch = originalFetch;
});

function configureAuth() {
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_ANON_KEY: "test-public-anon-key",
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
        user: { id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112", email: "guest@example.test", user_metadata: { full_name: "Test Guest" } }
      });
    }
    if (url.startsWith("https://supabase.example/rest/v1/profiles")) {
      return response([{ platform_role: "client" }]);
    }
    throw new Error("Unexpected request.");
  };
  const invalidOrigin = await call("google-exchange", {
    method: "POST", origin: "https://attacker.example",
    body: { code: "authorization-code", codeVerifier: "v".repeat(43) }
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
    body: { code: "authorization-code", codeVerifier: "v".repeat(43) }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(exchanged, { auth_code: "authorization-code", code_verifier: "v".repeat(43) });
  assert.equal(result.data.role, "client");
  assert.equal(result.data.user.displayName, "Test Guest");
});
