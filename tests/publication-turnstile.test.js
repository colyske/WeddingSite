import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicationPayment } from "../server/publication-payments.js";

const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const session = { user: { id: "550e8400-e29b-41d4-a716-446655440002" }, token: "fixture-token" };
const origin = "https://www.joinourwedding.site";
const result = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  setHeader() {},
  end(body) { this.body = JSON.parse(body); }
});

test("publication Turnstile aliases preserve precedence and fail-closed checks", async t => {
  const env = {
    SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", WEDDINGSITE_PAYMENT_MODE: "test",
    WEDDINGSITE_PUBLIC_ORIGIN: origin, WEDDINGSITE_LEGACY_ORIGINS: "",
    STRIPE_SECRET_KEY: "sk_test_publication_turnstile", STRIPE_WEBHOOK_SECRET: "fixture-webhook",
    STRIPE_SUPPORTED_CURRENCIES: "USD", STRIPE_SUPPORTED_MARKETS: "US",
    TURNSTILE_SITE_KEY: "", TURNSTILE_PUBLIC_KEY: "", TURNSTILE_SECRET_KEY: ""
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, env);
  let challengeResult = { success: false, hostname: "www.joinourwedding.site" };
  let challengeStatus = 200, challengeCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === env.SUPABASE_URL) {
      assert.equal(init.method || "GET", url.pathname.endsWith("/publication_quote") ? "POST" : "GET",
        "no database writes or checkout admission");
      if (url.pathname === "/rest/v1/weddings") return Response.json([{ id: weddingId, currency: "USD" }]);
      if (url.pathname === "/rest/v1/publication_checkouts") return Response.json([]);
      if (url.pathname === "/rest/v1/rpc/publication_quote") {
        return Response.json({ fee_minor: 5000, usd_amount_minor: 5000, currency: "USD" });
      }
      if (url.pathname === "/rest/v1/platform_policies") return Response.json([{ enabled_payment_providers: ["stripe"] }]);
    }
    if (url.href === "https://api.stripe.com/v1/account") return Response.json({ id: "fixture-account" });
    if (url.href === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      challengeCalls++;
      assert.equal(init.body.get("secret"), "fixture-secret");
      assert.equal(init.body.get("response"), "fixture-challenge");
      return Response.json(challengeResult, { status: challengeStatus });
    }
    assert.fail(`Unexpected request: ${url.origin}${url.pathname}`);
  };
  const invoke = async (creating = false, captchaToken = "fixture-challenge") => {
    const res = result();
    await handlePublicationPayment({
      method: creating ? "POST" : "GET", headers: { origin }, query: { weddingId },
      body: creating ? {
        weddingId, method: "card", confirmed: true, expectedAmountMinor: 5000,
        expectedUsdAmountMinor: 5000, expectedCurrency: "USD",
        idempotencyKey: weddingId, captchaToken
      } : undefined
    }, res, session, creating ? "publication-create" : "publication-options");
    return res;
  };
  try {
    for (const [name, site, publicKey, secret, expected] of [
      ["PUBLIC_KEY only", "", "fixture-public", "fixture-secret", "fixture-public"],
      ["SITE_KEY only", "fixture-site", "", "fixture-secret", "fixture-site"],
      ["SITE_KEY takes precedence", "fixture-site", "fixture-public", "fixture-secret", "fixture-site"],
      ["both public keys missing", "", "", "fixture-secret", null],
      ["secret missing with PUBLIC_KEY", "", "fixture-public", "", null],
      ["secret missing with SITE_KEY", "fixture-site", "", "", null]
    ]) {
      await t.test(name, async () => {
        Object.assign(process.env, { TURNSTILE_SITE_KEY: site, TURNSTILE_PUBLIC_KEY: publicKey, TURNSTILE_SECRET_KEY: secret });
        const res = await invoke();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.turnstileSiteKey, expected);
        assert.deepEqual(res.body.methods.map(item => item.id), expected ? ["card"] : []);
        assert.equal(challengeCalls, 0, "options never verifies a challenge");
      });
    }
    await t.test("PUBLIC_KEY does not bypass challenge or secret verification on create", async () => {
      Object.assign(process.env, { TURNSTILE_SITE_KEY: "", TURNSTILE_PUBLIC_KEY: "fixture-public" });
      for (const [secret, token, response, status, expectedCalls] of [
        ["", "fixture-challenge", { success: true, hostname: "www.joinourwedding.site" }, 200, 0],
        ["fixture-secret", "", { success: true, hostname: "www.joinourwedding.site" }, 200, 0],
        ["fixture-secret", "fixture-challenge", { success: false, hostname: "www.joinourwedding.site" }, 200, 1],
        ["fixture-secret", "fixture-challenge", { success: true, hostname: "wrong.example" }, 200, 1],
        ["fixture-secret", "fixture-challenge", { success: true, hostname: "www.joinourwedding.site" }, 503, 1]
      ]) {
        process.env.TURNSTILE_SECRET_KEY = secret;
        challengeResult = response;
        challengeStatus = status;
        const before = challengeCalls;
        const res = await invoke(true, token);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, "Complete the anti-abuse verification before checkout.");
        assert.equal(challengeCalls - before, expectedCalls);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
