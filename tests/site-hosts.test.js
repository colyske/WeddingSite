import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWeddingUrl, classifyHost, isSubdomainSlug, platformOrigins, weddingBaseDomain, weddingOriginSlug
} from "../server/site-hosts.js";
import { paymentReturnUrl } from "../api/checkout.js";
import guestHandler from "../api/guest.js";

const BASE = "joinourwedding.site";
const keys = ["WEDDINGSITE_WEDDING_BASE_DOMAIN", "WEDDINGSITE_PUBLIC_ORIGIN", "WEDDINGSITE_LEGACY_ORIGINS", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  globalThis.fetch = originalFetch;
});

const recorder = () => ({
  headers: {}, statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  end(body) { this.body = body; }
});

test("hosts classify root, www, weddings, reserved labels and foreign hosts", () => {
  assert.deepEqual(classifyHost(BASE, BASE), { kind: "root" });
  assert.deepEqual(classifyHost(`WWW.${BASE}:443`, BASE), { kind: "root" });
  assert.deepEqual(classifyHost(`alice-and-bob.${BASE}`, BASE), { kind: "wedding", slug: "alice-and-bob" });
  assert.deepEqual(classifyHost(`admin.${BASE}`, BASE), { kind: "reserved", slug: "admin" });
  assert.deepEqual(classifyHost(`a.b.${BASE}`, BASE), { kind: "other" });
  assert.deepEqual(classifyHost(`evil${BASE}`, BASE), { kind: "other" });
  assert.deepEqual(classifyHost("weddingsite-six-bice.vercel.app", BASE), { kind: "other" });
  assert.equal(isSubdomainSlug("-bad"), false);
  assert.equal(isSubdomainSlug("x".repeat(64)), false);
  assert.equal(isSubdomainSlug("www"), false);
});

test("canonical wedding URLs use the subdomain and fall back to the legacy route", () => {
  assert.equal(canonicalWeddingUrl("alice-and-bob", { base: BASE, params: { ref: "wa" } }), `https://alice-and-bob.${BASE}/?ref=wa`);
  assert.equal(canonicalWeddingUrl("x".repeat(70), { base: BASE, fallbackOrigin: "https://weddingsite-six-bice.vercel.app" }),
    `https://weddingsite-six-bice.vercel.app/guest.html?slug=${"x".repeat(70)}`);
  assert.equal(weddingBaseDomain({ WEDDINGSITE_WEDDING_BASE_DOMAIN: "not a domain" }), "");
});

test("platform and wedding origins are exact and slug-bound", () => {
  const env = { WEDDINGSITE_PUBLIC_ORIGIN: `https://${BASE}/`, WEDDINGSITE_LEGACY_ORIGINS: "https://weddingsite-six-bice.vercel.app, http://evil.example, junk" };
  assert.deepEqual(platformOrigins(env), [`https://${BASE}`, "https://weddingsite-six-bice.vercel.app"]);
  assert.equal(weddingOriginSlug(`https://alice-and-bob.${BASE}`, BASE), "alice-and-bob");
  assert.equal(weddingOriginSlug(`http://alice-and-bob.${BASE}`, BASE), "");
  assert.equal(weddingOriginSlug(`https://alice-and-bob.${BASE}:8443`, BASE), "");
  assert.equal(weddingOriginSlug(`https://api.${BASE}`, BASE), "");
});

test("payment returns go back to the origin that started checkout", () => {
  process.env.WEDDINGSITE_WEDDING_BASE_DOMAIN = BASE;
  assert.equal(paymentReturnUrl(`https://alice-and-bob.${BASE}`, "alice-and-bob", "paymentReturn", "id1"),
    `https://alice-and-bob.${BASE}/?paymentReturn=id1`);
  assert.equal(paymentReturnUrl("https://weddingsite-six-bice.vercel.app", "alice-and-bob", "paymentCancel", "id2"),
    "https://weddingsite-six-bice.vercel.app/guest.html?slug=alice-and-bob&paymentCancel=id2");
});

test("host page action: root serves the platform, reserved redirects, unknown slug is 404", async () => {
  process.env.WEDDINGSITE_WEDDING_BASE_DOMAIN = BASE;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  globalThis.fetch = async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });

  const root = recorder();
  await guestHandler({ method: "GET", query: { action: "page" }, headers: { host: `www.${BASE}` } }, root);
  assert.equal(root.statusCode, 200);
  assert.match(String(root.body), /<html/i);

  const reserved = recorder();
  await guestHandler({ method: "GET", query: { action: "page" }, headers: { host: `admin.${BASE}` } }, reserved);
  assert.equal(reserved.statusCode, 308);
  assert.equal(reserved.headers.location, `https://${BASE}/`);

  const unknown = recorder();
  await guestHandler({ method: "GET", query: { action: "page" }, headers: { host: `no-such-couple.${BASE}` } }, unknown);
  assert.equal(unknown.statusCode, 404);
  assert.match(String(unknown.body), /joinourwedding\.site/);
});

test("routing middleware rewrites only wedding subdomains of the base domain", async () => {
  const { default: middleware, config } = await import("../middleware.js");
  assert.equal(config.matcher, "/");
  const rewrite = middleware(new Request(`https://alice-and-bob.${BASE}/?ref=wa`));
  assert.equal(rewrite.headers.get("x-middleware-rewrite"), `https://alice-and-bob.${BASE}/api/guest?action=page`);
  assert.equal(middleware(new Request(`https://www.${BASE}/`)), undefined);
  assert.equal(middleware(new Request(`https://${BASE}/`)), undefined);
  assert.equal(middleware(new Request("https://weddingsite-six-bice.vercel.app/")), undefined);
  assert.equal(middleware(new Request(`https://a.b.${BASE}/`)), undefined);
});

test("host page action renders a published wedding with canonical subdomain meta", async () => {
  process.env.WEDDINGSITE_WEDDING_BASE_DOMAIN = BASE;
  process.env.SUPABASE_URL = "https://supabase.example";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "7c1b33e8-6b41-4f66-9169-54197263db7f", slug: "alice-and-bob", couple_names: "Alice & Bob",
    wedding_date: "2027-01-02", public_location: "Nairobi"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const res = recorder();
  await guestHandler({ method: "GET", query: { action: "page" }, headers: { host: `alice-and-bob.${BASE}` } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/alice-and-bob\.joinourwedding\.site\/">/);
  assert.match(res.body, /og:title" content="Alice &amp; Bob are getting married"/);
  assert.match(res.body, /Join Our Wedding/);
});
