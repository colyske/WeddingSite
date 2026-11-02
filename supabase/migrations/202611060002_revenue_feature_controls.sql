alter table public.weddings
  add column if not exists revenue_features jsonb not null default
    '{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.weddings'::regclass
      and conname = 'weddings_revenue_features_check'
  ) then
    alter table public.weddings add constraint weddings_revenue_features_check check (
      jsonb_typeof(revenue_features) = 'object'
      and revenue_features ?& array['giving','sponsors','featured_sponsors','song_requests','vip_seating']
      and revenue_features - array['giving','sponsors','featured_sponsors','song_requests','vip_seating'] = '{}'::jsonb
      and jsonb_typeof(revenue_features->'giving') = 'boolean'
      and jsonb_typeof(revenue_features->'sponsors') = 'boolean'
      and jsonb_typeof(revenue_features->'featured_sponsors') = 'boolean'
      and jsonb_typeof(revenue_features->'song_requests') = 'boolean'
      and jsonb_typeof(revenue_features->'vip_seating') = 'boolean'
    );
  end if;
end $$;

create or replace function public.save_wedding_content(p_wedding_id uuid, p_patch jsonb, p_venues jsonb default null,
  p_expected_currency text default null, p_expected_presets jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; v jsonb; vid uuid; incoming uuid[] := '{}'; pos integer := 0; assignments text;
  allowed text[] := array['couple_names','slug','welcome_story','wedding_date','time_zone','public_location',
    'currency','amount_presets','revenue_features','max_guest_capacity','palette','palette_names','attire_notes',
    'rsvp_fee_minor','extra_guest_fee_minor','premium_diet_fee_minor','premium_diet_options',
    'allow_in_kind_sponsorship','background_music_url'];
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if not found or auth.uid() is null or w.client_owner_id <> auth.uid() then raise exception 'Wedding not found.'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists
      (select 1 from jsonb_object_keys(p_patch) k where not k=any(allowed)) then raise exception 'Invalid wedding patch.'; end if;
  if p_expected_currency is not null and w.currency::text is distinct from p_expected_currency then
    raise exception 'DRAFT_CONFLICT: Wedding currency changed. Reload and review the amounts.';
  end if;
  if p_patch ? 'amount_presets' and (p_expected_currency is null or w.amount_presets is distinct from p_expected_presets) then
    raise exception 'DRAFT_CONFLICT: Review suggested amounts against the current saved wedding.';
  end if;
  if p_patch ? 'currency' and p_patch->>'currency' is distinct from w.currency::text and not p_patch ? 'amount_presets' then
    raise exception 'Currency changes require reviewed suggested amounts or an explicit reset.';
  end if;
  if p_patch ? 'couple_names' and nullif(btrim(p_patch->>'couple_names'),'') is null then raise exception 'Couple names are required.'; end if;
  if p_venues is not null then
    if jsonb_typeof(p_venues) <> 'array' or jsonb_array_length(p_venues)>30 then raise exception 'Use up to 30 events.'; end if;
    for v in select value from jsonb_array_elements(p_venues) loop
      vid := nullif(v->>'id','')::uuid;
      if vid is not null and not exists(select 1 from public.venues where id=vid and wedding_id=w.id) then
        raise exception 'An event belongs to a different wedding or was removed. Reload before saving.';
      end if;
      if vid=any(incoming) then raise exception 'An event appears twice.'; end if;
      if vid is null then insert into public.venues(wedding_id,name) values(w.id,'') returning id into vid; end if;
      incoming := array_append(incoming,vid);
      update public.venues set name=case when v ? 'name' then left(btrim(coalesce(v->>'name','')),100) else name end,
        event_time=case when v ? 'eventTime' then nullif(v->>'eventTime','')::time else event_time end,
        event_date=case when v ? 'eventDate' then nullif(v->>'eventDate','')::date else event_date end,
        address=case when v ? 'address' then nullif(left(btrim(v->>'address'),200),'') else address end,
        map_link=case when v ? 'mapLink' then nullif(btrim(v->>'mapLink'),'') else map_link end,
        description=case when v ? 'description' then nullif(left(v->>'description',500),'') else description end,
        is_main=case when v ? 'isMain' then coalesce((v->>'isMain')::boolean,false) else is_main end,
        kind=case when v ? 'kind' then case when v->>'kind'='pre' then 'pre' else 'main' end else kind end,
        sort_order=pos where id=vid;
      pos := pos+1;
    end loop;
    delete from public.venues where wedding_id=w.id and not id=any(incoming);
  end if;
  select string_agg(format('%1$I=patch.%1$I',k),',') into assignments from jsonb_object_keys(p_patch) k;
  if assignments is not null then
    execute 'update public.weddings w set ' || assignments ||
      ' from jsonb_populate_record(null::public.weddings,$1) patch where w.id=$2 returning w.*'
      into w using p_patch,w.id;
  end if;
  if w.published_at is not null then perform public.assert_wedding_publish_content(w); end if;
  return to_jsonb(w);
end $$;
revoke all on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) from public, anon;
grant execute on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) to authenticated;

create or replace function public.displayable_contribution_amount(p_contribution_id uuid)
returns bigint language sql stable security definer set search_path = '' set row_security = off
as $$
  select greatest(0, c.paid_amount_minor - coalesce(sum(
    case
      when a.adjustment_kind = 'refund' and a.status = 'processed' then a.amount_minor
      when a.adjustment_kind = 'dispute' and a.status = 'lost' then a.amount_minor
      when a.status in ('pending','open','review') then a.hold_minor
      else 0
    end
  ), 0))::bigint
  from public.contributions c
  left join public.payment_adjustments a
    on a.contribution_id = c.id and a.currency = c.currency
  where c.id = p_contribution_id
  group by c.paid_amount_minor
$$;
revoke all on function public.displayable_contribution_amount(uuid) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.get_public_wedding_site_before_revenue_features(text)') is null then
    alter function public.get_public_wedding_site(text) rename to get_public_wedding_site_before_revenue_features;
  end if;
end $$;
revoke all on function public.get_public_wedding_site_before_revenue_features(text) from public, anon, authenticated;
create function public.get_public_wedding_site(p_slug text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select site.payload || jsonb_build_object(
    'revenue_features', w.revenue_features,
    'registry', case when (w.revenue_features->>'giving')::boolean
      then coalesce(site.payload->'registry', '[]'::jsonb) else '[]'::jsonb end
  )
  from (select public.get_public_wedding_site_before_revenue_features(p_slug) payload) site
  join public.weddings w on w.id = (site.payload->>'id')::uuid
$$;
revoke all on function public.get_public_wedding_site(text) from public;
grant execute on function public.get_public_wedding_site(text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.get_public_fundraising_before_revenue_features(text)') is null then
    alter function public.get_public_fundraising(text) rename to get_public_fundraising_before_revenue_features;
  end if;
end $$;
revoke all on function public.get_public_fundraising_before_revenue_features(text) from public, anon, authenticated;
create function public.get_public_fundraising(p_slug text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with source as materialized (
    select public.get_public_fundraising_before_revenue_features(p_slug) payload
  ), wedding as (
    select w.* from public.weddings w
    where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null
  )
  select source.payload || jsonb_build_object(
    'tiers', case when (wedding.revenue_features->>'sponsors')::boolean then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'min_amount_minor', t.min_amount_minor, 'perks', t.perks
      ) order by t.sort_order, t.created_at) from public.sponsor_tiers t where t.wedding_id = wedding.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'vip', case when (wedding.revenue_features->>'vip_seating')::boolean then source.payload->'vip' else null end,
    'sponsors', case when (wedding.revenue_features->>'sponsors')::boolean then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'company_name', s.company_name, 'location', s.location, 'offer', s.offer,
        'website', s.website, 'social_links', s.social_links, 'amount_minor',
        case when c.id is null then s.amount_minor else public.displayable_contribution_amount(c.id) end,
        'currency', coalesce(c.currency, wedding.currency), 'in_kind', s.in_kind, 'public_contact', s.public_contact,
        'contact_email', case when s.public_contact then s.contact_email else null end,
        'contact_phone', case when s.public_contact then s.contact_phone else null end
      ) order by
        case when coalesce(c.currency, wedding.currency) = wedding.currency then 0 else 1 end,
        coalesce(c.currency, wedding.currency),
        public.displayable_contribution_amount(c.id) desc nulls last,
        s.created_at asc, s.id)
      from public.sponsors s
      left join public.contributions c on c.id = s.contribution_id
      where s.wedding_id = wedding.id and s.status = 'active'
        and (s.in_kind and s.contribution_id is null or
          c.payment_status = 'paid' and c.verified_provider_payment
            and c.payment_environment = 'live' and c.action_completed_at is not null
            and public.displayable_contribution_amount(c.id) > 0)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'campaigns', case when (wedding.revenue_features->>'giving')::boolean
      then coalesce(source.payload->'campaigns', '[]'::jsonb) else '[]'::jsonb end
  )
  from source cross join wedding
  where source.payload is not null
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
  if not (v_wedding.revenue_features->>'featured_sponsors')::boolean then
    return jsonb_build_object('enabled', false);
  end if;
  select * into v_campaign from public.sponsor_featured_campaigns c where c.wedding_id = v_wedding.id;
  if not found or not v_campaign.enabled then return jsonb_build_object('enabled', false); end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.total_minor desc, lower(r.company_name), r.company_name), '[]'::jsonb)
    into v_leaders
  from (
    select min(b.company_name) as company_name, sum(public.displayable_contribution_amount(c.id))::bigint as total_minor,
      count(*)::integer as bid_count, b.currency::text as currency
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and b.currency = v_campaign.currency and c.currency = b.currency
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and public.displayable_contribution_amount(c.id) > 0
    group by lower(b.company_name), b.currency
    order by sum(public.displayable_contribution_amount(c.id)) desc, lower(b.company_name), min(b.company_name)
    limit 20
  ) r;
  select coalesce(max(t.total_minor), 0) + v_campaign.bid_increment_minor
    into v_next
  from (
    select lower(b.company_name) company_key,
      sum(public.displayable_contribution_amount(c.id))::bigint total_minor
    from public.sponsor_featured_bids b
    join public.contributions c on c.id = b.contribution_id
    where b.wedding_id = v_wedding.id and b.currency = v_campaign.currency and c.currency = b.currency
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and public.displayable_contribution_amount(c.id) > 0
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

create or replace function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, bid_count bigint, currency char(3))
language sql stable security definer set search_path = '' set row_security = off
as $$
  with totals as (
    select min(b.song_title) as song_title, min(b.artist_name) as artist_name,
      sum(public.displayable_contribution_amount(c.id))::bigint as bid_amount_minor, b.currency,
      count(*)::bigint as bid_count, lower(trim(b.song_title)) as title_key,
      lower(trim(b.artist_name)) as artist_key
    from public.dj_song_bids b
    join public.contributions c on c.id = b.contribution_id
    join public.weddings w on w.id = b.wedding_id
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and c.currency = b.currency and public.is_published_wedding(p_wedding_id)
      and (w.revenue_features->>'song_requests')::boolean
      and public.displayable_contribution_amount(c.id) > 0
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
    select b.id, b.song_title, b.artist_name, public.displayable_contribution_amount(c.id),
      b.bidder_name, b.currency,
      row_number() over (partition by b.currency order by public.displayable_contribution_amount(c.id) desc, b.created_at, b.id)::integer,
      b.created_at
    from public.dj_song_bids b
    join public.contributions c on c.id = b.contribution_id
    join public.weddings w on w.id = b.wedding_id
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and c.payment_status = 'paid' and c.verified_provider_payment
      and c.payment_environment = 'live' and c.action_completed_at is not null
      and c.currency = b.currency and (w.revenue_features->>'song_requests')::boolean
      and public.displayable_contribution_amount(c.id) > 0
    order by b.currency, public.displayable_contribution_amount(c.id) desc, b.created_at, b.id;
end $$;
revoke all on function public.get_dj_bid_ledger(uuid) from public, anon;
grant execute on function public.get_dj_bid_ledger(uuid) to authenticated, service_role;

create or replace function public.get_published_contributions_page(
  p_wedding_id uuid, p_offset integer default 0, p_limit integer default 10
) returns table (
  guest_display_name text, pledged_amount_minor bigint, paid_amount_minor bigint,
  currency char(3), payment_status text, created_at timestamptz, contribution_type text
) language sql stable security definer set search_path = ''
as $$
  select case when c.visibility = 'anonymous' then 'Anonymous' else c.display_name end,
    c.paid_amount_minor, c.paid_amount_minor, c.currency, 'paid'::text, coalesce(c.paid_at, c.created_at),
    case c.purchase_action when 'song_bid' then 'Song bid' when 'rsvp' then 'RSVP'
      when 'vip' then 'VIP reservation' when 'sponsor' then 'Sponsorship'
      when 'sponsor_featured_bid' then 'Featured sponsorship' when 'registry' then 'Registry gift'
      when 'fundraiser' then c.stream_name else coalesce(c.stream_name, 'Contribution') end
  from public.contributions c
  join public.weddings w on w.id = c.wedding_id
  where c.wedding_id = p_wedding_id and c.payment_status = 'paid'
    and public.is_published_wedding(p_wedding_id)
    and c.visibility in ('name', 'anonymous') and c.public_consent_at is not null
    and case c.purchase_action
      when 'song_bid' then (w.revenue_features->>'song_requests')::boolean
      when 'sponsor' then (w.revenue_features->>'sponsors')::boolean
      when 'sponsor_featured_bid' then (w.revenue_features->>'featured_sponsors')::boolean
      when 'vip' then (w.revenue_features->>'vip_seating')::boolean
      when 'registry' then (w.revenue_features->>'giving')::boolean
      when 'fundraiser' then (w.revenue_features->>'giving')::boolean
      else true end
  order by c.paid_at desc nulls last limit least(greatest(coalesce(p_limit, 10), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
revoke all on function public.get_published_contributions_page(uuid, integer, integer) from public;
grant execute on function public.get_published_contributions_page(uuid, integer, integer) to anon, authenticated;
