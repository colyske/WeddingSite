import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../setup-progress.js", import.meta.url), "utf8");
const sandbox = { window: {}, document: {} };
vm.runInNewContext(source, sandbox);
const { calculate, colorAt } = sandbox.window.WSSetupProgress;

const completeWedding = () => ({
  couple_names: "Amina & David",
  slug: "amina-and-david",
  wedding_date: "2027-08-21",
  kyc_submitted: true,
  venues: [{ name: "Garden", event_date: "2027-08-21", event_time: "10:00" }],
  palette: [],
  siteContent: {}
});

test("setup progress uses saved wedding data and separates publish readiness", () => {
  const result = calculate(completeWedding());
  assert.equal(result.requiredReady, true);
  assert.equal(result.percent, 43);
  assert.equal(result.items.find(item => item.id === "palette-preview").complete, false);

  const partial = calculate({ ...completeWedding(), couple_names: "" });
  assert.equal(partial.requiredReady, false);
  assert.ok(partial.nextStep);
  assert.equal(partial.items.find(item => item.id === "couple-names").complete, false);
  assert.equal(result.items.some(item => /kyc/i.test(item.id + item.label)), false);
  assert.equal(calculate({ ...completeWedding(), kyc_submitted: false }).requiredReady, true);
});

test("optional disabled paid features do not add payout setup requirements", () => {
  const result = calculate({
    ...completeWedding(),
    campaigns: [{ enabled: false }],
    registry: [],
    tiers: [],
    rsvp_fee_minor: 0,
    extra_guest_fee_minor: 0,
    premium_diet_fee_minor: 0
  });
  assert.equal(result.items.some(item => item.id === "payout-method"), false);
});

test("configured paid features add a non-blocking payout setup step", () => {
  const wedding = { ...completeWedding(), rsvp_fee_minor: 500 };
  const result = calculate(wedding);
  assert.equal(result.requiredReady, true);
  assert.equal(result.items.find(item => item.id === "payout-method").complete, false);
  assert.equal(result.nextStep.id, "payout-method");
});

test("donut color transitions from orange toward green and archived weddings are not ready", () => {
  assert.match(colorAt(0), /^hsl\(28 /);
  assert.match(colorAt(100), /^hsl\(133 /);
  assert.equal(calculate({ ...completeWedding(), archived_at: "2026-01-01" }).requiredReady, false);
});
