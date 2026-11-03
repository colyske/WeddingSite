import test from "node:test";
import assert from "node:assert/strict";
import "../currencies.js";
import "../inspiration-fixtures.js";
import "../starter-setup.js";
import { starterCapabilities } from "../server/starter-capabilities.js";

test("unpriced structures retain every offering and nested goal but reject amounts or foreign fields", () => {
  const config = WSStarterSetup.normalize({ ...WSStarterSetup.fictional("garden-gathering", "KES"), reviewed: true }, "KES");
  const structure = WSStarterSetup.structure(config);
  assert.deepEqual(WSStarterSetup.restoreStructure(structure), structure);
  assert.equal(structure.tiers.length, config.tiers.length);
  assert.equal(structure.registry.length, config.registry.length);
  assert.equal(structure.campaigns[0].milestones.length, 2);
  assert.equal(structure.vip.seats, config.vip.seats);
  assert.equal(structure.featured.slots, config.featured.slots);
  const amounts = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/Minor$/.test(key)) amounts.push(child);
      else visit(child);
    }
  };
  visit(structure);
  assert.ok(amounts.length > 6);
  assert.ok(amounts.every(amount => amount === null));
  assert.equal(config.registry[0].targetMinor, 15000000, "source remains untouched");
  assert.throws(() => WSStarterSetup.restoreStructure({ ...structure, transactions: [] }), /draft structures/);
  structure.campaigns[0].milestones[0].targetMinor = 100;
  assert.throws(() => WSStarterSetup.restoreStructure(structure), /cannot contain amounts/);
});

test("curated starter structures cover existing configurable sections with explicit currency review", () => {
  for (const fixture of WSInspiration.fixtures) {
    const empty = WSStarterSetup.fictional(fixture.id);
    assert.equal(empty.currency, "");
    assert.equal(empty.tiers[0].minAmount, "");
    for (const currency of ["USD", "KES", "EUR", "GBP", "NGN", "ZAR"]) {
      const value = WSStarterSetup.fictional(fixture.id, currency);
      assert.throws(() => WSStarterSetup.normalize(value, currency), /review and confirm/);
      value.reviewed = true;
      const parsed = WSStarterSetup.normalize(value, currency);
      assert.equal(parsed.currency, currency);
      assert.equal(parsed.reviewed, true);
      assert.equal(parsed.tiers.length, 2);
      assert.equal(parsed.campaigns[0].milestones.length, 2);
      assert.equal(parsed.registry.length, 1);
      assert.equal(parsed.vip.seats, 12);
      assert.equal(parsed.rsvp.feeMinor, 0);
      assert.deepEqual(Object.keys(parsed.features).sort(), WSStarterSetup.featureKeys.toSorted());
      assert.deepEqual(Object.keys(parsed).sort(), ["campaigns", "content", "currency", "featured", "features", "registry", "reviewNote", "reviewed", "rsvp", "tiers", "vip"]);
      assert.equal(Object.hasOwn(parsed, "amountPresets"), false);
      assert.equal(parsed.content.faq.length, 3);
      assert.equal(JSON.stringify(parsed).includes(fixture.names), false);
      assert.equal(JSON.stringify(parsed).includes("raised"), false);
      assert.throws(() => WSStarterSetup.normalize(value, currency === "KES" ? "USD" : "KES"), /review and confirm/);
      const cleared = WSStarterSetup.clearMoney(value, "CAD");
      assert.equal(cleared.reviewed, false);
      assert.equal(cleared.rsvp.fee, "");
      assert.equal(cleared.tiers[0].minAmount, "");
      assert.equal(cleared.registry[0].target, "");
      assert.equal(cleared.vip.price, "");
      assert.equal(cleared.featured.minimum, "");
      assert.equal(cleared.featured.increment, "");
      assert.equal(cleared.campaigns[0].goal, "");
      assert.equal(cleared.campaigns[0].milestones[0].target, "");
      assert.equal(cleared.tiers[0].name, value.tiers[0].name);
    }
  }
  assert.equal(WSStarterSetup.hasSamples("CAD"), false, "no invented FX fallback for unsupported sample currency");
});

test("starter validation rejects foreign state, invalid prices/limits and out-of-goal milestones", () => {
  const valid = () => ({ ...WSStarterSetup.fictional("garden-gathering", "USD"), reviewed: true });
  for (const key of ["raised", "sponsors", "guests", "paymentMethods", "published_at", "referral"]) {
    assert.throws(() => WSStarterSetup.normalize({ ...valid(), [key]: [] }, "USD"), /configuration/);
  }
  for (const amount of ["-1", "0", "1.001", "Infinity", "", "1e2", "1000000001", 25]) {
    const value = valid();
    value.tiers[0].minAmount = amount;
    assert.throws(() => WSStarterSetup.normalize(value, "USD"), /amount|limits/);
  }
  const value = valid();
  value.tiers[0].minAmount = "0.01";
  assert.equal(WSStarterSetup.normalize(value, "USD").tiers[0].minimumMinor, 1, "preserve existing package minimum");
  value.campaigns[0].milestones[0].target = "1500.01";
  assert.throws(() => WSStarterSetup.normalize(value, "USD"), /limits/);
  value.campaigns[0].milestones[0].target = "1500";
  assert.throws(() => WSStarterSetup.normalize({ ...valid(), amountPresets: { song: [100] } }, "USD"), /configuration/);
  assert.throws(() => WSStarterSetup.normalize(valid(), "JPY"), /currency/);
});

test("capability dependency is read-only and fails closed, never invents provider support", async () => {
  let args;
  const expected = [{ code: "USD", name: "US Dollar", methods: [{ name: "Card", markets: ["US"] }] }];
  assert.deepEqual(await starterCapabilities(async () => ({
    collectionCapabilities(...input) { args = input; return expected; }
  })), expected);
  assert.deepEqual(args, [], "must not use recording/snapshot mode as a read-only check");
  await assert.rejects(starterCapabilities(async () => { const error = new Error("Missing helper"); error.code = "ERR_MODULE_NOT_FOUND"; throw error; }),
    error => error.status === 503 && /money review depends on the collection/.test(error.message));
  await assert.rejects(starterCapabilities(async () => ({ collectionCapabilities() { throw new Error("Provider health unavailable"); } })),
    error => error.status === 503 && error.code === "STARTER_CAPABILITIES_UNAVAILABLE" && error.cause.message === "Provider health unavailable");
  for (const invalid of [null, {}, [{ code: "USD", name: "Dollar", methods: [] }],
    [{ ...expected[0], methods: [{ name: "Card", markets: [123] }] }], [...expected, ...expected]]) {
    await assert.rejects(starterCapabilities(async () => ({ collectionCapabilities: () => invalid })),
      error => error.status === 503 && error.code === "STARTER_CAPABILITIES_UNAVAILABLE");
  }
  assert.deepEqual(await starterCapabilities(async () => ({ collectionCapabilities: () => [] })), []);
});

test("saved editable starter answers restore unfinished values but reject malformed nested state", () => {
  const value = WSStarterSetup.fictional("garden-gathering");
  value.tiers[0].minAmount = "unfinished price";
  assert.deepEqual(WSStarterSetup.restoreEditable(value), value);
  for (const corrupt of [
    { ...value, rsvp: null },
    { ...value, tiers: [null] },
    { ...value, campaigns: [{ name: 42 }] },
    { ...value, vip: {} },
    { ...value, content: [] }
  ]) assert.throws(() => WSStarterSetup.restoreEditable(corrupt), /saved/);
});
