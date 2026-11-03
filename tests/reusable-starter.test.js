import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import weddings from "../api/weddings.js";
import { publicWeddingStyle } from "../server/wedding-style.js";
import { showcase } from "../server/showcase.js";

test("retired inspiration routes go to the actual published-wedding browse surface, with no discovery links", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.redirects.find(rule => rule.source === "/inspiration.html"),
    { source: "/inspiration.html", destination: "/#weddings", permanent: true });
  const legacy = await readFile(new URL("../inspiration.html", import.meta.url), "utf8");
  assert.match(legacy, /location\.replace\("\/#weddings"\)/);
  assert.doesNotMatch(legacy, /inspiration-gallery|inspiration\.js|inspiration\.css/);
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(home, /id="weddings"/);
  for (const name of ["index.html", "dashboard.html", "guest.html", "footer.js"]) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /href=["'][^"']*inspiration\.html/);
  }
});

test("showcase reusable default includes its full activity sequence without demonstration identities or locations", async () => {
  const before = JSON.stringify(showcase);
  const style = await publicWeddingStyle("showcase-wedding");
  assert.deepEqual(style.palette, showcase.palette);
  assert.equal(style.venues.length, showcase.venues.length);
  assert.deepEqual(style.venues.map(v => v.kind), showcase.venues.map(v => v.kind));
  assert.deepEqual(style.venues.map(v => v.isMain), showcase.venues.map(v => v.is_main));
  assert.match(style.venues[0].name, /Family introductions/);
  assert.match(style.venues[1].name, /fundraiser/);
  assert.match(style.venues[2].name, /planning gathering/);
  assert.ok(style.venues.every(v => !v.eventDate && !v.time && !v.address && !v.map));
  assert.doesNotMatch(JSON.stringify(style), /Amara|Kito|2099|Diani|Ukunda|Azure|seats_sold|raised_minor/);
  assert.equal(JSON.stringify(showcase), before, "virtual source remains untouched");
  assert.ok(style.setup.tiers.length && style.setup.registry.length && style.setup.campaigns[0].milestones.length);
});

test("deferred API separates source monetary currency from destination and strictly saves amount-free owner structures", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const oldFetch = globalThis.fetch, calls = [];
  const owner = "550e8400-e29b-41d4-a716-446655440000", key = "550e8400-e29b-41d4-a716-446655440002";
  globalThis.fetch = async (input, options) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: owner });
    if (url.pathname.endsWith("/create_deferred_wedding_starter")) return Response.json({ weddingId: owner, slug: "our-draft" });
    if (url.pathname.endsWith("/save_wedding_starter_structure")) {
      assert.equal(options.headers.apikey, "anon", "owner token, never service bypass");
      return Response.json(null);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  async function run(action, body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {},
      end(text) { this.body = JSON.parse(text); }, json(body) { this.body = body; } };
    await weddings({ method: "POST", headers: { authorization: "Bearer fixture" }, query: { action }, body }, res);
    return res;
  }
  try {
    const style = await publicWeddingStyle("showcase-wedding");
    assert.equal((await run("create", { requestKey: key, styleSlug: "showcase-wedding", starterDeferred: true,
      currency: "USD", coupleNames: "", palette: style.palette, venues: style.venues, starterSetup: style.setup })).statusCode, 201);
    const created = calls.find(call => call.body?.p_input).body.p_input;
    assert.equal(created.currency, "USD");
    assert.equal(created.starterSetup.currency, "KES");
    const structure = WSStarterSetup.structure(created.starterSetup);
    assert.equal((await run("starter-structure", { weddingId: owner, structure })).statusCode, 200);
    structure.campaigns[0].milestones[0].targetMinor = 100;
    const before = calls.length;
    assert.equal((await run("starter-structure", { weddingId: owner, structure })).statusCode, 400);
    assert.equal(calls.length, before + 1, "invalid nested price is rejected before SQL, only authentication runs");
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
