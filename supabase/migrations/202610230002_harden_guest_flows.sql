-- Hardens guest flows: no direct anonymous table access, RPC-only RSVP/bids,
-- guest-safe public reads, and a publication-fee gate that cannot be bypassed.

drop policy if exists guest_rsvps_insert_anonymous on public.guest_rsvps;
drop policy if exists guest_rsvps_select_published on public.guest_rsvps;
drop policy if exists dj_bids_insert_published on public.dj_song_bids;
drop policy if exists dj_bids_select_published on public.dj_song_bids;
drop policy if exists publication_fees_select_owner on public.publication_fees;

-- Guest PII (email, dietary notes) is visible only to the wedding's Client/Admin members and platform staff.
create policy guest_rsvps_select_workspace on public.guest_rsvps
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (
        select 1 from public.wedding_memberships m
        where m.wedding_id = guest_rsvps.wedding_id and m.user_id = auth.uid()
          and m.role in ('client', 'admin')
      )
      or exists (
        select 1 from public.weddings w
        where w.id = guest_rsvps.wedding_id and w.client_owner_id = auth.uid()
      )
    )
  );

create policy dj_bids_select_workspace on public.dj_song_bids
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (
        select 1 from public.weddings w
        where w.id = dj_song_bids.wedding_id and w.client_owner_id = auth.uid()
      )
    )
  );

create policy publication_fees_select_client on public.publication_fees
  for select using (
    exists (select 1 from public.weddings w
            where w.id = publication_fees.wedding_id and w.client_owner_id = auth.uid())
  );

alter table public.guest_rsvps drop constraint if exists guest_rsvps_email_format;
alter table public.guest_rsvps add constraint guest_rsvps_email_format
  check (guest_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

alter table public.publication_fees alter column amount_minor drop not null;
alter table public.publication_fees drop constraint if exists publication_fees_amount_minor_check;
alter table public.publication_fees add constraint publication_fees_amount_minor_check
  check (amount_minor is null or amount_minor >= 0);

-- RSVP: replaces the earlier signature. Handles both "attending" and "not attending".
drop function if exists public.accept_rsvp_with_capacity_check(uuid, text, text, boolean, integer);
create or replace function public.submit_rsvp(
  p_wedding_id uuid,
  p_guest_email text,
  p_guest_name text,
  p_attending boolean,
  p_dietary_requested boolean,
  p_dietary_notes text,
  p_plus_one_count integer
) returns table (status text, message text) language plpgsql security definer set search_path = ''
as $$
declare
  v_capacity integer;
  v_taken integer;
  v_email text := lower(trim(p_guest_email));
  v_plus integer := coalesce(p_plus_one_count, 0);
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254
     or length(trim(coalesce(p_guest_name, ''))) not between 1 and 100
     or v_plus not between 0 and 10
     or length(coalesce(p_dietary_notes, '')) > 240 then
    return query select 'invalid'::text, 'Please check your name, email and guest count.'::text;
    return;
  end if;
  if not public.is_published_wedding(p_wedding_id) then
    return query select 'unavailable'::text, 'This wedding is not accepting RSVPs.'::text;
    return;
  end if;

  select max_guest_capacity into v_capacity from public.weddings where id = p_wedding_id for update;

  if not coalesce(p_attending, false) then
    insert into public.guest_rsvps (wedding_id, guest_email, guest_name, attendance_status, rsvped_at)
    values (p_wedding_id, v_email, trim(p_guest_name), 'no', now())
    on conflict (wedding_id, guest_email) do update
      set attendance_status = 'no', plus_one_count = 0, dietary_accommodation_requested = false,
          dietary_notes = null, guest_name = excluded.guest_name, rsvped_at = now(), updated_at = now();
    return query select 'declined'::text, 'Thank you for letting us know.'::text;
    return;
  end if;

  select coalesce(sum(1 + plus_one_count), 0) into v_taken
  from public.guest_rsvps
  where wedding_id = p_wedding_id and attendance_status = 'yes' and guest_email <> v_email;

  if v_taken + 1 + v_plus > v_capacity then
    return query select 'full'::text, 'The guest list is full, so RSVPs are closed right now. Please contact the couple.'::text;
    return;
  end if;

  insert into public.guest_rsvps
    (wedding_id, guest_email, guest_name, attendance_status, dietary_accommodation_requested,
     dietary_notes, plus_one_count, rsvped_at)
  values (p_wedding_id, v_email, trim(p_guest_name), 'yes', coalesce(p_dietary_requested, false),
          nullif(trim(coalesce(p_dietary_notes, '')), ''), v_plus, now())
  on conflict (wedding_id, guest_email) do update
    set attendance_status = 'yes', guest_name = excluded.guest_name,
        dietary_accommodation_requested = excluded.dietary_accommodation_requested,
        dietary_notes = excluded.dietary_notes, plus_one_count = excluded.plus_one_count,
        rsvped_at = now(), updated_at = now();
  return query select 'confirmed'::text, 'Your attendance is confirmed.'::text;
end;
$$;

-- DJ bids: guest picks the amount; highest amount ranks first. A bid is a promise shown to the
-- couple/DJ, not a charge. Collection happens only through a configured payment provider.
create or replace function public.rank_dj_bids_for_wedding(p_wedding_id uuid)
returns void language sql security definer set search_path = ''
as $$
  update public.dj_song_bids b
  set rank_position = r.pos, status = 'ranked'
  from (
    select id, row_number() over (order by bid_amount_minor desc, created_at asc) as pos
    from public.dj_song_bids where wedding_id = p_wedding_id
  ) r
  where b.id = r.id;
$$;

create or replace function public.place_dj_bid(
  p_wedding_id uuid, p_song_title text, p_artist_name text,
  p_bid_amount_minor bigint, p_bidder_name text
) returns table (status text, message text) language plpgsql security definer set search_path = ''
as $$
declare
  v_currency char(3);
  v_max bigint;
begin
  if length(trim(coalesce(p_song_title, ''))) not between 1 and 160
     or length(trim(coalesce(p_artist_name, ''))) not between 1 and 100
     or length(coalesce(p_bidder_name, '')) > 100 then
    return query select 'invalid'::text, 'Please enter a song title and artist.'::text;
    return;
  end if;
  if not public.is_published_wedding(p_wedding_id) then
    return query select 'unavailable'::text, 'This wedding is not accepting song bids.'::text;
    return;
  end if;
  select w.currency, pp.max_contribution_minor into v_currency, v_max
  from public.weddings w, public.platform_policies pp where w.id = p_wedding_id and pp.id;
  if p_bid_amount_minor is null or p_bid_amount_minor < 1 or p_bid_amount_minor > v_max then
    return query select 'invalid'::text, 'Enter a valid bid amount.'::text;
    return;
  end if;
  insert into public.dj_song_bids (wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, status)
  values (p_wedding_id, trim(p_song_title), trim(p_artist_name), p_bid_amount_minor, v_currency,
          coalesce(nullif(trim(p_bidder_name), ''), 'Guest'), 'submitted');
  perform public.rank_dj_bids_for_wedding(p_wedding_id);
  return query select 'placed'::text, 'Your bid is on the leaderboard.'::text;
end;
$$;

create or replace function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, currency char(3))
language sql stable security definer set search_path = ''
as $$
  select b.rank_position, b.song_title, b.artist_name, b.bid_amount_minor, b.currency
  from public.dj_song_bids b
  where b.wedding_id = p_wedding_id and public.is_published_wedding(p_wedding_id)
  order by b.bid_amount_minor desc, b.created_at asc
  limit 25;
$$;

-- Guest-safe public wedding view: no platform fees, no capacity numbers, no internal ids besides the wedding id.
create or replace function public.get_public_wedding(p_slug text)
returns table (
  id uuid, slug text, couple_names text, welcome_story text, wedding_date date,
  public_location text, currency char(3), palette text[], accepting_rsvps boolean,
  story_approved text, attire_approved text, travel_approved text
) language sql stable security definer set search_path = ''
as $$
  select w.id, w.slug, w.couple_names, w.welcome_story, w.wedding_date, w.public_location,
         w.currency, w.palette,
         (select coalesce(sum(1 + r.plus_one_count), 0) from public.guest_rsvps r
            where r.wedding_id = w.id and r.attendance_status = 'yes') < w.max_guest_capacity,
         c.story_approved, c.attire_approved, c.travel_approved
  from public.weddings w
  left join public.guest_site_content c on c.wedding_id = w.id
  where w.slug = lower(p_slug) and w.published_at is not null;
$$;

-- Publication-fee gate: a non-zero fee must be waived or paid (by platform staff) before publishing.
create or replace function public.waive_publication_fee(p_wedding_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if public.current_platform_role() not in ('owner', 'superadmin') then
    raise exception 'Only platform staff can waive a publication fee.';
  end if;
  insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at)
  select w.id, 0, w.currency, 'waived', now() from public.weddings w where w.id = p_wedding_id
  on conflict (wedding_id) do update set status = 'waived', paid_at = now();
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id)
  values (p_wedding_id, auth.uid(), 'user', 'waive_publication_fee', 'publication_fees', p_wedding_id::text);
end;
$$;

create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_fee bigint;
  v_currency char(3);
  v_slug text;
  v_status text;
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to publish a wedding.';
  end if;
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;

  select pp.publication_fee_minor, w.currency, w.slug into v_fee, v_currency, v_slug
  from public.platform_policies pp, public.weddings w
  where pp.id and w.id = p_wedding_id for update of w;
  if v_currency is null then raise exception 'Wedding not found.'; end if;
  if v_slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;

  select pf.status into v_status from public.publication_fees pf where pf.wedding_id = p_wedding_id;
  if v_fee > 0 and coalesce(v_status, 'pending') not in ('paid', 'waived') then
    insert into public.publication_fees (wedding_id, amount_minor, currency, status)
    values (p_wedding_id, v_fee, v_currency, 'pending') on conflict do nothing;
    raise exception 'The publication fee must be paid or waived by the platform before publishing.';
  end if;

  update public.weddings set published_at = coalesce(published_at, now()) where id = p_wedding_id;
  return true;
end;
$$;

revoke all on function public.submit_rsvp(uuid, text, text, boolean, boolean, text, integer) from public;
revoke all on function public.place_dj_bid(uuid, text, text, bigint, text) from public;
revoke all on function public.get_dj_leaderboard(uuid) from public;
revoke all on function public.get_public_wedding(text) from public;
revoke all on function public.get_published_contributions_page(uuid, integer, integer) from public;
revoke all on function public.rank_dj_bids_for_wedding(uuid) from public, anon, authenticated;
revoke all on function public.waive_publication_fee(uuid) from public, anon;
revoke all on function public.publish_wedding_with_fee(uuid, boolean) from public, anon;

grant execute on function public.submit_rsvp(uuid, text, text, boolean, boolean, text, integer) to anon, authenticated;
grant execute on function public.place_dj_bid(uuid, text, text, bigint, text) to anon, authenticated;
grant execute on function public.get_dj_leaderboard(uuid) to anon, authenticated;
grant execute on function public.get_public_wedding(text) to anon, authenticated;
grant execute on function public.waive_publication_fee(uuid) to authenticated;
grant execute on function public.publish_wedding_with_fee(uuid, boolean) to authenticated;
