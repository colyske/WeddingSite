import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../api/guest.js";

const call = query => new Promise(resolve => {
  const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; return this; }, end(b) { resolve({ status: this.code, body: b }); } };
  handler({ method: "GET", query, headers: {}, socket: {} }, res);
});

test("seating lookup rejects bad slug and missing phone before touching the database", async () => {
  assert.equal((await call({ action: "seating", slug: "x", phone: "0712345678" })).status, 404);
  assert.equal((await call({ action: "seating", slug: "some-wedding", phone: "nope" })).status, 400);
});

test("seating lookup only returns the caller's own table, matched by phone", () => {
  const src = readFileSync("api/guest.js", "utf8").split('action === "seating"')[1].split('action === "pass-lookup"')[0];
  assert.match(src, /phone=/);
  assert.match(src, /select=name,table_number&limit=1/);
  assert.match(src, /limited\(/);
});

test("group RSVP stores party names for organizers and migration is idempotent", () => {
  const sql = readFileSync("supabase/migrations/202610290005_group_rsvp.sql", "utf8");
  assert.match(sql, /add column if not exists party_names/);
  assert.match(readFileSync("api/guest.js", "utf8"), /party_names: partyNames/);
  assert.match(readFileSync("api/weddings.js", "utf8"), /plus_one_count,party_names/);
  const g = readFileSync("guest.html", "utf8");
  assert.match(g, /id="party-names"/);
  assert.match(g, /partyNames: \$\("party-names"\)\.value/);
});

test("Swahili toggle is wired and translates section headings", () => {
  const g = readFileSync("guest.html", "utf8");
  assert.match(g, /id="lang-toggle"/);
  assert.match(g, /src="i18n\.js"/);
  const i = readFileSync("i18n.js", "utf8");
  assert.match(i, /Utahudhuria/);
  assert.match(i, /ws-lang/);
});
