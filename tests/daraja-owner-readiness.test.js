import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import admin from "../api/admin.js";

const keys = [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "WEDDINGSITE_PAYMENT_MODE",
  "WEDDINGSITE_PUBLIC_ORIGIN", "DARAJA_ENVIRONMENT", "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET",
  "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_LIVE_COLLECTION_ENABLED", "DARAJA_LIVE_SHORTCODE_CONFIRMED"
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
});

const json = data => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const res = () => ({ status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.data = JSON.parse(body); }, json(body) { this.data = body; return this; } });
const SECRETS = ["secret-key-value", "secret-consumer-secret", "secret-passkey-value", "123456"];

function setup({ role = "owner", kill = "false", confirmed = "123456" } = {}) {
  Object.assign(process.env, {
    SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service",
    WEDDINGSITE_PAYMENT_MODE: "live", WEDDINGSITE_PUBLIC_ORIGIN: "https://www.joinourwedding.site",
    DARAJA_ENVIRONMENT: "production", DARAJA_CONSUMER_KEY: `secret-key-value-${Math.random()}`,
    DARAJA_CONSUMER_SECRET: "secret-consumer-secret", DARAJA_SHORTCODE: "123456", DARAJA_PASSKEY: "secret-passkey-value",
    DARAJA_LIVE_COLLECTION_ENABLED: kill, DARAJA_LIVE_SHORTCODE_CONFIRMED: confirmed
  });
  const state = { role, approval: { approved: false, shortcode: null }, providerPaths: [], rpcs: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === "api.safaricom.co.ke") {
      state.providerPaths.push(url.pathname);
      assert.ok(url.pathname.startsWith("/oauth/"), "only OAuth is allowed");
      return json({ access_token: "tok", expires_in: "3599" });
    }
    assert.equal(url.host, "db.example");
    if (url.pathname === "/auth/v1/user") return json({ id: "u1" });
    if (url.pathname === "/rest/v1/profiles") return json([{ platform_role: state.role }]);
    if (url.pathname === "/rest/v1/daraja_live_approval") return json([state.approval]);
    if (url.pathname === "/rest/v1/rpc/owner_get_daraja_live_approval") return json(state.approval);
    if (url.pathname === "/rest/v1/rpc/owner_set_daraja_live_approval") {
      const body = JSON.parse(init.body);
      state.rpcs.push(body);
      state.approval = { approved: body.p_approved, shortcode: body.p_shortcode };
      return json(true);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  return state;
}

const call = async (method, action, body, query = {}) => {
  const out = res();
  await admin({ method, query: { action, ...query }, headers: { authorization: "Bearer t" }, body }, out);
  return out;
};

test("only the protected Owner can read readiness or change Daraja approval", async () => {
  const state = setup();
  for (state.role of ["superadmin", "admin", "client"]) {
    assert.equal((await call("GET", "daraja-readiness")).statusCode, 403);
    assert.equal((await call("POST", "daraja-approval", { approved: true, confirmed: true })).statusCode, 403);
    assert.equal((await call("POST", "daraja-approval", { approved: false })).statusCode, 403);
  }
  assert.equal(state.rpcs.length, 0);
});

test("readiness reports safe booleans and the callback address, with an OAuth-only health probe that works with the kill switch off", async () => {
  const state = setup();
  const result = await call("GET", "daraja-readiness", undefined, { health: "1" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.callback.url, "https://www.joinourwedding.site/api/webhooks?provider=daraja");
  assert.equal(result.data.configuredEnvironment, "production");
  assert.equal(result.data.killSwitchOn, false);
  assert.equal(result.data.ownerApproved, false);
  assert.equal(result.data.shortcodeFormatValid, true);
  assert.equal(result.data.shortcodeConfirmationMatches, true);
  assert.deepEqual(result.data.health, { checked: true, healthy: true });
  assert.deepEqual(state.providerPaths, ["/oauth/v1/generate"]);
  const serialized = JSON.stringify(result.data);
  for (const secret of SECRETS) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
});

test("readiness makes no provider call without health=1 or when credentials are not configured for production", async () => {
  const state = setup();
  await call("GET", "daraja-readiness");
  assert.equal(state.providerPaths.length, 0);
  process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED = "999999";
  const result = await call("GET", "daraja-readiness", undefined, { health: "1" });
  assert.equal(result.data.shortcodeConfirmationMatches, false);
  assert.equal(result.data.health.checked, false);
  assert.equal(state.providerPaths.length, 0);
});

test("approval requires confirmation and a confirmed configured shortcode (bound server-side); revoke needs neither", async () => {
  const state = setup();
  assert.equal((await call("POST", "daraja-approval", { approved: true })).statusCode, 400);
  process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED = "999999";
  assert.equal((await call("POST", "daraja-approval", { approved: true, confirmed: true })).statusCode, 400);
  process.env.DARAJA_LIVE_SHORTCODE_CONFIRMED = "123456";
  assert.equal((await call("POST", "daraja-approval", { approved: "yes" })).statusCode, 400);
  assert.equal(state.rpcs.length, 0);
  const approved = await call("POST", "daraja-approval", { approved: true, confirmed: true });
  assert.equal(approved.statusCode, 200);
  assert.deepEqual(state.rpcs[0], { p_approved: true, p_shortcode: "123456" });
  assert.equal(approved.data.daraja.ownerApproved, true);
  assert.equal(approved.data.daraja.killSwitchOn, false);
  assert.equal(approved.data.daraja.newLiveCollection, "held");
  assert.ok(!JSON.stringify(approved.data).includes("123456"));
  const revoked = await call("POST", "daraja-approval", { approved: false });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(state.rpcs[1], { p_approved: false, p_shortcode: null });
  assert.equal(revoked.data.daraja.ownerApproved, false);
  assert.equal(state.providerPaths.length, 1, "only the approval's OAuth readiness probe; revoke makes no provider call");
});

test("approval is refused when the OAuth readiness probe fails; revoke still works without provider health", async () => {
  const state = setup();
  const base = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).host === "api.safaricom.co.ke") return json({ error: "bad" }, 401);
    return base(input, init);
  };
  const refused = await call("POST", "daraja-approval", { approved: true, confirmed: true });
  assert.equal(refused.statusCode, 409);
  assert.equal(state.rpcs.length, 0);
  assert.equal((await call("POST", "daraja-approval", { approved: false })).statusCode, 200);
  assert.deepEqual(state.rpcs, [{ p_approved: false, p_shortcode: null }]);
});

test("public options while live is configured but held name the kill switch, not payment mode, and fetch nothing", async () => {
  setup();
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no fetch expected"); };
  const out = res();
  const checkout = (await import("../api/checkout.js")).default;
  await checkout({ method: "GET", query: { action: "options", weddingId: "7c1b33e8-6b41-4f66-9169-54197263db7f", currency: "KES" } }, out);
  assert.equal(out.data.paymentAvailable, false);
  assert.ok(out.data.unmetChecks.includes("DARAJA_LIVE_COLLECTION_ENABLED=true"));
  assert.ok(!out.data.unmetChecks.includes("WEDDINGSITE_PAYMENT_MODE=test"));
  assert.match(out.data.message, /held/);
  assert.equal(fetched, 0);
});

test("Owner UI has a real-charge warning, no shortcode input, confirmations and an accessible revoke control", async () => {
  const source = await readFile(new URL("../backoffice.js", import.meta.url), "utf8");
  assert.match(source, /\$\{owner \? `<section id="daraja-owner"/);
  assert.doesNotMatch(source, /daraja-shortcode|Callback URL to register/);
  assert.match(source, /REAL money/);
  assert.match(source, /id="daraja-revoke">Revoke approval/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /post\("daraja-approval", \{ approved: true, confirmed: true \}\)/);
  assert.doesNotMatch(source, /console\.(log|info|debug)\([^)]*shortcode/);
});
