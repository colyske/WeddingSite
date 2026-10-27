import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const mig = readdirSync("supabase/migrations").find(f => f.includes("fundraising_campaigns"));
const sql = readFileSync(`supabase/migrations/${mig}`, "utf8");

test("campaign migration is idempotent and keeps money rows safe", () => {
  assert.match(sql, /create table if not exists public\.fundraising_milestones/);
  assert.match(sql, /add column if not exists stream_id/);
  assert.match(sql, /add column if not exists milestone_id/);
  assert.match(sql, /enabled = false where wedding_id/); // removed campaigns are disabled, not deleted
  assert.doesNotMatch(sql, /delete from public\.(fundraising_streams|contributions)/);
  for (const fn of ["save_fundraising_campaigns", "get_campaign_ledger", "record_test_campaign_pledge"]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`));
  }
});

test("public campaign data exposes no donor details", () => {
  const pub = sql.split("get_public_campaigns")[1].split("get_campaign_ledger")[0];
  assert.doesNotMatch(pub, /display_name|email|phone/);
});

test("organizer, guest and payment APIs are wired for campaigns", () => {
  assert.match(readFileSync("api/weddings.js", "utf8"), /action === "campaigns-save"/);
  assert.match(readFileSync("api/guest.js", "utf8"), /get_public_campaigns/);
  assert.match(readFileSync("api/testpay.js", "utf8"), /record_test_campaign_pledge/);
  const guest = readFileSync("guest.html", "utf8");
  assert.match(guest, /id="campaigns-display"/);
  assert.match(guest, /data-buy="fund"/);
  assert.match(readFileSync("wedding.html", "utf8"), /id="campaign-ledger"/);
});
