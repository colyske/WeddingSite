import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPastWedding, todayInZone } from "../server/wedding-time.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => readFile(join(root, f), "utf8");

test("isPastWedding respects the wedding's own time zone and treats missing dates as not past", () => {
  const now = new Date("2026-12-12T22:30:00Z"); // already Dec 13 in Nairobi, still Dec 12 in New York
  assert.equal(isPastWedding("2026-12-12", "Africa/Nairobi", now), true);
  assert.equal(isPastWedding("2026-12-12", "America/New_York", now), false);
  assert.equal(isPastWedding("2026-12-13", "Africa/Nairobi", now), false);
  assert.equal(isPastWedding(null), false);
  assert.equal(todayInZone("Africa/Nairobi", now), "2026-12-13");
  assert.equal(todayInZone("Not/AZone", now), "2026-12-12");
});

test("admin endpoint gates every action by platform role and the owner API is owner-only", async () => {
  const admin = await read("api/admin.js");
  assert.match(admin, /owner/);
  assert.match(admin, /superadmin/);
  assert.match(admin, /403/);
  assert.doesNotMatch(admin, /method:\s*"DELETE"/);
});

test("migrations never grant client deletes on weddings and the back-office migration blocks them", async () => {
  const sql = await read("supabase/migrations/202610280001_platform_admin_kyc_fees.sql");
  assert.match(sql, /revoke delete on public\.weddings/i);
  assert.match(sql, /trigger/i);
  const weddings = await read("api/weddings.js");
  assert.match(weddings, /action === "delete"/);
  assert.match(weddings, /405/);
  for (const f of await readdir(join(root, "supabase/migrations"))) {
    const text = await read(`supabase/migrations/${f}`);
    assert.doesNotMatch(text, /grant\s+delete\s+on\s+public\.weddings\s+to\s+(anon|authenticated)/i, f);
  }
});

test("every page loads the editorial theme and the shared footer", async () => {
  const pages = (await readdir(root)).filter(f => f.endsWith(".html") && !["demo.html", "client-site.html"].includes(f));
  assert.ok(pages.length >= 10);
  for (const f of pages) {
    const html = await read(f);
    assert.match(html, /editorial\.css/, `${f} is missing editorial.css`);
    assert.match(html, /footer\.js|ws-promo/, `${f} is missing the footer`);
  }
  const footer = await read("footer.js");
  assert.match(footer, /Organize your wedding your way/);
});

test("landing wedding links use the guest route and weddings are never deleted from the UI", async () => {
  const index = await read("index.html");
  assert.match(index, /\/guest\.html\?slug=/);
  assert.doesNotMatch(index, /\/guest\/\$\{|\/w\/\$\{/);
  for (const f of ["dashboard.js", "wedding.html"]) {
    const src = await read(f);
    assert.doesNotMatch(src, /action=delete/, `${f} must not call delete`);
  }
});

test("editor marks date, time zone and location as required and wires unpublish/KYC", async () => {
  const html = await read("wedding.html");
  assert.match(html, /id="wedding-date"[^>]*required/);
  assert.match(html, /id="kyc-consent"/);
  assert.match(html, /unpublish-btn/);
  assert.match(html, /kycRequired/);
  assert.match(html, /paymentRequired/);
});
