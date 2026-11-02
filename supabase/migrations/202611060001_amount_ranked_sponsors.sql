alter table public.sponsor_featured_campaigns
  add column if not exists currency char(3);

do $$
begin
  if exists (
    select b.campaign_id
    from public.sponsor_featured_bids b
    group by b.campaign_id
    having count(distinct b.currency) > 1
  ) then
    raise exception 'Featured sponsor bids use multiple currencies; review existing placements before continuing.';
  end if;
end $$;

update public.sponsor_featured_campaigns campaign
set currency = coalesce(
  (select min(b.currency) from public.sponsor_featured_bids b where b.campaign_id = campaign.wedding_id),
  (select w.currency from public.weddings w where w.id = campaign.wedding_id)
)
where currency is null;

alter table public.sponsor_featured_campaigns
  alter column currency set not null;
alter table public.sponsor_featured_campaigns
  add constraint sponsor_featured_campaigns_currency_check check (currency ~ '^[A-Z]{3}$');

create or replace function public.set_sponsor_featured_campaign_currency()
returns trigger language plpgsql set search_path = '' as $$
declare wedding_currency char(3);
begin
  select w.currency into wedding_currency from public.weddings w where w.id = new.wedding_id;
  if wedding_currency is null then raise exception 'Wedding currency is unavailable.'; end if;
  if tg_op = 'UPDATE' and exists (
    select 1 from public.sponsor_featured_bids b where b.campaign_id = old.wedding_id
  ) then
    new.currency := old.currency;
  else
    new.currency := wedding_currency;
  end if;
  return new;
end $$;
revoke all on function public.set_sponsor_featured_campaign_currency() from public, anon, authenticated;

create trigger set_sponsor_featured_campaign_currency
before insert or update on public.sponsor_featured_campaigns
for each row execute function public.set_sponsor_featured_campaign_currency();

create or replace function public.get_public_fundraising(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tiers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'min_amount_minor', t.min_amount_minor, 'perks', t.perks
    ) order by t.sort_order, t.created_at) from public.sponsor_tiers t where t.wedding_id = w.id), '[]'::jsonb),
    'vip', (select jsonb_build_object('id', v.id, 'title', v.title, 'description', v.description,
      'seats_total', v.seats_total, 'seats_sold', (select count(*) from public.vip_reservations vr
        join public.contributions c on c.id = vr.contribution_id
        where vr.vip_offer_id = v.id and vr.payment_status = 'paid'
          and c.payment_status = 'paid' and c.verified_provider_payment),
      'price_minor', v.price_minor)
      from public.vip_offers v where v.wedding_id = w.id limit 1),
    'sponsors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'company_name', s.company_name, 'location', s.location, 'offer', s.offer,
      'website', s.website, 'social_links', s.social_links, 'amount_minor', coalesce(c.paid_amount_minor, s.amount_minor),
      'currency', coalesce(c.currency, w.currency), 'in_kind', s.in_kind, 'public_contact', s.public_contact,
      'contact_email', case when s.public_contact then s.contact_email else null end,
      'contact_phone', case when s.public_contact then s.contact_phone else null end
    ) order by
      case when coalesce(c.currency, w.currency) = w.currency then 0 else 1 end,
      coalesce(c.currency, w.currency),
      c.paid_amount_minor desc nulls last,
      s.created_at asc, s.id)
      from public.sponsors s
      left join public.contributions c on c.id = s.contribution_id
      where s.wedding_id = w.id and s.status = 'active'
        and (s.in_kind and s.contribution_id is null or
          c.payment_status = 'paid' and c.verified_provider_payment
            and c.payment_environment = 'live' and c.action_completed_at is not null)), '[]'::jsonb)
  ) from public.weddings w
  where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
revoke all on function public.get_public_fundraising(text) from public;
grant execute on function public.get_public_fundraising(text) to anon, authenticated;

create or replace function public.get_public_sponsor_auction(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare
  v_wedding public.weddings;
  v_campaign public.sponsor_featured_campaigns;
  v_leaders jsonb;
  v_next bigint;
begin
  select * into v_wedding from public.weddings w
    where w.slug = p_slug and w.published_at is not null and w.archived_at is null;
  if not found then return null; end if;
  select * into v_campaign from public.sponsor_featured_campaigns c where c.wedding_id = v_wedding.id;
  if not found or not v_campaign.enabled then return jsonb_build_object('enabled', false); end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.total_minor desc, lower(r.company_name), r.company_name), '[]'::jsonb)
    into v_leaders
  from (
    select min(b.company_name) as company_name, sum(b.amount_minor)::bigint as total_minor,
      count(*)::integer as bid_count, b.currency::text as currency
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and b.currency = v_campaign.currency and c.currency = b.currency
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
    group by lower(b.company_name), b.currency
    order by sum(b.amount_minor) desc, lower(b.company_name), min(b.company_name)
    limit 20
  ) r;
  select coalesce(max(t.total_minor), 0) + v_campaign.bid_increment_minor
    into v_next
  from (
    select lower(b.company_name) company_key, sum(b.amount_minor)::bigint total_minor
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and b.currency = v_campaign.currency and c.currency = b.currency
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
    group by lower(b.company_name)
  ) t;
  return jsonb_build_object(
    'enabled', true, 'currency', v_campaign.currency,
    'status', case when v_wedding.currency <> v_campaign.currency then 'currency-mismatch'
      when now() < v_campaign.starts_at then 'scheduled'
      when now() < v_campaign.closes_at then 'open' else 'closed' end,
    'starts_at', v_campaign.starts_at, 'closes_at', v_campaign.closes_at,
    'slot_count', v_campaign.slot_count, 'minimum_bid_minor', v_campaign.minimum_bid_minor,
    'bid_increment_minor', v_campaign.bid_increment_minor,
    'next_bid_minor', greatest(v_campaign.minimum_bid_minor, v_next),
    'leaders', v_leaders
  );
end $$;
revoke all on function public.get_public_sponsor_auction(text) from public;
grant execute on function public.get_public_sponsor_auction(text) to anon, authenticated;

create or replace function public.finalize_featured_sponsor_bid()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  d jsonb := coalesce(new.purchase_data, '{}'::jsonb);
  campaign public.sponsor_featured_campaigns;
  sponsor_id uuid;
  company text := left(trim(coalesce(d->>'companyName', '')), 100);
  quoted_minimum bigint := nullif(d->>'minimumBidAtCheckout', '')::bigint;
  current_currency char(3);
  review_reason text;
begin
  if new.payment_status <> 'paid' or new.purchase_action <> 'sponsor_featured_bid' then return new; end if;
  if not new.verified_provider_payment or new.payment_environment <> 'live' then
    review_reason := case when new.payment_environment = 'test'
      then 'sponsor_featured_bid_test_payment' else 'sponsor_featured_bid_unverified_payment' end;
    update public.contributions set action_completed_at = null,
      action_result = jsonb_build_object('completed', false, 'status', 'review_required')
      where id = new.id;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, review_reason)
      on conflict (contribution_id) do nothing;
    return new;
  end if;

  select w.currency into current_currency from public.weddings w where w.id = new.wedding_id;
  select * into campaign from public.sponsor_featured_campaigns
    where wedding_id = new.wedding_id and enabled for update;
  if not found or new.paid_at < campaign.starts_at or new.paid_at > campaign.closes_at
      or company = '' then
    review_reason := 'sponsor_featured_bid_review_required';
  elsif new.currency is distinct from campaign.currency
      or current_currency is distinct from campaign.currency then
    review_reason := 'sponsor_featured_bid_currency_changed';
  elsif quoted_minimum is null or quoted_minimum < campaign.minimum_bid_minor
      or new.paid_amount_minor < quoted_minimum then
    review_reason := 'sponsor_featured_bid_increment_changed';
  end if;
  if review_reason is not null then
    update public.contributions set action_completed_at = null,
      action_result = jsonb_build_object('completed', false, 'status', 'review_required')
      where id = new.id;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, review_reason)
      on conflict (contribution_id) do nothing;
    return new;
  end if;

  insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, website, amount_minor,
    contribution_id, location, offer, public_contact, status)
  values (new.wedding_id, company, nullif(left(d->>'email', 200), ''),
    nullif(left(d->>'phone', 30), ''), nullif(left(d->>'website', 300), ''),
    new.paid_amount_minor, new.id, nullif(left(trim(d->>'location'), 160), ''),
    nullif(left(trim(d->>'offer'), 360), ''), coalesce((d->>'publicContact')::boolean, false), 'active')
  returning id into sponsor_id;
  insert into public.sponsor_featured_bids (
    contribution_id, wedding_id, sponsor_id, campaign_id, company_name, amount_minor, currency
  ) values (new.id, new.wedding_id, sponsor_id, new.wedding_id, company, new.paid_amount_minor, new.currency);
  update public.contributions set action_result = jsonb_build_object(
    'completed', true, 'kind', 'sponsor_featured_bid', 'sponsorId', sponsor_id)
    where id = new.id;
  return new;
exception when others then
  update public.contributions set action_completed_at = null,
    action_result = jsonb_build_object('completed', false, 'status', 'review_required')
    where id = new.id;
  insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
    values (new.id, new.wedding_id, 'sponsor_featured_bid_finalize_failed')
    on conflict (contribution_id) do nothing;
  return new;
end $$;
revoke all on function public.finalize_featured_sponsor_bid() from public, anon, authenticated;

alter table public.dj_song_bids
  add column if not exists contribution_id uuid references public.contributions(id) on delete restrict,
  add column if not exists creation_xid xid8 not null default pg_current_xact_id();
create unique index if not exists dj_song_bids_contribution_id_uidx
  on public.dj_song_bids(contribution_id) where contribution_id is not null;

with matches as (
  select b.id as bid_id, c.id as contribution_id,
    count(*) over (partition by b.id) as bid_match_count,
    count(*) over (partition by c.id) as contribution_match_count
  from public.dj_song_bids b
  join public.contributions c
    on c.wedding_id = b.wedding_id and c.purchase_action = 'song_bid'
    and c.payment_status = 'paid' and c.verified_provider_payment
    and c.payment_environment = 'live' and c.action_completed_at is not null
    and c.currency = b.currency and c.paid_amount_minor = b.bid_amount_minor
    and lower(trim(coalesce(c.purchase_data->>'songTitle', ''))) = lower(trim(b.song_title))
    and lower(trim(coalesce(c.purchase_data->>'artist', ''))) = lower(trim(b.artist_name))
  where b.contribution_id is null and b.payment_status = 'paid'
), unique_matches as (
  select bid_id, contribution_id from matches
  where bid_match_count = 1 and contribution_match_count = 1
)
update public.dj_song_bids b set contribution_id = m.contribution_id
from unique_matches m where b.id = m.bid_id;

create or replace function public.link_verified_dj_song_bid()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  match_count integer;
  bid_id uuid;
begin
  if new.payment_status <> 'paid' or not new.verified_provider_payment
      or new.payment_environment <> 'live' or new.action_completed_at is null
      or new.purchase_action <> 'song_bid' then return new; end if;
  select count(*)::integer, (array_agg(b.id))[1] into match_count, bid_id
  from public.dj_song_bids b
  where b.creation_xid = pg_current_xact_id()
    and b.contribution_id is null and b.wedding_id = new.wedding_id
    and b.payment_status = 'paid' and b.currency = new.currency
    and b.bid_amount_minor = new.paid_amount_minor
    and lower(trim(b.song_title)) = lower(trim(coalesce(new.purchase_data->>'songTitle', '')))
    and lower(trim(b.artist_name)) = lower(trim(coalesce(new.purchase_data->>'artist', '')));
  if match_count = 1 then
    update public.dj_song_bids set contribution_id = new.id where id = bid_id;
  end if;
  return new;
end $$;
revoke all on function public.link_verified_dj_song_bid() from public, anon, authenticated;
drop trigger if exists link_verified_dj_song_bid on public.contributions;
create trigger link_verified_dj_song_bid after update of payment_status on public.contributions
  for each row execute function public.link_verified_dj_song_bid();

drop function if exists public.get_dj_leaderboard(uuid);
create function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, bid_count bigint, currency char(3))
language sql stable security definer set search_path = '' set row_security = off
as $$
  with totals as (
    select min(b.song_title) as song_title, min(b.artist_name) as artist_name,
      sum(b.bid_amount_minor)::bigint as bid_amount_minor, b.currency,
      count(*)::bigint as bid_count, lower(trim(b.song_title)) as title_key,
      lower(trim(b.artist_name)) as artist_key
    from public.dj_song_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and c.currency = b.currency and public.is_published_wedding(p_wedding_id)
    group by lower(trim(b.song_title)), lower(trim(b.artist_name)), b.currency
  )
  select row_number() over (partition by t.currency
      order by t.bid_amount_minor desc, t.title_key, t.artist_key)::integer,
    t.song_title, t.artist_name, t.bid_amount_minor, t.bid_count, t.currency
  from totals t
  order by t.currency, t.bid_amount_minor desc, t.title_key, t.artist_key limit 25;
$$;
revoke all on function public.get_dj_leaderboard(uuid) from public;
grant execute on function public.get_dj_leaderboard(uuid) to anon, authenticated, service_role;

create or replace function public.get_dj_bid_ledger(p_wedding_id uuid)
returns table (id uuid, song_title text, artist_name text, bid_amount_minor bigint, bidder_name text,
  currency char(3), rank_position integer, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Wedding access denied.';
  end if;
  return query
    select b.id, b.song_title, b.artist_name, b.bid_amount_minor, b.bidder_name, b.currency,
      row_number() over (partition by b.currency order by b.bid_amount_minor desc, b.created_at, b.id)::integer,
      b.created_at
    from public.dj_song_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and c.currency = b.currency
    order by b.currency, b.bid_amount_minor desc, b.created_at, b.id;
end $$;
revoke all on function public.get_dj_bid_ledger(uuid) from public, anon;
grant execute on function public.get_dj_bid_ledger(uuid) to authenticated, service_role;
