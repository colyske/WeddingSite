-- Referral tracking, guestbook with moderation, FAQ/travel info, visit analytics. Idempotent.

alter table public.weddings add column if not exists faq jsonb not null default '[]'::jsonb;
alter table public.weddings add column if not exists travel_info text check (travel_info is null or length(travel_info) <= 2000);

-- Short, non-PII, random personal share code per RSVP.
alter table public.guest_rsvps add column if not exists ref_code text;
alter table public.guest_rsvps add column if not exists referred_by_code text;

create or replace function public.set_rsvp_ref_code()
returns trigger language plpgsql as $$
begin
  if new.ref_code is null then
    new.ref_code := substr(md5(extensions.gen_random_uuid()::text), 1, 8);
  end if;
  return new;
end $$;

drop trigger if exists trg_rsvp_ref_code on public.guest_rsvps;
create trigger trg_rsvp_ref_code before insert on public.guest_rsvps
  for each row execute function public.set_rsvp_ref_code();

update public.guest_rsvps set ref_code = substr(md5(extensions.gen_random_uuid()::text), 1, 8) where ref_code is null;
create unique index if not exists uq_rsvp_ref_code on public.guest_rsvps (wedding_id, ref_code);

-- Visits: only salted hashes are stored (never raw IPs); one row per visitor/ref/day.
create table if not exists public.site_visits (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  ref_code text not null default '',
  visitor_hash text not null,
  day date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now(),
  unique (wedding_id, ref_code, visitor_hash, day)
);
alter table public.site_visits enable row level security;

create table if not exists public.guest_wishes (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  author_name text not null check (length(author_name) between 1 and 80),
  message text not null check (length(message) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'hidden')),
  created_at timestamptz not null default now()
);
create index if not exists idx_guest_wishes_wedding on public.guest_wishes (wedding_id, status, created_at desc);
alter table public.guest_wishes enable row level security;

create or replace function public.can_manage_wedding(p_wedding_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.current_platform_role() in ('owner', 'superadmin', 'admin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  );
$$;
grant execute on function public.can_manage_wedding(uuid) to authenticated;

drop policy if exists guest_wishes_manage on public.guest_wishes;
create policy guest_wishes_manage on public.guest_wishes
  for all to authenticated
  using (public.can_manage_wedding(wedding_id))
  with check (public.can_manage_wedding(wedding_id));

-- Couple/admin view: inviter first name + counts only (no emails).
create or replace function public.referral_summary(p_wedding_id uuid)
returns table (guest_name text, ref_code text, visits bigint, rsvps_brought bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_manage_wedding(p_wedding_id) then raise exception 'Not allowed'; end if;
  return query
    select r.guest_name::text, r.ref_code,
      (select count(distinct v.visitor_hash) from public.site_visits v where v.wedding_id = r.wedding_id and v.ref_code = r.ref_code),
      (select count(*) from public.guest_rsvps x where x.wedding_id = r.wedding_id and x.referred_by_code = r.ref_code and x.attendance_status = 'yes')
    from public.guest_rsvps r
    where r.wedding_id = p_wedding_id
    order by 4 desc, 3 desc, r.created_at
    limit 100;
end $$;
grant execute on function public.referral_summary(uuid) to authenticated;

create or replace function public.wedding_analytics(p_wedding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.can_manage_wedding(p_wedding_id) then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'visitors', (select count(distinct visitor_hash) from public.site_visits where wedding_id = p_wedding_id),
    'referred_visitors', (select count(distinct visitor_hash) from public.site_visits where wedding_id = p_wedding_id and ref_code <> ''),
    'rsvps_confirmed', (select count(*) from public.guest_rsvps where wedding_id = p_wedding_id and attendance_status = 'yes'),
    'rsvps_declined', (select count(*) from public.guest_rsvps where wedding_id = p_wedding_id and attendance_status = 'no'),
    'rsvps_referred', (select count(*) from public.guest_rsvps where wedding_id = p_wedding_id and referred_by_code is not null),
    'bids', (select count(*) from public.dj_song_bids where wedding_id = p_wedding_id),
    'top_bid_minor', (select coalesce(max(bid_amount_minor), 0) from public.dj_song_bids where wedding_id = p_wedding_id),
    'wishes_pending', (select count(*) from public.guest_wishes where wedding_id = p_wedding_id and status = 'pending'),
    'wishes_approved', (select count(*) from public.guest_wishes where wedding_id = p_wedding_id and status = 'approved')
  ) into result;
  return result;
end $$;
grant execute on function public.wedding_analytics(uuid) to authenticated;
