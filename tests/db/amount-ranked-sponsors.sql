-- Isolated local CI only; every fixture and side effect is rolled back.
begin;

insert into auth.users(id, email, email_confirmed_at)
values ('51000000-0000-4000-8000-000000000091', 'ranked@example.test', now());
insert into public.profiles(id, display_name)
values ('51000000-0000-4000-8000-000000000091', 'Ranking fixture')
on conflict (id) do nothing;
insert into public.weddings(id, slug, client_owner_id, couple_names, welcome_story, cover_image_url,
  guest_instructions, currency, wedding_date, public_location)
values
  ('52000000-0000-4000-8000-000000000091', 'ranking-sponsors', '51000000-0000-4000-8000-000000000091', 'Ranking sponsors',
    'A local celebration sample.', 'https://example.test/cover.jpg', 'Please reply before the celebration.',
    'KES', current_date + 30, 'Sample location'),
  ('52000000-0000-4000-8000-000000000092', 'ranking-campaign', '51000000-0000-4000-8000-000000000091', 'Ranking campaign',
    'A local celebration sample.', 'https://example.test/cover.jpg', 'Please reply before the celebration.',
    'EUR', current_date + 30, 'Sample location');
do $$
begin
  if exists (select 1 from public.weddings
      where id in ('52000000-0000-4000-8000-000000000091','52000000-0000-4000-8000-000000000092')
        and revenue_features <> '{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}'::jsonb) then
    raise exception 'New weddings must start with all guest features visible.';
  end if;
end $$;
insert into public.venues(wedding_id, name, event_date, event_time, address)
values
  ('52000000-0000-4000-8000-000000000091', 'Wedding venue', current_date + 30, '12:00', 'Sample address'),
  ('52000000-0000-4000-8000-000000000092', 'Wedding venue', current_date + 30, '12:00', 'Sample address');
insert into public.wedding_collection_capabilities(wedding_id,provider,currency,market)
values
  ('52000000-0000-4000-8000-000000000091','daraja','KES','KE'),
  ('52000000-0000-4000-8000-000000000092','stripe','EUR','DE');
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
update public.contributions set provider_name = 'paystack',
  provider_payment_reference = case id
    when '53000000-0000-4000-8000-000000000091' then 'rank-payment-091'
    when '53000000-0000-4000-8000-000000000092' then 'rank-payment-092'
    when '53000000-0000-4000-8000-000000000093' then 'rank-payment-093'
    when '53000000-0000-4000-8000-000000000099' then 'rank-payment-099'
    when '53000000-0000-4000-8000-000000000103' then 'rank-payment-103'
    when '53000000-0000-4000-8000-000000000104' then 'rank-payment-104'
  end,
  provider_fee_pending = false, provider_fee_minor = 0, refund_fee_allocation = 'couple'
where id in (
  '53000000-0000-4000-8000-000000000091','53000000-0000-4000-8000-000000000092',
  '53000000-0000-4000-8000-000000000093','53000000-0000-4000-8000-000000000099',
  '53000000-0000-4000-8000-000000000103','53000000-0000-4000-8000-000000000104'
);
alter table public.contributions enable trigger user;

insert into public.sponsor_tiers(wedding_id, name, min_amount_minor, perks)
values ('52000000-0000-4000-8000-000000000091', 'Gold package', 10000, 'Recognition and a thank-you');
insert into public.registry_items(wedding_id, name, target_amount_minor)
values ('52000000-0000-4000-8000-000000000091', 'Honeymoon fund', 100000);
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
update public.wedding_collection_capabilities set currency = 'KES', market = 'KE', checked_at = now()
where wedding_id = '52000000-0000-4000-8000-000000000092' and provider = 'stripe' and currency = 'EUR';

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

select set_config('request.jwt.claim.role', 'service_role', true);
select public.record_provider_adjustment(
  'paystack', 'rank-event-refund-091', 'refund.processed', 'rank-refund-091',
  'rank-payment-091', 10000, 'KES', 'refund_processed', now()
);
select public.record_provider_adjustment(
  'paystack', 'rank-event-dispute-open-092', 'charge.dispute.created', 'rank-dispute-092',
  'rank-payment-092', 10000, 'KES', 'dispute_open', now()
);
select public.record_provider_adjustment(
  'paystack', 'rank-event-dispute-lost-093', 'charge.dispute.lost', 'rank-dispute-093',
  'rank-payment-093', 10000, 'KES', 'dispute_lost', now()
);
select public.record_provider_adjustment(
  'paystack', 'rank-event-refund-099', 'refund.processed', 'rank-refund-099',
  'rank-payment-099', 5000, 'EUR', 'refund_processed', now()
);
select public.record_provider_adjustment(
  'paystack', 'rank-event-refund-pending-103', 'refund.pending', 'rank-refund-103',
  'rank-payment-103', 100, 'KES', 'refund_pending', now()
);
select public.record_provider_adjustment(
  'paystack', 'rank-event-dispute-lost-104', 'charge.dispute.lost', 'rank-dispute-104',
  'rank-payment-104', 5000, 'EUR', 'dispute_lost', now()
);

do $$
declare
  sponsor_payload jsonb;
  sponsor_names text[];
  high_sponsor jsonb;
  foreign_sponsor jsonb;
  auction jsonb;
  song_count integer;
begin
  sponsor_payload := public.get_public_fundraising('ranking-sponsors');
  select array_agg(item->>'company_name' order by ordinal)
    into sponsor_names
    from jsonb_array_elements(sponsor_payload->'sponsors') with ordinality as rows(item, ordinal);
  if sponsor_names <> array['High sponsor', 'In-kind sponsor', 'Foreign sponsor'] then
    raise exception 'Refunded, open-dispute and lost-dispute sponsors must not buy display placement: %', sponsor_names;
  end if;
  select item into high_sponsor from jsonb_array_elements(sponsor_payload->'sponsors') rows(item)
    where item->>'company_name' = 'High sponsor';
  select item into foreign_sponsor from jsonb_array_elements(sponsor_payload->'sponsors') rows(item)
    where item->>'company_name' = 'Foreign sponsor';
  if high_sponsor is null or foreign_sponsor is null
      or (high_sponsor->>'amount_minor')::bigint <> 40000
      or high_sponsor->>'currency' <> 'KES'
      or (foreign_sponsor->>'amount_minor')::bigint <> 1000000
      or foreign_sponsor->>'currency' <> 'EUR' then
    raise exception 'Sponsor card amount/currency must come from the verified contribution.';
  end if;
  if sponsor_payload->'tiers'->0->>'name' <> 'Gold package' then
    raise exception 'Configured packages should remain present while cards rank by amount.';
  end if;

  auction := public.get_public_sponsor_auction('ranking-campaign');
  if auction->>'status' <> 'currency-mismatch' or auction->>'currency' <> 'EUR'
      or jsonb_array_length(auction->'leaders') <> 1
      or auction->'leaders'->0->>'company_name' <> 'Featured live'
      or (auction->'leaders'->0->>'total_minor')::bigint <> 25000 then
    raise exception 'Featured placement totals must net processed refunds and exclude test/unverified bids: %', auction;
  end if;

  select count(*) into song_count from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092');
  if song_count <> 1
      or (select bid_amount_minor from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092') where currency = 'KES') <> 200
      or exists(select 1 from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092') where currency = 'EUR')
      or exists(select 1 from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092')
        where song_title in ('Test Song', 'Refunded Song', 'Unverified Song', 'Legacy unlinked')) then
    raise exception 'Song leaderboard must net pending refunds, exclude disputes/test/unverified/unlinked rows and separate currencies.';
  end if;
end $$;

select set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000091', true);
select set_config('request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000091","role":"authenticated"}', true);
select public.save_wedding_content(
  '52000000-0000-4000-8000-000000000091',
  '{"revenue_features":{"giving":false,"sponsors":false,"featured_sponsors":false,"song_requests":false,"vip_seating":false}}',
  null, null, null
);
select public.save_wedding_content(
  '52000000-0000-4000-8000-000000000092',
  '{"revenue_features":{"giving":false,"sponsors":false,"featured_sponsors":false,"song_requests":false,"vip_seating":false}}',
  null, null, null
);
do $$
declare hidden_fundraising jsonb; hidden_site jsonb; hidden_auction jsonb; hidden_songs integer;
begin
  hidden_fundraising := public.get_public_fundraising('ranking-sponsors');
  hidden_site := public.get_public_wedding_site('ranking-sponsors');
  hidden_auction := public.get_public_sponsor_auction('ranking-campaign');
  select count(*) into hidden_songs
    from public.get_dj_leaderboard('52000000-0000-4000-8000-000000000092');
  if jsonb_array_length(hidden_fundraising->'tiers') <> 0
      or jsonb_array_length(hidden_fundraising->'sponsors') <> 0
      or jsonb_array_length(hidden_site->'registry') <> 0
      or hidden_auction->>'enabled' <> 'false' or hidden_songs <> 0 then
    raise exception 'Persisted feature opt-outs must hide public offers and projections.';
  end if;
end $$;
select public.save_wedding_content(
  '52000000-0000-4000-8000-000000000091',
  '{"revenue_features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}}',
  null, null, null
);
select public.save_wedding_content(
  '52000000-0000-4000-8000-000000000092',
  '{"revenue_features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}}',
  null, null, null
);

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
select set_config('request.jwt.claim.role', 'service_role', true);
update public.contributions set payment_status = 'paid', paid_amount_minor = 300,
  net_paid_minor = 300, verified_provider_payment = true, paid_at = now()
where id = '53000000-0000-4000-8000-000000000108';
alter table public.contributions enable trigger guard_live_payment_context;
do $$
begin
  if not exists (select 1 from public.dj_song_bids
      where wedding_id = '52000000-0000-4000-8000-000000000092'
        and song_title = 'Trigger-linked song' and artist_name = 'Trigger artist'
        and contribution_id = '53000000-0000-4000-8000-000000000108')
      or not exists (select 1 from public.contributions
        where id = '53000000-0000-4000-8000-000000000108'
          and action_completed_at is not null) then
    raise exception 'The BEFORE finalizer must create and complete a live song bid before the AFTER trigger links it.';
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
  if ledger_count <> 3 then
    raise exception 'Organizer song ledger must show only verified live linked bids, got % rows.', ledger_count;
  end if;
end $$;

rollback;
