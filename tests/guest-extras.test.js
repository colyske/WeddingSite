import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://x").pathname.slice(1) || "index.html";
    if (name.includes("..")) throw new Error("bad");
    res.writeHead(200, { "Content-Type": types[extname(name)] || "text/plain" }).end(await readFile(join(root, name)));
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
for (const o of [{ channel: "msedge" }, {}]) { try { browser = await chromium.launch(o); break; } catch { /* next */ } }
const skip = browser ? false : "No Chromium/Edge is installed.";
test.after(async () => { await browser?.close(); server.close(); });

test("referral/guestbook migration is idempotent, hashes visits and restricts access", async () => {
  const sql = await readFile(join(root, "supabase/migrations/202610290001_referrals_guestbook_extras.sql"), "utf8");
  assert.match(sql, /add column if not exists ref_code/i);
  assert.match(sql, /create table if not exists public\.site_visits/i);
  assert.match(sql, /visitor_hash text not null/i);
  assert.doesNotMatch(sql, /\bip\b\s+(inet|text)/i);
  assert.match(sql, /alter table public\.site_visits enable row level security/i);
  assert.match(sql, /alter table public\.guest_wishes enable row level security/i);
  assert.match(sql, /can_manage_wedding/);
  assert.doesNotMatch(sql, /drop (table|column)/i);
  assert.doesNotMatch(sql, /guest_email/i.test(sql) ? /^$/ : /select[^;]*guest_email[^;]*referral/is);
});

test("API exposes visit/wish/extras/og and organizer referral endpoints without raw IP storage", async () => {
  const guest = await readFile(join(root, "api/guest.js"), "utf8");
  for (const a of ["visit", "wish", "extras", "og"]) assert.match(guest, new RegExp(`action === "${a}"`));
  assert.match(guest, /createHmac/);
  assert.doesNotMatch(guest, /ip_address|client_ip\s*:/);
  const w = await readFile(join(root, "api/weddings.js"), "utf8");
  for (const a of ["referrals", "analytics", "wishes-list", "wish-moderate", "extras-save"]) assert.match(w, new RegExp(a));
  const v = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  assert.ok(v.rewrites.some(r => r.source === "/w/:slug" && r.destination.includes("action=og")));
});

test("guest site: share channels, OG tags, referral visit, personal link, guestbook and FAQ", { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "a-and-o", couple_names: "Atieno & Otieno", welcome_story: "Hi", wedding_date: "2099-12-12",
    time_zone: "Africa/Nairobi", public_location: "Nairobi", currency: "KES", max_guest_capacity: 100, palette: ["#244b3a", "#be9b52", "#a9b5a2"],
    venues: [{ id: "1", name: "Chapel", event_time: "14:00:00", is_main: true }], registry: [], accepting_rsvps: true };
  const calls = { visit: null, wish: null, rsvp: null };
  await page.route("**/api/**", async route => {
    const u = new URL(route.request().url());
    const action = u.searchParams.get("action");
    const json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (action === "site") return json({ wedding });
    if (action === "visit") { calls.visit = route.request().postDataJSON(); return json({ ok: true }); }
    if (action === "wish") { calls.wish = route.request().postDataJSON(); return json({ message: "Thank you! Your wish will appear once the couple approves it." }); }
    if (action === "extras") return json({ faq: [{ q: "Is there parking?", a: "Yes, free parking on site." }], travel: "Shuttle from the hotel at 1 PM.", wishes: [{ author_name: "Wanjiru", message: "Congratulations!", created_at: "2099-01-01" }] });
    if (action === "rsvp-count") return json({ confirmed: 0, capacity: 100 });
    if (action === "rsvp") { calls.rsvp = route.request().postDataJSON(); return json({ message: "ok", status: "confirmed", rsvpId: "11111111-1111-4111-8111-111111111111", refCode: "abcdef12" }); }
    return json({ bids: [], ledger: [] });
  });
  await page.route("**/cdnjs.cloudflare.com/**", r => r.fulfill({ contentType: "text/javascript", body: "window.QRCode=function(){}" }));
  await page.goto(`${base}/guest.html?slug=a-and-o&ref=0a1b2c3d`);
  await page.waitForSelector("#share-main");
  assert.equal(await page.getAttribute('meta[property="og:title"]', "content"), "Atieno & Otieno are getting married");
  assert.equal(await page.getAttribute('meta[name="twitter:card"]', "content"), "summary_large_image");
  assert.match(await page.getAttribute('meta[property="og:url"]', "content"), /\/w\/a-and-o$/);
  const hrefs = await page.$$eval("#share-main a", as => as.map(a => a.href));
  for (const k of ["wa.me", "facebook.com/sharer", "twitter.com/intent/tweet", "mailto:", "sms:", "calendar.google.com/calendar/render"]) assert.ok(hrefs.some(h => h.includes(k)), "missing " + k);
  assert.ok(await page.$("#share-main [data-ws-copy]"));
  assert.ok(await page.$("#share-main [data-ws-share]"));
  assert.ok(await page.$("#hero-share-link"));
  assert.ok(await page.$("#footer-share-link"));
  assert.match(await page.textContent("#share-main .fine"), /RSVP to get your own personal invite link/);
  await page.waitForTimeout(300);
  assert.deepEqual(calls.visit, { slug: "a-and-o", ref: "0a1b2c3d" });

  await page.waitForSelector("#info-section");
  assert.match(await page.textContent("#info-section"), /Shuttle from the hotel/);
  assert.match(await page.textContent("#info-section"), /Is there parking\?/);
  assert.match(await page.textContent("#guestbook"), /Congratulations!/);
  await page.fill("#wish-name", "Kamau");
  await page.fill("#wish-text", "Best wishes <b>always</b>");
  await page.click("#wish-form button");
  await page.waitForFunction(() => /approves it/.test(document.getElementById("ws-toast")?.textContent || ""));
  assert.equal(calls.wish.name, "Kamau");

  await page.fill("#guest-name", "Njeri");
  await page.fill("#guest-phone", "0712345678");
  await page.selectOption("#attending", { index: 1 });
  await page.click("#rsvp-form button[type=submit]");
  await page.waitForSelector("#ecard:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("#share-pass [data-ws-copy]")?.dataset.wsCopy.includes("abcdef12"), null, { timeout: 10000 });
  assert.equal(calls.rsvp.ref, "0a1b2c3d");
  const personal = await page.$$eval("#share-pass [data-ws-copy]", b => b.map(x => x.dataset.wsCopy));
  assert.ok(personal[0].endsWith("/w/a-and-o?ref=abcdef12"));
  assert.match(await page.textContent("#share-pass .fine"), /personal invite link/);
  await context.close();
});
