import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import guest from "../api/guest.js";
import checkout from "../api/checkout.js";
import { SHOWCASE_ID, SHOWCASE_SLUG } from "../server/showcase.js";
import { contentError } from "../server/content-policy.js";
import "../social-links.js";

async function call(handler, action, method = "GET", data = {}) {
  const res = { statusCode: 0, headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.data = JSON.parse(body); } };
  await handler({ method, query: { action, ...data }, headers: {}, body: data }, res);
  return res;
}

test("showcase APIs require neither database nor provider access; all writes are disabled", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Showcase must not contact external services"); };
  try {
    for (const action of ["site", "leaderboard", "ledger", "fundraising", "extras", "rsvp-count"]) {
      assert.equal((await call(guest, action, "GET", { slug: SHOWCASE_SLUG })).statusCode, 200, action);
      assert.equal((await call(guest, action, "POST", { slug: SHOWCASE_SLUG })).statusCode, 403, action);
    }
    const options = await call(checkout, "options", "GET", { weddingId: SHOWCASE_ID });
    assert.equal(options.data.paymentAvailable, false);
    assert.deepEqual(options.data.providers, []);
    assert.equal((await call(checkout, "create", "POST", { weddingId: SHOWCASE_ID })).statusCode, 403);
  } finally { globalThis.fetch = fetch; }
});

test("API contact policy checks nested public text but exempts contact, social, identifiers and numeric fields", async () => {
  assert.match(contentError({ venues: [{ description: "call +254700000001" }] }), /designated contact fields/);
  assert.match(contentError({ welcomeStory: "hello [at] example [dot] com" }), /designated/);
  assert.match(contentError({ purchaseData: { songTitle: "call zero seven zero zero zero zero zero zero zero one" } }), /designated/);
  assert.equal(contentError({ phone: "+254700000001", email: "hello@example.com", socialLinks: { x: "https://x.com/example" },
    weddingDate: "2099-08-16", amountMinor: 1000000000, idNumber: "123456789", description: "A party for 150 in 2099, KES 2,500" }), null);
  assert.equal((await call(guest, "wish", "POST", { slug: "real-couple", message: "call +254700000001" })).statusCode, 400);
  assert.equal((await call(checkout, "create", "POST", { songTitle: "name@example.com" })).statusCode, 400);
});

test("social profile URLs require the selected common platform, HTTPS and a profile path", () => {
  assert.deepEqual(WSSocialLinks.parse({ instagram: "https://www.instagram.com/example", x: "https://twitter.com/example" }),
    { instagram: "https://www.instagram.com/example", x: "https://twitter.com/example" });
  for (const url of ["javascript:alert(1)", "https://instagram.com.evil.test/example", "https://evil.test/", "http://instagram.com/example", "https://user@instagram.com/example", "https://instagram.com/"]) {
    assert.throws(() => WSSocialLinks.parse({ instagram: url }));
  }
});

test("shared sponsor cards validate links and require contact-sharing consent", async () => {
  const sandbox = { window: {}, WSSocialLinks: globalThis.WSSocialLinks, URL, console: { warn() {} },
    WS: { money: () => "KES 10,000" } };
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../sponsor-cards.js", import.meta.url), "utf8"), sandbox);
  const render = sandbox.window.WSSponsorCards.render;
  const sample = { company_name: 'Sample <brand>', social_links: { facebook: "https://facebook.com/example" },
    contact_email: "studio@example.com", contact_phone: "+1 202 555 0123", public_contact: true, website: "https://example.com" };
  const html = render(sample, { currency: "KES" });
  assert.match(html, /aria-label="Sample &lt;brand&gt; on Facebook"/);
  assert.match(html, /mailto:studio@example.com/);
  assert.match(html, /tel:\+12025550123/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(render({ ...sample, public_contact: false }), /mailto:|tel:/);
  const hostile = render({ ...sample, website: "javascript:alert(1)", contact_email: 'x@example.com?subject=bad',
    contact_phone: 'javascript:bad', social_links: { facebook: "https://evil.example/profile" } });
  assert.doesNotMatch(hostile, /href="(?:javascript:|https:\/\/evil|mailto:|tel:)/);
  assert.match(hostile, /Social profiles unavailable/);
});

test("currency formatter uses major units in the chosen currency and never outputs NaN", async () => {
  const sandbox = { window: {}, console: { error() {} }, Intl, Number, JSON, sessionStorage: { getItem() { return null; } } };
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../auth-client.js", import.meta.url), "utf8"), sandbox);
  const money = sandbox.window.WS.money;
  assert.match(money(250000, "KES"), /2,500/);
  assert.doesNotMatch(money(250000, "KES"), /\$|NaN|USD/);
  for (const value of [undefined, null, "", "invalid"]) assert.equal(money(value, "KES"), "Amount unavailable");
});

test("legal pages contain supplied company details and no draft placeholders or sandbox guarantee", async () => {
  for (const file of ["privacy.html", "terms.html"]) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const detail of ["Aster Azure Ltd", "PVT-EYUBL333", "info.asterazure@gmail.com", "+254724812413", "Cave Diani Holiday Apartments", "Kenya"]) assert.ok(html.includes(detail), `${file}: ${detail}`);
    assert.doesNotMatch(html, /Draft notice|to be confirmed|no real money is collected/i);
    assert.doesNotMatch(html, /ODPC.registered|registered.with.ODPC/i);
  }
});
