import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

for (const page of ["privacy.html", "terms.html"]) {
  test(`${page} is a branded public page with confirmed operator details`, () => {
    const html = read(page);
    assert.match(html, /<title>[^<]*Join Our Wedding<\/title>/);
    assert.match(html, /footer\.js/);
    assert.doesNotMatch(html, /\[to be confirmed\]|Draft notice/i);
    assert.match(html, /Aster Azure Ltd/);
    assert.match(html, /PVT-EYUBL333/);
    assert.doesNotMatch(html, /GDPR compliant|certified|ISO 27001|SOC 2/i);
    assert.doesNotMatch(html, /\bOwner\b/, "internal platform roles are not exposed in public legal copy");
    assert.match(html, /info\.asterazure@gmail\.com/, "user-supplied contact inbox");
  });
}

test("facilitator guide uses product SVG artwork and clear onsite setup instructions", () => {
  const html = read("facilitator.html");
  assert.match(html, /class="facilitator-art"/);
  assert.match(html, /role="img" aria-labelledby="facilitator-art-title/);
  assert.match(html, /Be physically with the couple/);
  assert.match(html, /reply “Yes” before starting setup/);
  assert.match(html, /Open sample wedding/);
  assert.match(html, /same link for every couple/);
  assert.match(html, /phone or laptop/);
  assert.match(html, /I'll set up your wedding website on Join Our Wedding site for you\./);
  assert.match(html, /Here's the link to set up your wedding site: \[your referral link\]\./);
  assert.match(html, /class="facilitator-step-message"/);
  assert.match(html, /2%/);
  assert.match(html, /Facilitator commission/);
  assert.match(html, /paid after funds are cleared/i);
  assert.doesNotMatch(html, /manual payout|manually paid|HELD estimates only|payable: zero|no transfer route|doesn.t enable payouts/i);
});

test("facilitator link message is prepared with the individual referral URL", () => {
  const html = read("referrals.html");
  const script = read("referrals.js");
  assert.match(html, /id="referral-share-message"/);
  assert.match(html, /Message to send after they agree/);
  assert.match(script, /client_ref=\$\{account\.code\}/);
  assert.match(script, /Here's the link to set up your wedding site: \$\{referralLink\}/);
  assert.match(script, /Setup message copied/);
});

test("homepage promotes the facilitator guide from its closing section and footer", () => {
  const home = read("index.html");
  const footer = read("footer.js");
  assert.match(home, /id="facilitator-invite-title"/);
  assert.match(home, /src="\/footer\.js\?v=3"/);
  assert.match(home, /href="\/facilitator\.html">Earn as our Facilitator<\/a>/);
  assert.match(footer, /\[\["Earn as our Facilitator", "\/facilitator\.html"\]/);
});

test("privacy policy covers the actual data practices", () => {
  const html = read("privacy.html");
  for (const topic of [/phone number/i, /both partners/i, /referral/i, /sponsored/i, /Paystack/, /Daraja/, /Google/, /session storage/i, /archived, not deleted/i, /assistant/i, /Turnstile/])
    assert.match(html, topic);
});

test("payment terms distinguish company costs, accepted customer fees and historical contracts", () => {
  const html = read("terms.html");
  assert.match(html, /datetime="2026-11-04"/);
  assert.match(html, /provider transaction costs are company overhead, not a separate deduction or an unknown-fee hold/i);
  assert.match(html, /Unknown actual provider costs remain unknown/);
  assert.match(html, /platform may configure a customer withdrawal processing fee/i);
  assert.match(html, /explicitly confirms the amount received, processing fee and total balance debit/);
  assert.match(html, /changed quote requires fresh confirmation/);
  assert.match(html, /no additional customer fee is added at Processing/);
  assert.match(html, /smaller positive amount is permitted only when.*full remaining available balance/);
  assert.match(html, /maximum and available-funds limits still apply/);
  assert.match(html, /zero removes only the platform time delay/);
  assert.match(html, /Earlier terms described separate provider-fee deductions/);
  assert.match(html, /does not rewrite saved payment fees or release dates, historical refund allocations, or existing active or paid payout contracts/);
  assert.doesNotMatch(html, /Provider transaction fees are deducted separately from the couple's balance/);
  assert.doesNotMatch(html, /current platform commission is 8%/);
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
  assert.match(guest, /rel="apple-touch-icon" sizes="120x120" href="\/assets\/brand\/icon-120\.png"/, "guest sites share the platform icon while keeping couple-led navigation");
});
