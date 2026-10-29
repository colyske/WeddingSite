import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "../contact-policy.js";

const policy = globalThis.WSContactPolicy;
const message = "Use the designated contact fields for phone numbers and email addresses.";

test("detects Kenyan and international phone formats embedded in text", () => {
  for (const value of [
    "Call 0712345678 please",
    "SMS 0112 345 678",
    "WhatsApp 712345678",
    "Phone: +254 712 345 678",
    "Phone: +254 (0) 712 345 678",
    "Phone: 254-712-345-678",
    "Phone: 00254 712 345 678",
    "Phone: 00123456789012345",
    "Phone: +1 (415) 555-2671",
    "Phone: (020) 7946 0958",
    "Phone: +44 20 7946 0958",
    "Phone: +33 6 12 34 56 78",
    "Phone: +49 (30) 12345678",
    "Phone: +65 6123 4567",
    "Phone: 0 7 1 2 3 4 5 6 7 8",
    "Phone: 0712.345.678",
    "Phone: +254 712 345.67",
    "Phone: 0712\u2011345\u2011678",
    "Phone: 0712345678 0723456789",
    "Pay KES 500; call +254 712 345 678",
    "On 2026-10-29, call 0712345678",
  ]) {
    assert.equal(policy.hasContact(value), true, value);
  }
});

test("detects ordinary and AT/DOT/bracket-obfuscated email addresses", () => {
  for (const value of [
    "Write to jane@example.com",
    "Contact jane.doe+guests@sub.example.co.ke!",
    "jane @ example . com",
    "jane AT example DOT com",
    "jane at example.com",
    "jane@example dot com",
    "jane[at]example[dot]com",
    "jane (at) example (dot) co (dot) ke",
    "jane{at}example{dot}com",
    "jane [ @ ] example [ . ] com",
    "jane [AT] example.com",
    "jane.doe at example dot org",
    "mailto:jane@example.com",
    "jos\u00e9@exemple.fr",
  ]) {
    assert.equal(policy.hasContact(value), true, value);
  }
});

test("detects consecutive English digit-word phones, including recursive validation", () => {
  for (const value of [
    "call zero seven two four eight one two four one three",
    "Call ZERO SEVEN TWO FOUR EIGHT ONE TWO FOUR ONE THREE please",
    "call zero-seven-two-four-eight-one-two-four-one-three",
    "phone seven two four eight one two four one three",
    "plus two five four seven two four eight one two four one three",
  ]) {
    assert.equal(policy.hasContact(value), true, value);
    assert.deepEqual(policy.validate({ note: value }), { valid: false, message, path: "$.note" });
    assert.equal(policy.validate({ phone: value }, { exemptKeys: ["phone"] }).valid, true);
  }
});

test("does not interpret ordinary number, date or year prose as spelled phones", () => {
  for (const value of [
    "The wedding is on October twenty nine, two thousand and twenty six.",
    "We met in twenty nineteen and got engaged in twenty twenty five.",
    "Years two zero two four, two zero two five, two zero two six.",
    "two zero two six October two nine",
    "There are one hundred and twenty guests at seven tables.",
    "Count one two three four five six seven eight.",
    "Someone said stone seven two four eight one two four three.",
    "zero seven two four eight one two four one threefold",
  ]) {
    assert.equal(policy.hasContact(value), false, value);
  }
});

test("normalizes compatibility characters, hidden characters and non-ASCII digits", () => {
  for (const value of [
    "ｊａｎｅ＠ｅｘａｍｐｌｅ．ｃｏｍ",
    "jane\u200b@\u2060example.com",
    "jane\u200e[at]example[dot]com",
    "jane@example\u3002com",
    "０７１２３４５６７８",
    "٠٧١٢ ٣٤٥ ٦٧٨",
    "۰۷۱۲ ۳۴۵ ۶۷۸",
    "०७१२ ३४५ ६७८",
    "+２５４\u00a0７１２\u202f３４５\u00a0６７８",
    "0712\u200b345\u200d678",
    "0712\u2212345\u2212678",
  ]) {
    assert.equal(policy.hasContact(value), true, value);
  }
});

test("allows ordinary text, dates, currency amounts, years and non-contact URLs", () => {
  for (const value of [
    "",
    "Congratulations! Looking forward to celebrating with you.",
    "Meet at the main gate. Dot the i and cross the t.",
    "We have 250 guests and 12 tables.",
    "The ceremony starts at 12:30.",
    "Wedding on 2026-10-29 at 12:30",
    "2026-10-29 12:30:45",
    "29/10/2026 12:30",
    "29.10.2026 12:30",
    "10/29/2026",
    "10-29-2026 12:30",
    "10.29.2026 12:30",
    "29-10-26",
    "2026-10-29 2026-10-30",
    "2024 2025 2026",
    "Years 2024, 2025, 2026",
    "From 2024 - 2026",
    "KES 1000000000",
    "Ksh 1 000 000 000",
    "KSHS 1,000,000,000.00",
    "USD 1234567890.00",
    "$1,000,000,000.00",
    "\u20ac 1234567890.00",
    "1000000000 KES",
    "1,000,000,000.00",
    "1234567890.00",
    "1 000 000 000.00",
    "500.00",
    "2026",
    "Visit https://example.com/wedding",
    "https://instagram.com/our.wedding",
    "@ourwedding",
  ]) {
    assert.equal(policy.hasContact(value), false, value);
  }
});

test("ignores non-string primitives rather than treating numeric data as free text", () => {
  for (const value of [null, undefined, false, 712345678, 1234567890, {}, []]) {
    assert.equal(policy.hasContact(value), false);
  }
});

test("recursively validates objects and arrays, reporting the first offending path", () => {
  const value = { guests: [{ note: "Congratulations" }, { note: "Email me at jane@example.com" }] };
  assert.deepEqual(policy.validate(value), {
    valid: false,
    message,
    path: "$.guests[1].note",
  });
  assert.deepEqual(policy.validate("0712345678"), { valid: false, message, path: "$" });
  assert.deepEqual(policy.validate({ amount: 1234567890, year: 2026, note: "Welcome!" }), {
    valid: true,
    message: null,
    path: null,
  });
});

test("contact fields and sponsor social-link subtrees are exempt only when explicitly configured", () => {
  const value = {
    email: "guest@example.com",
    phone: "0712345678",
    sponsor: {
      socialLinks: [
        "https://wa.me/254712345678",
        "https://example.com/1234567890",
        "mailto:sponsor@example.com",
      ],
      bio: "Proud to support the happy couple!",
    },
  };
  assert.equal(policy.validate(value).valid, false);
  const options = { exemptKeys: ["email", "phone"], exemptPaths: ["$.sponsor.socialLinks"] };
  assert.equal(policy.validate(value, options).valid, true);
  assert.strictEqual(policy.assert(value, options), value);
  value.sponsor.bio = "Contact sponsor@example.com";
  assert.deepEqual(policy.validate(value, options), {
    valid: false,
    message,
    path: "$.sponsor.bio",
  });
});

test("key exemptions apply recursively, including arrays, without exempting similar keys", () => {
  const value = { guests: [{ email: "guest@example.com", emailNote: "jane at example dot com" }] };
  assert.equal(policy.validate(value, { exemptKeys: ["email"] }).path, "$.guests[0].emailNote");
  assert.equal(policy.validate({ socialLinks: ["https://wa.me/254712345678"] }, {
    exemptKeys: ["socialLinks"],
  }).valid, true);
});

test("assert throws the clear message, stable code and offending path", () => {
  assert.throws(() => policy.assert({ note: "0712345678" }), (error) => {
    assert.equal(error.message, message);
    assert.equal(error.code, "CONTACT_INFO_NOT_ALLOWED");
    assert.equal(error.path, "$.note");
    return true;
  });
  assert.equal(policy.assert("Congratulations"), "Congratulations");
  assert.equal(policy.message, message);
});

test("handles cyclic and shared objects without mutating input or losing path-specific checks", () => {
  const shared = Object.freeze({ note: "0712345678" });
  const value = { exempt: shared, checked: shared };
  value.self = value;
  assert.equal(policy.validate(value, { exemptPaths: ["$.exempt"] }).path, "$.checked.note");
  assert.equal(policy.validate(value, {
    exemptPaths: ["$.exempt.note", "$.checked.note"],
  }).valid, true);
  const clean = { note: "Welcome" };
  clean.self = clean;
  assert.equal(policy.validate(clean).valid, true);
});

test("works as a classic browser script without Node globals or module wiring", () => {
  const source = readFileSync(new URL("../contact-policy.js", import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(context.WSContactPolicy.hasContact("jane at example dot com"), true);
  assert.equal(context.WSContactPolicy.validate({ note: "Welcome" }).valid, true);
  assert.equal(context.WSContactPolicy.message, message);
  assert.equal(Object.isFrozen(context.WSContactPolicy), true);
});
