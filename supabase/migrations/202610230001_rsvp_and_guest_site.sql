-- RSVP, DJ bids, guest site, and related structures for WeddingSite launch
-- Depends on migrations 202610160001 and 202610160002

do $$ begin
  create type public.attendance_status as enum ('pending', 'yes', 'no', 'maybe');
  create type public.dj_bid_status as enum ('draft', 'submitted', 'ranked');
exception when duplicate_object then null; end $$;

-- Guest RSVP: one per guest per wedding; atomic capacity enforcement via trigger
create table if not exists public.guest_rsvps (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  guest_email text not null check (length(guest_email) between 5 and 254),
  guest_name text not null check (length(guest_name) between 1 and 100),
  attendance_status public.attendance_status not null default 'pending',
  dietary_accommodation_requested boolean not null default false,
  dietary_notes text check (dietary_notes is null or length(dietary_notes) <= 240),
  plus_one_count integer not null default 0 check (plus_one_count between 0 and 10),
  rsvped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wedding_id, guest_email)
);

-- DJ song bids: persisted with fee amounts; ranked by total bid amount descending
create table if not exists public.dj_song_bids (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  song_title text not null check (length(song_title) between 1 and 160),
  artist_name text not null check (length(artist_name) between 1 and 100),
  bid_amount_minor bigint not null check (bid_amount_minor between 1 and 100000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  bidder_name text not null default 'Guest' check (length(bidder_name) between 1 and 100),
  bidder_email text check (bidder_email is null or length(bidder_email) <= 254),
  status public.dj_bid_status not null default 'submitted',
  rank_position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_dj_bid_rank on public.dj_song_bids (wedding_id, rank_position) where status = 'ranked';

-- Guest-facing site rendering metadata and content approval state
create table if not exists public.guest_site_content (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  story_draft text check (story_draft is null or length(story_draft) <= 1500),
  story_approved text check (story_approved is null or length(story_approved) <= 1500),
  attire_suggestion text check (attire_suggestion is null or length(attire_suggestion) <= 500),
  attire_approved text check (attire_approved is null or length(attire_approved) <= 500),
  travel_notes text check (travel_notes is null or length(travel_notes) <= 500),
  travel_approved text check (travel_approved is null or length(travel_notes) <= 500),
  suggested_next_steps text check (suggested_next_steps is null or length(suggested_next_steps) <= 400),
  next_steps_approved text check (next_steps_approved is null or length(next_steps_approved) <= 400),
  venue_church_name text check (venue_church_name is null or length(venue_church_name) <= 160),
  venue_church_address text check (venue_church_address is null or length(venue_church_address) <= 240),
  venue_reception_name text check (venue_reception_name is null or length(venue_reception_name) <= 160),
  venue_reception_address text check (venue_reception_address is null or length(venue_reception_address) <= 240),
  ceremony_time time,
  reception_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AI moderation records: track which content was auto-approved vs flagged for review
create table if not exists public.content_review_records (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  field_name text not null check (length(field_name) between 1 and 80),
  new_value text not null check (length(new_value) <= 5000),
  ai_recommendation text check (ai_recommendation is null or ai_recommendation in ('approve', 'review', 'block')),
  ai_confidence numeric(3,2) check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  ai_explanation text check (ai_explanation is null or length(ai_explanation) <= 400),
  manual_decision text check (manual_decision is null or manual_decision in ('approved', 'blocked')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Publication-fee records: one per wedding when published; immutable
create table if not exists public.publication_fees (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'waived')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- RLS: Authenticated users can read and write own profile; workspace members can read/write wedding details
alter table public.guest_rsvps enable row level security;
create policy guest_rsvps_insert_anonymous on public.guest_rsvps
  for insert with check (true);
create policy guest_rsvps_select_published on public.guest_rsvps
  for select using (public.is_published_wedding(wedding_id));

alter table public.dj_song_bids enable row level security;
create policy dj_bids_insert_published on public.dj_song_bids
  for insert with check (public.is_published_wedding(wedding_id));
create policy dj_bids_select_published on public.dj_song_bids
  for select using (public.is_published_wedding(wedding_id));

alter table public.guest_site_content enable row level security;
create policy guest_site_content_select_owner_admin on public.guest_site_content
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (
        select 1 from public.wedding_memberships m
        where m.wedding_id = guest_site_content.wedding_id
          and m.user_id = auth.uid()
          and m.role in ('client', 'admin')
      )
    )
  );
create policy guest_site_content_update_owner_admin on public.guest_site_content
  for update using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or (
        exists (
          select 1 from public.wedding_memberships m
          where m.wedding_id = guest_site_content.wedding_id
            and m.user_id = auth.uid()
            and m.role = 'client'
        )
        and exists (
          select 1 from public.weddings w
          where w.id = guest_site_content.wedding_id
            and w.client_owner_id = auth.uid()
        )
      )
    )
  );

alter table public.content_review_records enable row level security;
create policy content_review_records_select_workspace on public.content_review_records
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (
        select 1 from public.wedding_memberships m
        where m.wedding_id = content_review_records.wedding_id
          and m.user_id = auth.uid()
      )
    )
  );

alter table public.publication_fees enable row level security;
create policy publication_fees_select_workspace on public.publication_fees
  for select using (
    auth.uid() is not null and (
      public.current_platform_role() in ('owner', 'superadmin')
      or exists (
        select 1 from public.wedding_memberships m
        where m.wedding_id = publication_fees.wedding_id
          and m.user_id = auth.uid()
          and m.role in ('client', 'admin')
      )
    )
  );
create policy publication_fees_select_owner on public.publication_fees
  for select using (
    exists (
      select 1 from public.weddings w
      where w.id = publication_fees.wedding_id
        and w.client_owner_id = auth.uid()
    )
  );

-- Functions to support launch workflows

-- Rank DJ bids by total amount and update rank_position atomically
create or replace function public.rank_dj_bids_for_wedding(p_wedding_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_bid record;
  v_rank integer := 1;
begin
  for v_bid in
    select id from public.dj_song_bids
    where wedding_id = p_wedding_id and status = 'submitted'
    order by bid_amount_minor desc, created_at asc
  loop
    update public.dj_song_bids
    set rank_position = v_rank, status = 'ranked'
    where id = v_bid.id;
    v_rank := v_rank + 1;
  end loop;
end;
$$;

-- Atomic check: can we accept this RSVP given current guest count and capacity?
create or replace function public.accept_rsvp_with_capacity_check(
  p_wedding_id uuid,
  p_guest_email text,
  p_guest_name text,
  p_dietary_requested boolean,
  p_plus_one_count integer
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_capacity integer;
  v_current_count integer;
  v_new_count integer;
  v_rsvp_id uuid;
begin
  -- Verify wedding is published
  if not public.is_published_wedding(p_wedding_id) then
    raise exception 'Cannot RSVP to an unpublished wedding.';
  end if;

  -- Lock the wedding row to enforce capacity atomically
  select max_guest_capacity into v_capacity
  from public.weddings
  where id = p_wedding_id
  for update;

  if v_capacity is null then
    raise exception 'Wedding not found.';
  end if;

  -- Count current RSVPs with attendance = 'yes'
  select count(1) + coalesce(sum(plus_one_count), 0) into v_current_count
  from public.guest_rsvps
  where wedding_id = p_wedding_id and attendance_status = 'yes';

  v_new_count := v_current_count + 1 + coalesce(p_plus_one_count, 0);

  if v_new_count > v_capacity then
    raise exception 'Guest capacity reached. Cannot accept this RSVP.';
  end if;

  -- Insert or update RSVP
  insert into public.guest_rsvps
    (wedding_id, guest_email, guest_name, attendance_status, dietary_accommodation_requested, plus_one_count, rsvped_at)
  values (p_wedding_id, lower(p_guest_email), p_guest_name, 'yes', p_dietary_requested, coalesce(p_plus_one_count, 0), now())
  on conflict (wedding_id, guest_email) do update
  set attendance_status = 'yes', dietary_accommodation_requested = p_dietary_requested,
      plus_one_count = coalesce(p_plus_one_count, 0), rsvped_at = now()
  returning id into v_rsvp_id;

  return v_rsvp_id;
end;
$$;

-- Publish a wedding: atomically move it to published state and charge publication fee
create or replace function public.publish_wedding_with_fee(
  p_wedding_id uuid,
  p_confirmed boolean
) returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_policy_fee bigint;
  v_currency char(3);
  v_can_publish boolean;
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to publish a wedding.';
  end if;

  if not (
    public.current_platform_role() = 'owner'
    or exists (
      select 1 from public.weddings w
      where w.id = p_wedding_id and w.client_owner_id = auth.uid()
    )
  ) then
    raise exception 'Only the Client or protected Owner can publish this wedding.';
  end if;

  select pp.publication_fee_minor, w.currency into v_policy_fee, v_currency
  from public.platform_policies pp, public.weddings w
  where pp.id = true and w.id = p_wedding_id;

  if v_currency is null then
    raise exception 'Wedding not found or currency is missing.';
  end if;

  -- Lock the wedding to ensure idempotent publish
  update public.weddings
  set published_at = coalesce(published_at, now())
  where id = p_wedding_id and published_at is null;

  if not found then
    -- Wedding already published; return true (idempotent)
    return true;
  end if;

  -- Record the publication fee
  insert into public.publication_fees (wedding_id, amount_minor, currency, status)
  values (p_wedding_id, v_policy_fee, v_currency, 'pending')
  on conflict do nothing;

  return true;
end;
$$;

-- Helper: Get paginated published contributions (guest ledger view)
create or replace function public.get_published_contributions_page(
  p_wedding_id uuid,
  p_offset integer default 0,
  p_limit integer default 10
) returns table (
  guest_display_name text,
  pledged_amount_minor bigint,
  paid_amount_minor bigint,
  currency char(3),
  payment_status text,
  created_at timestamptz
) language sql stable security definer set search_path = ''
as $$
  select
    c.display_name,
    c.pledged_amount_minor,
    c.paid_amount_minor,
    c.currency,
    c.payment_status::text,
    c.created_at
  from public.contributions c
  where c.wedding_id = p_wedding_id
    and public.is_published_wedding(p_wedding_id)
    and c.visibility in ('name', 'anonymous')
    and c.public_consent_at is not null
  order by c.paid_at desc nulls last, c.created_at desc
  limit p_limit offset p_offset;
$$;
