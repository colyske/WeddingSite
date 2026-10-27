import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("RSVP captures phone, stores it privately and supports lookup", () => {
  const guest = readFileSync("guest.html", "utf8");
  const api = readFileSync("api/guest.js", "utf8");
  const org = readFileSync("api/weddings.js", "utf8");
  assert.match(guest, /id="guest-phone"/);
  assert.match(guest, /guestPhone:/);
  assert.match(api, /function normPhone/);
  assert.match(api, /phone=eq\./);
  assert.match(org, /guest_email,phone/);
  assert.doesNotMatch(api.split('action === "wedding"')[1] || "", /guest_phone/);
});

test("every page loads shared submit feedback", () => {
  for (const p of ["guest", "dashboard", "wedding", "account", "admin", "owner", "signin"]) {
    assert.match(readFileSync(`${p}.html`, "utf8"), /feedback\.js/, p);
  }
});
test("sponsor tiers never send empty perks (DB check requires 1-240 chars)", () => {
  const src = readFileSync("api/weddings.js", "utf8");
  assert.equal((src.match(/Recognised as a supporter/g) || []).length, 2);
  assert.match(readFileSync("wedding.html", "utf8"), /pattern="\[a-z0-9\\-\]\+"/);
});
