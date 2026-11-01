-- Isolated local CI only; every fixture and side effect is rolled back.
begin;

insert into auth.users(id, email, email_confirmed_at)
values ('51000000-0000-4000-8000-000000000091', 'ranked@example.test', now());
insert into public.profiles(id, display_name)
values ('51000000-0000-4000-8000-000000000091', 'Ranking fixture')
on conflict (id) do nothing;
insert into public.weddings(id, slug, client_owner_id, couple_names, currency, wedding_date, public_location)
values
  ('52000000-0000-4000-8000-000000000091', 'ranking-sponsors', '51000000-0000-4000-8000-000000000091', 'Ranking sponsors', 'KES', current_date + 30, 'Sample location'),
  ('52000000-0000-4000-8000-000000000092', 'ranking-campaign', '51000000-0000-4000-8000-000000000091', 'Ranking campaign', 'EUR', current_date + 30, 'Sample location');
insert into public.venues(wedding_id, name, event_date, event_time, address)
values
  ('52000000-0000-4000-8000-000000000091', 'Wedding venue', current_date + 30, '12:00', 'Sample address'),
  ('52000000-0000-4000-8000-000000000092', 'Wedding venue', current_date + 30, '12:00', 'Sample address');
update public.weddings set published_at = now()
where id in ('52000000-0000-4000-8000-000000000091', '52000000-0000-4000-8000-000000000092');
insert into public.wedding_memberships(wedding_id, user_id, role)
values
  ('52000000-0000-4000-8000-000000000091', '51000000-0000-4000-8000-000000000091', 'client'),
  ('52000000-0000-4000-8000-000000000092', '51000000-0000-4000-8000-000000000091', 'client')
on conflict do nothing;

alter table public.contributions disable trigger user;
insert into public.contributions(
  id, wedding_id, stream_name, pledged_amount_minor, paid_amount_minor, platform_fee_minor,
  net_paid_minor, currency, payment_status, display_name, provider_name, payment_environment,
  verified_provider_payment, paid_at, action_completed_at
) values
  ('53000000-0000-4000-8000-000000000091', '52000000-0000-4000-8000-000000000091', 'Sponsor', 50000, 50000, 0, 50000, 'KES', 'paid', 'High sponsor', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000092', '52000000-0000-4000-8000-000000000091', 'Sponsor', 10000, 10000, 0, 10000, 'KES', 'paid', 'Tie A', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000093', '52000000-0000-4000-8000-000000000091', 'Sponsor', 10000, 10000, 0, 10000, 'KES', 'paid', 'Tie B', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000094', '52000000-0000-4000-8000-000000000091', 'Sponsor', 1000000, 1000000, 0, 1000000, 'EUR', 'paid', 'Foreign sponsor', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000095', '52000000-0000-4000-8000-000000000091', 'Sponsor', 990000, 990000, 0, 990000, 'KES', 'paid', 'Unverified sponsor', 'daraja', 'live', false, now(), now()),
  ('53000000-0000-4000-8000-000000000096', '52000000-0000-4000-8000-000000000091', 'Sponsor', 999999, 999999, 0, 999999, 'KES', 'paid', 'Test sponsor', 'stripe', 'test', true, now(), now()),
  ('53000000-0000-4000-8000-000000000097', '52000000-0000-4000-8000-000000000091', 'Sponsor', 888888, 888888, 0, 0, 'KES', 'refunded', 'Refunded sponsor', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000098', '52000000-0000-4000-8000-000000000091', 'Sponsor', 777777, 777777, 0, 777777, 'KES', 'paid', 'Incomplete sponsor', 'daraja', 'live', true, now(), null),
  ('53000000-0000-4000-8000-000000000099', '52000000-0000-4000-8000-000000000092', 'Featured', 30000, 30000, 0, 30000, 'EUR', 'paid', 'Featured live', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000100', '52000000-0000-4000-8000-000000000092', 'Featured', 1000000, 1000000, 0, 1000000, 'EUR', 'paid', 'Featured test', 'stripe', 'test', true, now(), now()),
  ('53000000-0000-4000-8000-000000000101', '52000000-0000-4000-8000-000000000092', 'Featured', 900000, 900000, 0, 900000, 'EUR', 'paid', 'Featured unverified', 'daraja', 'live', false, now(), now()),
  ('53000000-0000-4000-8000-000000000102', '52000000-0000-4000-8000-000000000092', 'Song', 100, 100, 0, 100, 'KES', 'paid', 'Song KES one', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000103', '52000000-0000-4000-8000-000000000092', 'Song', 200, 200, 0, 200, 'KES', 'paid', 'Song KES two', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000104', '52000000-0000-4000-8000-000000000092', 'Song', 5000, 5000, 0, 5000, 'EUR', 'paid', 'Song EUR', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000105', '52000000-0000-4000-8000-000000000092', 'Song', 100000, 100000, 0, 100000, 'KES', 'paid', 'Test song', 'stripe', 'test', true, now(), now()),
  ('53000000-0000-4000-8000-000000000106', '52000000-0000-4000-8000-000000000092', 'Song', 100000, 100000, 0, 100000, 'KES', 'refunded', 'Refunded song', 'daraja', 'live', true, now(), now()),
  ('53000000-0000-4000-8000-000000000107', '52000000-0000-4000-8000-000000000092', 'Song', 100000, 100000, 0, 100000, 'KES', 'paid', 'Unverified song', 'daraja', 'live', false, now(), now());
alter table public.contributions enable trigger user;

insert into public.sponsor_tiers(wedding_id, name, min_amount_minor, perks)
values ('52000000-0000-4000-8000-000000000091', 'Gold package', 10000, 'Recognition and a thank-you');
alter table public.sponsors disable trigger user;
insert into public.sponsors(
  id, wedding_id, company_name, amount_minor, contribution_id, status, created_at, in_kind
) values
  ('54000000-0000-4000-8000-000000000091', '52000000-0000-4000-8000-000000000091', 'High sponsor', 50000, '53000000-0000-4000-8000-000000000091', 'active', '2026-01-05T00:00:00Z', false),
  ('54000000-0000-4000-8000-000000000092', '52000000-0000-4000-8000-000000000091', 'Tie A', 10000, '53000000-0000-4000-8000-000000000092', 'active', '2026-01-01T00:00:00Z', false),
  ('54000000-0000-4000-8000-000000000093', '52000000-0000-4000-8000-000000000091', 'Tie B', 10000, '53000000-0000-4000-8000-000000000093', 'active', '2026-01-02T00:00:00Z', false),
  ('54000000-0000-4000-8000-000000000094', '52000000-0000-4000-8000-000000000091', 'Foreign sponsor', 1000000, '53000000-0000-4000-8000-000000000094', 'active', '2026-01-01T00:00:00Z', false),
  ('54000000-0000-4000-8000-000000000095', '52000000-0000-4000-8000-000000000091', 'Unverified sponsor', 990000, '53000000-0000-4000-8000-000000000095', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000096', '52000000-0000-4000-8000-000000000091', 'Test sponsor', 999999, '53000000-0000-4000-8000-000000000096', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000097', '52000000-0000-4000-8000-000000000091', 'Refunded sponsor', 888888, '53000000-0000-4000-8000-000000000097', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000098', '52000000-0000-4000-8000-000000000091', 'Incomplete sponsor', 777777, '53000000-0000-4000-8000-000000000098', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000099', '52000000-0000-4000-8000-000000000091', 'In-kind sponsor', 1, null, 'active', '2025-01-01T00:00:00Z', true),
  ('54000000-0000-4000-8000-000000000100', '52000000-0000-4000-8000-000000000092', 'Featured live', 30000, '53000000-0000-4000-8000-000000000099', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000101', '52000000-0000-4000-8000-000000000092', 'Featured test', 1000000, '53000000-0000-4000-8000-000000000100', 'active', now(), false),
  ('54000000-0000-4000-8000-000000000102', '52000000-0000-4000-8000-000000000092', 'Featured unverified', 900000, '53000000-0000-4000-8000-000000000101', 'active', now(), false);
alter table public.sponsors enable trigger user;

insert into public.sponsor_featured_campaigns(
  wedding_id, enabled, starts_at, closes_at, slot_count, minimum_bid_minor, bid_increment_minor
) values ('52000000-0000-4000-8000-000000000092', true, now() - interval '1 day', now() + interval '1 day', 2, 1000, 100);
insert into public.sponsor_featured_bids(
  contribution_id, wedding_id, sponsor_id, campaign_id, company_name, amount_minor, currency
) values
  ('53000000-0000-4000-8000-000000000099', '52000000-0000-4000-8000-000000000092', '54000000-0000-4000-8000-000000000100', '52000000-0000-4000-8000-000000000092', 'Featured live', 30000, 'EUR'),
  ('53000000-0000-4000-8000-000000000100', '52000000-0000-4000-8000-000000000092', '54000000-0000-4000-8000-000000000101', '52000000-0000-4000-8000-000000000092', 'Featured test', 1000000, 'EUR'),
  ('53000000-0000-4000-8000-000000000101', '52000000-0000-4000-8000-000000000092', '54000000-0000-4000-8000-000000000102', '52000000-0000-4000-8000-000000000092', 'Featured unverified', 900000, 'EUR');
update public.weddings set currency = 'KES' where id = '52000000-0000-4000-8000-000000000092';

insert into public.dj_song_bids(
  id, wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, payment_status, contribution_id
) values
  ('55000000-0000-4000-8000-000000000091', '52000000-0000-4000-8000-000000000092', 'Same Song', 'Artist', 100, 'KES', 'Guest', 'paid', '53000000-0000-4000-8000-000000000102'),
  ('55000000-0000-4000-8000-000000000092', '52000000-0000-4000-8000-000000000092', 'Same Song', 'Artist', 200, 'KES', 'Guest', 'paid', '53000000-0000-4000-8000-000000000103'),
  ('55000000-0000-4000-8000-000000000093', '52000000-0000-4000-8000-000000000092', 'Same Song', 'Artist', 5000, 'EUR', 'Guest', 'paid', '53000000-0000-4000-8000-000000000104'),
  ('55000000-0000-4000-8000-000000000094', '52000000-0000-4000-8000-000000000092', 'Test Song', 'Artist', 100000, 'KES', 'Guest', 'paid', '53000000-0000-4000-8000-000000000105'),
  ('55000000-0000-4000-8000-000000000095', '52000000-0000-4000-8000-000000000092', 'Refunded Song', 'Artist', 100000, 'KES', 'Guest', 'refunded', '53000000-0000-4000-8000-000000000106'),
  ('55000000-0000-4000-8000-000000000096', '52000000-0000-4000-8000-000000000092', 'Unverified Song', 'Artist', 100000, 'KES', 'Guest', 'paid', '53000000-0000-4000-8000-000000000107'),
  ('55000000-0000-4000-8000-000000000097', '52000000-0000-4000-8000-000000000092', 'Legacy unlinked', 'Artist', 100000, 'KES', 'Guest', 'paid', null);

do $$
declare
  sponsor_payload jsonb;
  sponsor_names text[];
  auction jsonb;
  song_count integer;
begin
  sponsor_payload := public.get_public_fundraising('ranking-sponsors');
  select array_agg(item->>'company_name' order by ordinal)
    into sponsor_names
    from jsonb_array_elements(sponsor_payload->'sponsors') with ordinality as rows(item, ordinal);
  if sponsor_names <> array['High sponsor', 'Tie A', 'Tie B', 'In-kind sponsor', 'Foreign sponsor'] then
    raise exception 'Sponsor cards must rank live paid amounts within currency groups with deterministic ties: %', sponsor_names;
  end if;
  if (sponsor_payload->'sponsors'->0->>'amount_minor')::bigint <> 50000
      or sponsor_payload->'sponsors'->0->>'currency' <> 'KES'
      or (sponsor_payload->'sponsors'->4->>'amount_minor')::bigint <> 1000000
      or sponsor_payload->'sponsors'->4->>'currency' <> 'EUR' then
    raise exception 'Sponsor card amount/currency must come from the verified contribution.';
  end if;
  if sponsor_payload->'tiers'->0->>'name' <> 'Gold package' then
    raise exception 'Configured packages should remain present while cards rank by amount.';
  end if;

  auction := public.get_public_sponsor_auction('ranking-campaign');
  if auction->>'status' <> 'currency-mismatch' or auction->>'currency' <> 'EUR'
      or jsonb_array_length(auction->'leaders') <> 1
      or auction->'leaders'->0->>'company_name' <> 'Featured live'
      or (auction->'leaders'->0->>'total_minor')::bigint <> 30000 then
    raise exception 'Featured paid placements must retain their original currency and exclude test/unverified bids: %', auction;
  end if;

  select count(*) into song_count from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092');
  if song_count <> 2
      or (select bid_amount_minor from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092') where currency = 'KES') <> 300
      or (select bid_amount_minor from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092') where currency = 'EUR') <> 5000
      or exists(select 1 from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092')
        where song_title in ('Test Song', 'Refunded Song', 'Unverified Song', 'Legacy unlinked')) then
    raise exception 'Song leaderboard must exclude test/refunded/unverified/unlinked rows and separate currencies.';
  end if;
end $$;

-- A newly finalized live song bid gets an exact contribution link, without matching
-- other songs or changing provider settlement rules.
set constraints all immediate;
alter table public.contributions disable trigger guard_live_payment_context;
insert into public.contributions(
  id, wedding_id, stream_name, pledged_amount_minor, currency, payment_status, display_name,
  provider_name, payment_environment, daraja_shortcode, purchase_action, purchase_data
) values (
  '53000000-0000-4000-8000-000000000108', '52000000-0000-4000-8000-000000000092',
  'Song bid', 300, 'KES', 'pending', 'Trigger song', 'daraja', 'live', '12345',
  'song_bid', '{"songTitle":"Trigger-linked song","artist":"Trigger artist"}'
);
insert into public.dj_song_bids(
  id, wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, payment_status
) values (
  '55000000-0000-4000-8000-000000000098', '52000000-0000-4000-8000-000000000092',
  'Trigger-linked song', 'Trigger artist', 300, 'KES', 'Guest', 'paid'
);
select set_config('request.jwt.claim.role', 'service_role', true);
update public.contributions set payment_status = 'paid', paid_amount_minor = 300,
  net_paid_minor = 300, verified_provider_payment = true, paid_at = now(),
  action_completed_at = now()
where id = '53000000-0000-4000-8000-000000000108';
alter table public.contributions enable trigger guard_live_payment_context;
do $$
begin
  if not exists (select 1 from public.dj_song_bids
      where id = '55000000-0000-4000-8000-000000000098'
        and contribution_id = '53000000-0000-4000-8000-000000000108') then
    raise exception 'Verified live song bids must be linked to their contribution.';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000091', true);
select set_config('request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000091","role":"authenticated"}', true);
do $$
declare ledger_count integer;
begin
  select count(*) into ledger_count
  from public.get_dj_bid_ledger('52000000-0000-4000-8000-000000000092');
  if ledger_count <> 4 then
    raise exception 'Organizer song ledger must show only verified live linked bids, got % rows.', ledger_count;
  end if;
end $$;

rollback;
