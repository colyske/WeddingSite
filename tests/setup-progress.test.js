import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../setup-progress.js", import.meta.url), "utf8");
const sandbox = { window: {}, document: {}, URL };
vm.runInNewContext(source, sandbox);
const { calculate } = sandbox.window.WSSetupProgress;

const completeWedding = () => ({
  couple_names: "Amina & David",
  slug: "amina-and-david",
  wedding_date: "2027-08-21",
  currency: "USD",
  kyc_submitted: true,
  venues: [{ name: "Garden", event_date: "2027-08-21", event_time: "10:00", address: "Garden Road" }],
  welcome_story: "We are looking forward to celebrating with you.",
  cover_image_url: "https://example.test/cover.jpg",
  guest_instructions: "Please RSVP by June 1.",
  collectionCapabilities: [{ code: "USD", methods: [{ name: "Card" }] }],
  revenue_features: { giving: true },
  registry: [{ name: "Celebration fund", target_amount_minor: 10000 }],
  palette: [],
  siteContent: {}
});

test("the named checklist follows the approved publication minimum without a percentage proxy or location gate", () => {
  const result = calculate(completeWedding());
  assert.equal(result.requiredReady, true);
  assert.equal(Object.hasOwn(result, "percent"), false);
  assert.equal(Object.hasOwn(result, "completed"), false);
  assert.equal(result.items.some(item => item.id === "location"), false);
  assert.equal(result.items.find(item => item.id === "palette-preview").complete, false);
  assert.deepEqual([...result.items].filter(item => item.required).map(item => item.id), [
    "couple-names", "wedding-date", "venues-section", "welcome-story", "fundraising-route"
  ]);
  const optional = calculate({ ...completeWedding(), cover_image_url: "", guest_instructions: "" });
  assert.equal(optional.requiredReady, true, "cover photo and guest instructions are optional");
  assert.equal(optional.items.find(item => item.id === "cover-image-url").required, false);
  assert.equal(optional.items.find(item => item.id === "guest-instructions").required, false);

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
    kyc_submitted: false,
    payout: null,
    campaigns: [{ enabled: false }],
    registry: [],
    tiers: [],
    rsvp_fee_minor: 0,
    extra_guest_fee_minor: 0,
    premium_diet_fee_minor: 0
  });
  assert.equal(result.items.some(item => item.id === "payout-readiness"), false);
});

test("payout readiness remains separate from the publication checklist", () => {
  const wedding = {
    ...completeWedding(), rsvp_fee_minor: 500, kyc_submitted: false,
    payout: { method: "card", verified: false }
  };
  const result = calculate(wedding);
  assert.equal(result.requiredReady, true);
  assert.equal(result.items.some(item => item.id === "payout-readiness"), false);
  assert.equal(result.nextStep.id, "palette-preview");
});

test("archived weddings are not ready", () => {
  assert.equal(calculate({ ...completeWedding(), archived_at: "2026-01-01" }).requiredReady, false);
});
