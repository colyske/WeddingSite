import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import "../tz.js";

const T = globalThis.WSTime;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Nairobi wall-clock time converts to UTC and is labelled EAT", () => {
  const ms = T.zonedToUtc("2026-12-12", "14:00", "Africa/Nairobi");
  assert.equal(new Date(ms).toISOString(), "2026-12-12T11:00:00.000Z");
  assert.equal(T.formatTime(ms, "Africa/Nairobi"), "2:00 PM EAT");
  assert.equal(T.formatDate(ms, "Africa/Nairobi"), "Saturday, December 12, 2026");
});

test("same wall-clock time yields different instants in different zones", () => {
  const nairobi = T.zonedToUtc("2026-12-12", "10:00", "Africa/Nairobi");
  const ny = T.zonedToUtc("2026-12-12", "10:00", "America/New_York");
  assert.equal(new Date(ny).toISOString(), "2026-12-12T15:00:00.000Z");
  assert.equal(ny - nairobi, 8 * 3600000);
  assert.equal(new Date(T.zonedToUtc("2026-12-12", "10:00", "Australia/Sydney")).toISOString(), "2026-12-11T23:00:00.000Z");
  assert.equal(new Date(T.zonedToUtc("2026-12-12", "10:00", "Asia/Kolkata")).toISOString(), "2026-12-12T04:30:00.000Z");
});

test("DST: offsets differ across the year and gap/overlap times resolve to a real instant", () => {
  assert.equal(new Date(T.zonedToUtc("2026-07-01", "12:00", "America/New_York")).toISOString(), "2026-07-01T16:00:00.000Z");
  assert.equal(new Date(T.zonedToUtc("2026-01-15", "12:00", "America/New_York")).toISOString(), "2026-01-15T17:00:00.000Z");
  const gap = T.zonedToUtc("2026-03-08", "02:30", "America/New_York");
  assert.ok(["2026-03-08T07:30:00.000Z", "2026-03-08T06:30:00.000Z"].includes(new Date(gap).toISOString()));
  const overlap = T.zonedToUtc("2026-11-01", "01:30", "America/New_York");
  assert.ok(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"].includes(new Date(overlap).toISOString()));
  assert.equal(new Date(T.zonedToUtc("2026-11-01", "12:00", "America/New_York")).toISOString(), "2026-11-01T17:00:00.000Z");
});

test("date-line and half-hour zones keep the right calendar day", () => {
  const ms = T.zonedToUtc("2026-12-12", "00:30", "Pacific/Kiritimati");
  assert.equal(new Date(ms).toISOString(), "2026-12-11T10:30:00.000Z");
  assert.equal(T.formatDate(ms, "Pacific/Kiritimati"), "Saturday, December 12, 2026");
  assert.equal(T.formatDate(ms, "UTC"), "Friday, December 11, 2026");
});

test("zone validation rejects junk and defaults sensibly", () => {
  assert.ok(T.validZone("Africa/Nairobi"));
  assert.ok(T.validZone("UTC"));
  for (const bad of ["", "Mars/Olympus", "x".repeat(70), null, undefined, "Africa/Nairobi; drop table"]) assert.equal(T.validZone(bad), false);
  assert.equal(T.zonedToUtc("2026-12-12", "10:00", "Mars/Olympus"), T.zonedToUtc("2026-12-12", "10:00", "Africa/Nairobi"));
  assert.equal(T.zoneList()[0], "Africa/Nairobi");
  assert.ok(T.validZone(T.browserZone()));
});

test("wedding start uses the main venue time and the wedding zone; missing time means midnight", () => {
  const wedding = { wedding_date: "2026-12-12", time_zone: "Africa/Nairobi", venues: [{ event_time: "16:00:00" }, { event_time: "10:00:00", is_main: true }] };
  assert.equal(new Date(T.weddingStart(wedding)).toISOString(), "2026-12-12T07:00:00.000Z");
  assert.equal(new Date(T.weddingStart({ wedding_date: "2026-12-12", venues: [] })).toISOString(), "2026-12-11T21:00:00.000Z");
  assert.equal(T.weddingStart({ venues: [] }), null);
});

test(".ics export uses correct UTC conversion, escapes text and records the zone", () => {
  const ics = T.buildIcs({ id: "abc", couple_names: "Atieno & Otieno", public_location: "Karen, Nairobi", welcome_story: "Join us; bring joy",
    wedding_date: "2026-12-12", time_zone: "Africa/Nairobi", venues: [{ event_time: "14:00:00", is_main: true }] }, Date.UTC(2026, 0, 1));
  assert.match(ics, /DTSTART:20261212T110000Z/);
  assert.match(ics, /DTSTAMP:20260101T000000Z/);
  assert.match(ics, /X-WR-TIMEZONE:Africa\/Nairobi/);
  assert.match(ics, /SUMMARY:Atieno & Otieno's Wedding/);
  assert.match(ics, /LOCATION:Karen\\, Nairobi/);
  assert.match(ics, /\(2:00 PM EAT\)/);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.equal(T.buildIcs({ venues: [] }), null);
});

test("time zone migration is additive, idempotent and defaults existing weddings to Nairobi", async () => {
  const sql = await readFile(join(root, "supabase/migrations/202610270002_wedding_time_zone.sql"), "utf8");
  assert.match(sql, /add column if not exists time_zone text not null default 'Africa\/Nairobi'/i);
  assert.match(sql, /if not exists \(select 1 from pg_constraint/i);
  assert.match(sql, /create or replace function public\.get_public_wedding_site/i);
  assert.match(sql, /'time_zone', w\.time_zone/);
  assert.doesNotMatch(sql, /drop (table|column)/i);
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://x").pathname.slice(1) || "index.html";
    if (name.includes("..")) throw new Error("bad");
    const body = await readFile(join(root, name));
    res.writeHead(200, { "Content-Type": types[extname(name)] || "text/plain" }).end(body);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
for (const o of [{ channel: "msedge" }, {}]) { try { browser = await chromium.launch(o); break; } catch { /* next */ } }
const skip = browser ? false : "No Chromium/Edge is installed.";
test.after(async () => { await browser?.close(); server.close(); });

test("share panel: copy shows 'Link copied', fallback copy works, WhatsApp/Open links and navigator.share", { skip }, async () => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto(`${base}/signin.html`);
  await page.addScriptTag({ url: "/share.js" });
  const url = await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<div id="host">${WSShare.panelHTML(WSShare.guestUrl("atieno-and-otieno"), { title: "Atieno & Otieno", published: false })}</div>`);
    return WSShare.guestUrl("atieno-and-otieno");
  });
  assert.match(url, /\/guest\.html\?slug=atieno-and-otieno$/);
  assert.equal(await page.inputValue(".ws-share-url"), url);
  assert.match(await page.textContent(".ws-share-note"), /Not published yet/);
  assert.equal(await page.getAttribute("[data-ws-open]", "href"), url);
  const wa = await page.getAttribute("[data-ws-whatsapp]", "href");
  assert.ok(wa.startsWith("https://wa.me/?text="));
  assert.ok(decodeURIComponent(wa).includes("Atieno & Otieno - " + url));
  await page.click("[data-ws-copy]");
  await page.waitForFunction(() => document.getElementById("ws-toast")?.textContent === "Link copied");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);

  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); document.getElementById("ws-toast").textContent = ""; });
  await page.click("[data-ws-copy]");
  await page.waitForFunction(() => /Link copied|Could not copy/.test(document.getElementById("ws-toast").textContent));

  await page.evaluate(() => { window.__shared = null; navigator.share = async d => { window.__shared = d; }; });
  await page.click("[data-ws-share]");
  const shared = await page.evaluate(() => window.__shared);
  assert.equal(shared.url, url);
  assert.equal(shared.title, "Atieno & Otieno");
  await context.close();
});

test("guest site shows zone-labelled time, promo footer; calendar download is UTC-correct", { skip }, async () => {
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "a-and-o", couple_names: "Atieno & Otieno", welcome_story: "Hi", wedding_date: "2099-12-12",
    time_zone: "Africa/Nairobi", public_location: "Nairobi", currency: "KES", max_guest_capacity: 100, palette: ["#244b3a", "#be9b52", "#a9b5a2"],
    venues: [{ id: "1", name: "Chapel", event_time: "14:00:00", is_main: true }], registry: [], accepting_rsvps: true };
  await page.route("**/api/**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(r.request().url().includes("action=wedding") || r.request().url().includes("action=get") ? wedding : { wedding, bids: [], leaderboard: [] }) }));
  await page.route("**/cdnjs.cloudflare.com/**", r => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.goto(`${base}/guest.html?slug=a-and-o`);
  await page.waitForFunction(() => /2:00 PM EAT/.test(document.getElementById("wedding-date-display").textContent), null, { timeout: 15000 });
  assert.match(await page.textContent("#wedding-date-display"), /Saturday, December 12, 2099 · 2:00 PM EAT/);
  assert.match(await page.textContent("footer.ws-promo"), /Create your wedding site with WeddingSite/);
  assert.match(await page.textContent("footer.ws-promo"), /Made with (love on )?WeddingSite/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#ics-download")]);
  const content = await readFile(await download.path(), "utf8");
  assert.match(content, /DTSTART:20991212T110000Z/);
  await context.close();
});
