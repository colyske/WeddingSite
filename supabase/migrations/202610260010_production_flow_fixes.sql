-- Close production gaps in wedding creation, guest-facing data, RSVP passes, and text normalization.

create or replace function public.create_wedding_with_venues(
  p_slug text,
  p_couple_names text,
  p_wedding_date date,
  p_location text,
  p_currency text,
  p_capacity integer,
  p_palette text[],
  p_venues jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding_id uuid;
  v_venue jsonb;
  v_name text;
  v_map_link text;
begin
  v_wedding_id := public.create_wedding(
    p_slug, p_couple_names, p_wedding_date, p_location, p_currency, p_capacity, p_palette
  );

  if jsonb_typeof(coalesce(p_venues, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_venues, '[]'::jsonb)) > 30 then
    raise exception 'Invalid wedding venues.';
  end if;

  for v_venue in select value from jsonb_array_elements(coalesce(p_venues, '[]'::jsonb))
  loop
    v_name := left(trim(coalesce(v_venue ->> 'name', '')), 100);
    if v_name = '' then
      continue;
    end if;
    v_map_link := nullif(trim(v_venue ->> 'mapLink'), '');
    if v_map_link is not null and v_map_link !~ '^https?://' then
      raise exception 'Venue map links must use HTTP or HTTPS.';
    end if;
    insert into public.venues (wedding_id, name, event_time, map_link, description, is_main, sort_order)
    values (
      v_wedding_id,
      v_name,
      nullif(v_venue ->> 'eventTime', '')::time,
      left(v_map_link, 500),
      left(nullif(v_venue ->> 'description', ''), 500),
      coalesce((v_venue ->> 'isMain')::boolean, false),
      coalesce((v_venue ->> 'sortOrder')::integer, 0)
    );
  end loop;

  return v_wedding_id;
end;
$$;

create or replace function public.get_public_wedding_site(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id,
    'slug', w.slug,
    'couple_names', w.couple_names,
    'welcome_story', w.welcome_story,
    'wedding_date', w.wedding_date,
    'public_location', w.public_location,
    'currency', w.currency,
    'max_guest_capacity', w.max_guest_capacity,
    'palette', to_jsonb(w.palette),
    'attire_notes', w.attire_notes,
    'background_music_url', w.background_music_url,
    'accepting_rsvps', (
      select coalesce(sum(1 + r.plus_one_count), 0) < w.max_guest_capacity
      from public.guest_rsvps r
      where r.wedding_id = w.id and r.attendance_status = 'yes'
    ),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'event_time', v.event_time,
        'map_link', v.map_link, 'description', v.description, 'is_main', v.is_main
      ) order by v.sort_order, v.created_at)
      from public.venues v where v.wedding_id = w.id
    ), '[]'::jsonb),
    'registry', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id, 'name', ri.name, 'description', ri.description,
        'category', ri.category, 'target_amount_minor', ri.target_amount_minor,
        'notes', ri.notes, 'amount_raised_minor', coalesce((
          select sum(c.paid_amount_minor)
          from public.contributions c
          where c.wedding_id = w.id and c.stream_name = ri.name and c.payment_status = 'paid'
        ), 0)
      ) order by ri.sort_order, ri.created_at)
      from public.registry_items ri where ri.wedding_id = w.id
    ), '[]'::jsonb)
  )
  from public.weddings w
  where w.slug = lower(p_slug) and w.published_at is not null;
$$;

create or replace function public.get_public_fundraising(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'min_amount_minor', t.min_amount_minor, 'perks', t.perks
      ) order by t.sort_order, t.created_at)
      from public.sponsor_tiers t where t.wedding_id = w.id
    ), '[]'::jsonb),
    'vip', (
      select jsonb_build_object(
        'id', v.id, 'title', v.title, 'description', v.description,
        'seats_total', v.seats_total, 'seats_sold', v.seats_sold, 'price_minor', v.price_minor
      )
      from public.vip_offers v where v.wedding_id = w.id limit 1
    ),
    'sponsors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'company_name', s.company_name,
        'website', s.website, 'amount_minor', s.amount_minor
      ) order by s.amount_minor desc, s.created_at)
      from public.sponsors s where s.wedding_id = w.id and s.status = 'active'
    ), '[]'::jsonb)
  )
  from public.weddings w
  where w.slug = lower(p_slug) and w.published_at is not null;
$$;

create or replace function public.submit_rsvp_with_pass(
  p_wedding_id uuid,
  p_guest_email text,
  p_guest_name text,
  p_attending boolean,
  p_dietary_requested boolean,
  p_dietary_notes text,
  p_plus_one_count integer
) returns table (status text, message text, rsvp_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_taken bigint;
  v_email text := lower(trim(coalesce(p_guest_email, '')));
  v_id uuid;
  v_plus integer := coalesce(p_plus_one_count, 0);
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or length(trim(coalesce(p_guest_name, ''))) not between 1 and 100
     or v_plus not between 0 and 10
     or length(coalesce(p_dietary_notes, '')) > 240 then
    return query select 'invalid'::text, 'Please check your name, email and guest count.'::text, null::uuid;
    return;
  end if;
  if not public.is_published_wedding(p_wedding_id) then
    return query select 'unavailable'::text, 'This wedding is not accepting RSVPs.'::text, null::uuid;
    return;
  end if;

  select max_guest_capacity into v_capacity
  from public.weddings where id = p_wedding_id for update;

  if not coalesce(p_attending, false) then
    insert into public.guest_rsvps
      (wedding_id, guest_email, guest_name, attendance_status, dietary_accommodation_requested,
       dietary_notes, plus_one_count, rsvped_at)
    values
      (p_wedding_id, v_email, trim(p_guest_name), 'no', false, null, 0, now())
    on conflict (wedding_id, guest_email) do update
      set guest_name = excluded.guest_name, attendance_status = 'no',
          dietary_accommodation_requested = false, dietary_notes = null,
          plus_one_count = 0, rsvped_at = now(), updated_at = now()
    returning id into v_id;
    return query select 'declined'::text, 'Thank you for letting us know.'::text, v_id;
    return;
  end if;

  select coalesce(sum(1 + plus_one_count), 0) into v_taken
  from public.guest_rsvps
  where wedding_id = p_wedding_id and attendance_status = 'yes' and guest_email <> v_email;
  if v_taken + 1 + v_plus > v_capacity then
    return query select 'full'::text, 'The guest list is full, so RSVPs are closed right now. Please contact the couple.'::text, null::uuid;
    return;
  end if;

  insert into public.guest_rsvps
    (wedding_id, guest_email, guest_name, attendance_status, dietary_accommodation_requested,
     dietary_notes, plus_one_count, rsvped_at)
  values
    (p_wedding_id, v_email, trim(p_guest_name), 'yes', coalesce(p_dietary_requested, false),
     nullif(trim(coalesce(p_dietary_notes, '')), ''), v_plus, now())
  on conflict (wedding_id, guest_email) do update
    set guest_name = excluded.guest_name, attendance_status = 'yes',
        dietary_accommodation_requested = excluded.dietary_accommodation_requested,
        dietary_notes = excluded.dietary_notes, plus_one_count = excluded.plus_one_count,
        rsvped_at = now(), updated_at = now()
  returning id into v_id;
  return query select 'confirmed'::text, 'Your attendance is confirmed.'::text, v_id;
end;
$$;

create or replace function public.get_rsvp_count(p_wedding_id uuid)
returns table (count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(1 + r.plus_one_count), 0)::bigint
  from public.guest_rsvps r
  where r.wedding_id = p_wedding_id and r.attendance_status = 'yes'
    and public.is_published_wedding(p_wedding_id);
$$;

alter table public.guest_rsvps add column if not exists checked_in_at timestamptz;

create or replace function public.get_guest_verification(p_code uuid)
returns table (
  rsvp_id uuid,
  wedding_id uuid,
  slug text,
  couple_names text,
  guest_name text,
  attendance_status text,
  checked_in_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.wedding_id, w.slug, w.couple_names, r.guest_name,
         r.attendance_status::text, r.checked_in_at
  from public.guest_rsvps r
  join public.weddings w on w.id = r.wedding_id
  where r.id = p_code and w.published_at is not null;
$$;

create or replace function public.mark_guest_rsvp_checked_in(p_code uuid)
returns table (
  rsvp_id uuid,
  wedding_id uuid,
  slug text,
  guest_name text,
  attendance_status text,
  checked_in_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wedding_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  select r.wedding_id into v_wedding_id
  from public.guest_rsvps r where r.id = p_code;
  if v_wedding_id is null or not exists (
    select 1 from public.weddings w
    where w.id = v_wedding_id
      and (w.client_owner_id = auth.uid() or public.current_platform_role() in ('owner', 'superadmin'))
  ) then
    raise exception 'Wedding access denied.';
  end if;
  update public.guest_rsvps r
  set checked_in_at = coalesce(r.checked_in_at, now()), updated_at = now()
  where r.id = p_code and r.attendance_status = 'yes';
  if not found then
    raise exception 'Only an attending guest can be checked in.';
  end if;
  return query
  select r.id, r.wedding_id, w.slug, r.guest_name,
         r.attendance_status::text, r.checked_in_at
  from public.guest_rsvps r
  join public.weddings w on w.id = r.wedding_id
  where r.id = p_code;
end;
$$;

grant execute on function public.create_wedding_with_venues(text, text, date, text, text, integer, text[], jsonb) to authenticated;
grant execute on function public.get_public_wedding_site(text) to anon, authenticated;
grant execute on function public.get_public_fundraising(text) to anon, authenticated;
grant execute on function public.submit_rsvp_with_pass(uuid, text, text, boolean, boolean, text, integer) to anon, authenticated;
grant execute on function public.get_rsvp_count(uuid) to anon, authenticated;
grant execute on function public.get_guest_verification(uuid) to anon, authenticated;
grant execute on function public.mark_guest_rsvp_checked_in(uuid) to authenticated;

-- Older releases escaped ampersands before saving. Normalize only those literal entities;
-- rendering code is responsible for escaping exactly once at the HTML boundary.
update public.weddings set
  couple_names = replace(couple_names, '&amp;', '&'),
  welcome_story = replace(welcome_story, '&amp;', '&'),
  public_location = replace(public_location, '&amp;', '&'),
  attire_notes = replace(attire_notes, '&amp;', '&')
where couple_names like '%&amp;%' or welcome_story like '%&amp;%'
   or public_location like '%&amp;%' or attire_notes like '%&amp;%';

update public.venues set name = replace(name, '&amp;', '&'),
  description = replace(description, '&amp;', '&')
where name like '%&amp;%' or description like '%&amp;%';

update public.registry_items set name = replace(name, '&amp;', '&'),
  description = replace(description, '&amp;', '&'),
  category = replace(category, '&amp;', '&'),
  notes = replace(notes, '&amp;', '&')
where name like '%&amp;%' or description like '%&amp;%'
   or category like '%&amp;%' or notes like '%&amp;%';

update public.guest_rsvps set guest_name = replace(guest_name, '&amp;', '&'),
  dietary_notes = replace(dietary_notes, '&amp;', '&')
where guest_name like '%&amp;%' or dietary_notes like '%&amp;%';

update public.guests set name = replace(name, '&amp;', '&'),
  dietary_preference = replace(dietary_preference, '&amp;', '&')
where name like '%&amp;%' or dietary_preference like '%&amp;%';

update public.dj_song_bids set song_title = replace(song_title, '&amp;', '&'),
  artist_name = replace(artist_name, '&amp;', '&'),
  bidder_name = replace(bidder_name, '&amp;', '&')
where song_title like '%&amp;%' or artist_name like '%&amp;%' or bidder_name like '%&amp;%';

update public.sponsor_tiers set name = replace(name, '&amp;', '&'),
  perks = replace(perks, '&amp;', '&')
where name like '%&amp;%' or perks like '%&amp;%';

update public.sponsors set company_name = replace(company_name, '&amp;', '&')
where company_name like '%&amp;%';
