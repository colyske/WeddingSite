import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/202610300003_featured_sponsor_campaigns.sql", "utf8");
const rankingMigration = readFileSync("supabase/migrations/202611060001_amount_ranked_sponsors.sql", "utf8");
const checkout = readFileSync("api/checkout.js", "utf8");
const weddings = readFileSync("api/weddings.js", "utf8");
const guest = readFileSync("guest.html", "utf8");
const editor = readFileSync("wedding.html", "utf8");

test("featured campaign writes require organizer access and bound terms", () => {
  const save = migration.split("create or replace function public.save_sponsor_featured_campaign")[1]
    .split("revoke all on function public.save_sponsor_featured_campaign")[0];
  assert.match(save, /has_wedding_role\(p_wedding_id/i);
  assert.match(save, /v_slots not between 1 and 20/i);
  assert.match(save, /v_close <= v_start/i);
  assert.match(save, /Campaign terms cannot change after a paid bid/i);
});

test("featured bids are counted only after verified payment and are idempotent per contribution", () => {
  const finalize = rankingMigration.split("create or replace function public.finalize_featured_sponsor_bid")[1]
    .split("revoke all on function public.finalize_featured_sponsor_bid")[0];
  assert.match(finalize, /not new\.verified_provider_payment/i);
  assert.match(finalize, /new\.payment_environment <> 'live'/i);
  assert.match(finalize, /new\.currency is distinct from campaign\.currency/i);
  assert.match(finalize, /sponsor_featured_bids/);
  assert.match(finalize, /new\.paid_at < campaign\.starts_at/);
  assert.match(finalize, /payment_action_reviews/);
  assert.match(migration, /contribution_id uuid primary key references public\.contributions\(id\)/);
});

test("featured checkout enforces active window and server-computed minimum", () => {
  assert.match(checkout, /get_public_sponsor_auction/);
  assert.match(checkout, /auction\.status !== "open"/);
  assert.match(checkout, /requestedAmount < Number\(auction\.next_bid_minor\)/);
  assert.match(checkout, /minimumBidAtCheckout: Number\(auction\.next_bid_minor\)/);
  assert.match(checkout, /auction\?\.currency && auction\.currency !== currency/);
  assert.match(weddings, /save_sponsor_featured_campaign/);
});

test("organizer and guest interfaces expose campaign terms and verified ranking", () => {
  assert.match(editor, /featured-sponsor-enabled/);
  assert.match(editor, /featured-sponsor-closes/);
  assert.match(guest, /Current leader|Featured sponsor/);
  assert.match(guest, /data-buy="sponsor_featured_bid"/);
  assert.match(guest, /verified paid bids/);
});

test("sponsor cards rank by verified paid amount inside currency groups, independent of packages", () => {
  assert.match(rankingMigration, /c\.payment_environment = 'live'/);
  assert.match(rankingMigration, /c\.payment_status = 'paid' and c\.verified_provider_payment/);
  assert.match(rankingMigration, /c\.paid_amount_minor desc nulls last,\s+s\.created_at asc, s\.id/);
  assert.match(rankingMigration, /coalesce\(c\.currency, w\.currency\)/);
  assert.match(guest, /Sponsors supporting in \$\{esc\(currency\)\}/);
  assert.match(guest, /larger contributions appear higher/);
});

test("song leaderboard and organizer rows require a unique verified live contribution", () => {
  assert.match(rankingMigration, /add column if not exists contribution_id uuid references public\.contributions\(id\)/);
  assert.match(rankingMigration, /bid_match_count = 1 and contribution_match_count = 1/);
  assert.match(rankingMigration, /create trigger link_verified_dj_song_bid after update of payment_status/);
  assert.match(rankingMigration, /c\.payment_environment = 'live' and c\.action_completed_at is not null/);
  assert.match(weddings, /rpc\/get_dj_bid_ledger/);
  assert.match(guest, /WS\.money\(b\.bid_amount_minor, b\.currency \|\| wedding\.currency\)/);
});
