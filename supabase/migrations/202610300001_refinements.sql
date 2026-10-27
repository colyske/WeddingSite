-- Refinements: consolidated DJ leaderboard, RSVP fees, palette names, pre-wedding events, phone-primary guests, admin drill-down.

alter table public.weddings add column if not exists palette_names text[] not null default '{}';
alter table public.weddings add column if not exists rsvp_fee_minor bigint not null default 0 check (rsvp_fee_minor between 0 and 100000000);
alter table public.weddings add column if not exists extra_guest_fee_minor bigint not null default 0 check (extra_guest_fee_minor between 0 and 100000000);
alter table public.weddings add column if not exists premium_diet_fee_minor bigint not null default 0 check (premium_diet_fee_minor between 0 and 100000000);
alter table public.weddings add column if not exists premium_diet_options text[] not null default '{}';
grant update (palette_names, rsvp_fee_minor, extra_guest_fee_minor, premium_diet_fee_minor, premium_diet_options)
  on public.weddings to authenticated;

alter table public.venues add column if not exists kind text not null default 'main';
alter table public.venues add column if not exists address text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'venues_kind_check') then
    alter table public.venues add constraint venues_kind_check check (kind in ('main', 'pre'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_address_len') then
    alter table public.venues add constraint venues_address_len check (address is null or length(address) <= 200);
  end if;
end $$;

alter table public.guests add column if not exists phone text;
create index if not exists idx_guests_wedding_phone on public.guests (wedding_id, phone);

-- One row per song: bids on the same title and artist accumulate.
drop function if exists public.get_dj_leaderboard(uuid);
create or replace function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, bid_count bigint, currency char(3))
language sql stable security definer set search_path = ''
as $$
  select (row_number() over (order by sum(b.bid_amount_minor) desc, min(b.created_at) asc))::integer,
         (array_agg(b.song_title order by b.created_at))[1],
         (array_agg(b.artist_name order by b.created_at))[1],
         sum(b.bid_amount_minor)::bigint, count(*)::bigint, max(b.currency)::char(3)
  from public.dj_song_bids b
  where b.wedding_id = p_wedding_id and public.is_published_wedding(p_wedding_id)
  group by lower(trim(b.song_title)), lower(trim(b.artist_name))
  order by 4 desc, min(b.created_at) asc
  limit 25;
$$;
revoke all on function public.get_dj_leaderboard(uuid) from public;
grant execute on function public.get_dj_leaderboard(uuid) to anon, authenticated;

create or replace function public.get_public_wedding_site(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id, 'slug', w.slug, 'couple_names', w.couple_names, 'welcome_story', w.welcome_story,
    'wedding_date', w.wedding_date, 'public_location', w.public_location, 'currency', w.currency,
    'max_guest_capacity', w.max_guest_capacity, 'palette', to_jsonb(w.palette), 'palette_names', to_jsonb(w.palette_names),
    'attire_notes', w.attire_notes,
    'time_zone', w.time_zone, 'background_music_url', w.background_music_url,
    'rsvp_fee_minor', w.rsvp_fee_minor, 'extra_guest_fee_minor', w.extra_guest_fee_minor,
    'premium_diet_fee_minor', w.premium_diet_fee_minor, 'premium_diet_options', to_jsonb(w.premium_diet_options),
    'is_past', (w.wedding_date < (now() at time zone w.time_zone)::date),
    'accepting_rsvps', (
      select coalesce(sum(1 + r.plus_one_count), 0) < w.max_guest_capacity
      from public.guest_rsvps r where r.wedding_id = w.id and r.attendance_status = 'yes'
    ) and not (w.wedding_date < (now() at time zone w.time_zone)::date),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'event_time', v.event_time, 'event_date', coalesce(v.event_date, w.wedding_date),
        'map_link', v.map_link, 'description', v.description, 'is_main', v.is_main, 'kind', v.kind, 'address', v.address
      ) order by coalesce(v.event_date, w.wedding_date), v.event_time nulls last, v.sort_order, v.created_at)
      from public.venues v where v.wedding_id = w.id
    ), '[]'::jsonb),
    'registry', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id, 'name', ri.name, 'description', ri.description, 'category', ri.category,
        'target_amount_minor', ri.target_amount_minor, 'notes', ri.notes,
        'amount_raised_minor', coalesce((
          select sum(c.paid_amount_minor) from public.contributions c
          where c.wedding_id = w.id and c.stream_name = ri.name and c.payment_status = 'paid'), 0)
      ) order by ri.sort_order, ri.created_at)
      from public.registry_items ri where ri.wedding_id = w.id
    ), '[]'::jsonb)
  )
  from public.weddings w
  where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
grant execute on function public.get_public_wedding_site(text) to anon, authenticated;

-- Test-mode RSVP fee ledger rows (service role only). Lines: [{label, amount_minor}].
create or replace function public.record_test_rsvp_fees(p_wedding_id uuid, p_name text, p_lines jsonb)
returns integer language plpgsql security definer set search_path = ''
as $$
declare w public.weddings; l jsonb; bps integer; fee bigint; amt bigint; n integer := 0; v_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id;
  if not found or w.published_at is null or w.archived_at is not null then raise exception 'This wedding is not accepting payments.'; end if;
  select contribution_fee_basis_points into bps from public.platform_policies where id;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    amt := (l->>'amount_minor')::bigint;
    if amt is null or amt < 1 then continue; end if;
    fee := round(amt::numeric * bps / 10000)::bigint;
    v_id := extensions.gen_random_uuid();
    insert into public.contributions (id, wedding_id, stream_name, pledged_amount_minor, paid_amount_minor,
      platform_fee_basis_points, platform_fee_minor, net_paid_minor, currency, payment_status, display_name,
      visibility, provider_name, provider_reference, paid_at)
    values (v_id, p_wedding_id, left(coalesce(l->>'label', 'RSVP fee'), 100), amt, amt, bps, fee, amt - fee, w.currency,
      'paid', coalesce(nullif(left(trim(p_name), 100), ''), 'Guest'), 'hidden', 'test-simulator', 'TEST-' || v_id::text, now());
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.record_test_rsvp_fees(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_test_rsvp_fees(uuid, text, jsonb) to service_role;

-- Staff drill-down for a single wedding.
create or replace function public.admin_wedding_metrics(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public set row_security = off
as $$
declare result jsonb;
begin
  perform public.require_staff();
  select jsonb_build_object(
    'wedding', (select jsonb_build_object('id', w.id, 'slug', w.slug, 'couple_names', w.couple_names, 'wedding_date', w.wedding_date,
        'currency', w.currency, 'published', w.published_at is not null, 'archived', w.archived_at is not null)
      from public.weddings w where w.id = p_wedding_id),
    'analytics', public.wedding_analytics(p_wedding_id),
    'party_size', (select coalesce(sum(1 + plus_one_count), 0) from public.guest_rsvps where wedding_id = p_wedding_id and attendance_status = 'yes'),
    'funds_by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object('campaign', t.stream_name, 'gross_minor', t.g, 'net_minor', t.n, 'count', t.c) order by t.g desc)
      from (select stream_name, sum(paid_amount_minor) g, sum(net_paid_minor) n, count(*) c from public.contributions
            where wedding_id = p_wedding_id and payment_status = 'paid' group by stream_name) t), '[]'::jsonb),
    'top_songs', coalesce((
      select jsonb_agg(jsonb_build_object('song', s.title, 'artist', s.artist, 'total_minor', s.total, 'bids', s.bids) order by s.total desc)
      from (select (array_agg(song_title order by created_at))[1] title, (array_agg(artist_name order by created_at))[1] artist,
                   sum(bid_amount_minor) total, count(*) bids
            from public.dj_song_bids where wedding_id = p_wedding_id
            group by lower(trim(song_title)), lower(trim(artist_name)) order by sum(bid_amount_minor) desc limit 10) s), '[]'::jsonb),
    'top_inviters', coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.referral_summary(p_wedding_id) limit 10) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_wedding_metrics(uuid) from public, anon;
grant execute on function public.admin_wedding_metrics(uuid) to authenticated;
