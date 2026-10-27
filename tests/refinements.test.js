import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePhone, phoneKeyEmail, isPhoneKeyEmail } from "../server/phone.js";
import handler from "../api/guest.js";

const read = p => readFileSync(p, "utf8");

test("phone normalization: digits only, Kenyan local numbers get 254", () => {
  assert.equal(normalizePhone("0712 345 678"), "254712345678");
  assert.equal(normalizePhone("+254 712-345-678"), "254712345678");
  assert.equal(normalizePhone("123"), "");
  assert.equal(normalizePhone(""), "");
  assert.ok(isPhoneKeyEmail(phoneKeyEmail("254712345678")));
  assert.ok(!isPhoneKeyEmail("a@b.co"));
});

test("RSVP requires a phone number and quotes fees before charging", () => {
  const src = read("api/guest.js");
  assert.match(src, /Please enter your phone number/);
  assert.match(src, /needsPayment: true/);
  assert.match(src, /extra_guest_fee_minor/);
  assert.match(src, /premium_diet_fee_minor/);
  assert.doesNotMatch(src, /record_test_rsvp_fees/);
  assert.match(read("supabase/migrations/202610300002_verified_test_payments.sql"), /revoke all on function public\.record_test_rsvp_fees/);
});

test("seating lookup is by phone", async () => {
  const call = query => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, setHeader() { return this; }, end(b) { resolve({ status: this.code, body: b }); } };
    handler({ method: "GET", query, headers: {}, socket: {} }, res);
  });
  assert.equal((await call({ action: "seating", slug: "some-wedding", phone: "x" })).status, 400);
  assert.match(read("guest.html"), /id="seat-phone"/);
  assert.match(read("api/guest.js"), /update or re-import the guest list with your phone number/);
});

test("guest site shows palette names with hex, theme label, celebration and pre-wedding sections", () => {
  const g = read("guest.html");
  assert.match(g, /palette-label/);
  assert.match(g, /id="prewedding-display"/);
  assert.match(g, /Get directions/);
  assert.match(g, /not the DJ/);
  assert.match(g, /Total charged now/);
  assert.match(g, /Your advert could be here/);
  assert.match(g, /Become a sponsor/);
  const sql = read("supabase/migrations/202610300001_refinements.sql");
  assert.match(sql, /palette_names/);
  assert.match(sql, /group by lower\(trim\(/i);
  assert.match(sql, /admin_wedding_metrics/);
});

test("organizer editor has palette names, fee settings, pre-wedding kind and CSV phone", () => {
  const w = read("wedding.html");
  for (const id of ["rsvp-fee", "extra-guest-fee", "premium-diet-fee", "premium-diet-options"]) assert.match(w, new RegExp(`id="${id}"`));
  assert.match(w, /palette-color-name/);
  assert.match(w, /venue-kind/);
  assert.match(w, /paletteNames:/);
  assert.match(w, /phone: at\(idx\.phone\)/);
});

test("back office: major-unit fees, pagination, drill-down and active tab", () => {
  const b = read("backoffice.js");
  assert.match(b, /Math\.round\(v \* 100\)/);
  assert.match(b, /mountPaged\(el, "audit"/);
  assert.match(b, /mountPaged\(el, "ledger"/);
  assert.match(b, /mountPaged\(el, "weddings"/);
  assert.match(b, /per: 20/);
  assert.match(b, /wedding-metrics/);
  assert.match(b, /aria-selected/);
  assert.match(b, /Platform commission \(%\)/);
  assert.match(b, /contribution_fee_basis_points: Math\.round\(n\("p-percent"\) \* 100\)/);
  assert.match(b, /contribution_fixed_fee_minor/);
  assert.match(b, /min_payout_minor/);
  assert.match(b, /payout_hold_days/);
  assert.match(b, /policy-history/);
  assert.match(read("api/admin.js"), /admin_policy_history/);
  assert.match(b, /Only the protected Owner can change platform fee and payout policies/);
  const paymentMigration = read("supabase/migrations/202610300002_verified_test_payments.sql");
  assert.match(paymentMigration, /provider_fees_by_currency/);
  assert.match(paymentMigration, /net_to_weddings_by_currency/);
  assert.match(paymentMigration, /provider_fee_holds_by_currency/);
  assert.match(paymentMigration, /create or replace function public\.admin_policy_history/);
  assert.match(paymentMigration, /current_platform_role\(\) is distinct from 'owner'/);
  assert.match(paymentMigration, /Fixed commission currency must be an uppercase three-letter ISO code/);
  assert.match(paymentMigration, /Minimum payout cannot exceed the maximum payout/);
  assert.match(read("backoffice.css"), /\.bo-nav button\.active/);
  assert.match(read("api/admin.js"), /wedding-metrics/);
});
