import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

for (const page of ["privacy.html", "terms.html"]) {
  test(`${page} is a branded public page with flagged unconfirmed operator details`, () => {
    const html = read(page);
    assert.match(html, /<title>[^<]*Join Our Wedding<\/title>/);
    assert.match(html, /footer\.js/);
    assert.match(html, /\[to be confirmed\]/);
    assert.match(html, /not legal advice/i);
    assert.doesNotMatch(html, /GDPR compliant|certified|ISO 27001|SOC 2/i);
    assert.doesNotMatch(html, /@[a-z0-9-]+\.[a-z]{2,}/i, "no invented contact inbox");
  });
}

test("privacy policy covers the actual data practices", () => {
  const html = read("privacy.html");
  for (const topic of [/phone number/i, /both partners/i, /referral/i, /sponsored/i, /Paystack/, /Daraja/, /Google/, /session storage/i, /archived, not deleted/i, /assistant/i, /Turnstile/])
    assert.match(html, topic);
});

test("legal pages are linked from footer, sign-in/sign-up and guest site", () => {
  assert.match(read("footer.js"), /\/privacy\.html/);
  assert.match(read("footer.js"), /\/terms\.html/);
  assert.match(read("signin.html"), /href="\/terms\.html"/);
  assert.match(read("signin.html"), /href="\/privacy\.html"/);
  assert.match(read("guest.html"), /href="\/privacy\.html" data-platform-link/);
  assert.match(read("guest.html"), /href="\/terms\.html" data-platform-link/);
});

test("official logo is used on platform pages with alt text and explicit dimensions", () => {
  for (const page of ["index.html", "signin.html", "dashboard.html", "privacy.html", "terms.html"]) {
    const html = read(page);
    assert.match(html, /<img src="\/assets\/brand\/logo-320\.jpg"[^>]*width="320" height="276" alt="Join Our Wedding">/, page);
  }
  const guest = read("guest.html");
  assert.match(guest, /class="platform-logo"[^>]*data-platform-link><img [^>]*alt="Join Our Wedding"/);
  assert.match(guest, /id="nav-couple"/, "couple names lead the guest nav");
  assert.doesNotMatch(guest, /apple-touch-icon/, "guest sites keep their own identity");
});
