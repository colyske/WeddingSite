import test from "node:test";
import assert from "node:assert/strict";
import guest from "../api/guest.js";

test("fundraising API uses the authoritative aggregate for only its parent and milestones; errors never become zero", async t => {
  const saved = Object.fromEntries(["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { SUPABASE_URL: "https://cake.test", SUPABASE_ANON_KEY: "test", SUPABASE_SERVICE_ROLE_KEY: "test" });
  let disabled = false, fail = false;
  const aggregate = { campaign_id: "main", currency: "KES", goal_minor: 50000000, raised_minor: 18000000, campaign_raised_minor: 9525000, remaining_minor: 32000000, sources: [] };
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    const u = new URL(url);
    assert.equal(u.host, "cake.test", "no provider or real database calls");
    const name = u.pathname.split("/").at(-1);
    calls.push(name);
    let data;
    if (name === "get_public_wedding") data = [{ id: "cake-wedding" }];
    else if (name === "get_public_fundraising") data = { tiers: [], sponsors: [], vip: null };
    else if (name === "get_public_campaigns") data = [
      { id: "main", raised_minor: 9525000, milestones: [{ id: "one", target_minor: 15000000, reached: false }, { id: "two", target_minor: 30000000, reached: false }] },
      { id: "another", raised_minor: 500, milestones: [] }
    ];
    else if (name === "get_public_sponsor_auction") data = { enabled: false };
    else if (name === "weddings") data = [{ revenue_features: { giving: !disabled } }];
    else if (name === "get_public_celebration_progress") {
      if (fail) return new Response(JSON.stringify({ message: "Aggregate unavailable" }), { status: 500 });
      data = aggregate;
    } else assert.fail(`Unexpected call ${name}`);
    return new Response(JSON.stringify(data));
  });
  t.mock.method(console, "error", () => {});
  const request = async () => {
    const res = {
      status(code) { this.code = code; return this; }, setHeader() {},
      end(body) { this.body = JSON.parse(body); }
    };
    await guest({ method: "GET", headers: {}, query: { action: "fundraising", slug: "cake-wedding" } }, res);
    return res;
  };
  try {
    const res = await request();
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.celebration, aggregate);
    assert.equal(res.body.campaigns[0].raised_minor, 18000000);
    assert.equal(res.body.campaigns[0].milestones[0].reached, false, "other-source umbrella raised never attains a stream milestone");
    assert.equal(res.body.campaigns[0].milestones[1].reached, false);
    assert.equal(res.body.campaigns[1].raised_minor, 500);
    assert.ok(calls.includes("get_public_celebration_progress"));
    aggregate.raised_minor = 50000000;
    aggregate.campaign_raised_minor = 20000000;
    aggregate.remaining_minor = 0;
    const full = await request();
    assert.equal(full.body.campaigns[0].raised_minor, 50000000);
    assert.equal(full.body.campaigns[0].milestones[0].reached, true);
    assert.equal(full.body.campaigns[0].milestones[1].reached, false, "full umbrella never marks300k Music reached when parent raised200k");
    assert.equal(full.body.campaigns[1].raised_minor, 500);
    disabled = true;
    const hidden = await request();
    assert.deepEqual(hidden.body.campaigns, []);
    assert.equal(hidden.body.celebration, null);
    disabled = false; fail = true;
    const error = await request();
    assert.equal(error.code, 503);
    assert.ok(error.body.error);
    assert.equal(error.body.celebration, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
