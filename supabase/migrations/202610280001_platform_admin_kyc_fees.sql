-- Admin/Owner back office, KYC capture, publication fee policy, unpublish/archive, test-mode payments.
-- Idempotent and additive: safe to re-run.

-- ---------------------------------------------------------------- weddings
alter table public.weddings add column if not exists archived_at timestamptz;
alter table public.weddings add column if not exists unpublished_at timestamptz;
alter table public.weddings add column if not exists first_published_at timestamptz;
update public.weddings set first_published_at = published_at where first_published_at is null and published_at is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'weddings_date_required') then
    alter table public.weddings add constraint weddings_date_required check (wedding_date is not null) not valid;
  end if;
end $$;

alter table public.venues add column if not exists event_date date;

-- Weddings are never deleted by anyone through the API: archive or unpublish instead.
revoke delete on public.weddings from anon, authenticated;
create or replace function public.block_wedding_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Weddings are never deleted. Archive or unpublish the wedding instead.';
end $$;
drop trigger if exists weddings_no_delete on public.weddings;
create trigger weddings_no_delete before delete on public.weddings
  for each row execute function public.block_wedding_delete();

grant update (archived_at, unpublished_at, first_published_at) on public.weddings to authenticated;

-- Admins may read every wedding workspace (writes still need client ownership or Owner/SuperAdmin).
create or replace function public.can_access_wedding(p_wedding_id uuid)
returns boolean language sql stable security definer set search_path = ''
set row_security = off
as $$
  select coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false)
    or exists (
      select 1 from public.wedding_memberships m
      where m.wedding_id = p_wedding_id and m.user_id = auth.uid()
    )
$$;

-- ---------------------------------------------------------------- fee policy
alter table public.platform_policies add column if not exists far_future_months integer not null default 18
  check (far_future_months between 1 and 120);
alter table public.platform_policies add column if not exists far_future_fee_minor bigint not null default 5000
  check (far_future_fee_minor between 0 and 100000000);
alter table public.platform_policies add column if not exists free_publications_per_client integer not null default 1
  check (free_publications_per_client between 0 and 100);

alter table public.publication_fees add column if not exists provider text;
alter table public.publication_fees add column if not exists reason_code text;

-- Fee rule (single source of truth, used by the UI quote and by publishing):
--   1. fee already paid/waived for this wedding            -> 0
--   2. wedding date is beyond far_future_months from today -> far_future_fee_minor (overrides the allowance)
--   3. client has published fewer than N weddings so far   -> 0 (free allowance)
--   4. otherwise                                           -> publication_fee_minor (per wedding)
create or replace function public.publication_quote_internal(p_wedding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare
  w public.weddings;
  pp public.platform_policies;
  v_prior integer;
  v_status text;
  v_fee bigint;
  v_code text;
  v_reason text;
begin
  select * into w from public.weddings where id = p_wedding_id;
  if not found then raise exception 'Wedding not found.'; end if;
  select * into pp from public.platform_policies where id;
  select count(*) into v_prior from public.weddings x
    where x.client_owner_id = w.client_owner_id and x.id <> w.id and x.first_published_at is not null;
  select status into v_status from public.publication_fees where wedding_id = p_wedding_id;

  if v_status in ('paid', 'waived') then
    v_fee := 0; v_code := 'settled'; v_reason := 'The publication fee for this wedding is already ' || v_status || '.';
  elsif w.wedding_date is not null and w.wedding_date > (current_date + make_interval(months => pp.far_future_months))::date then
    v_fee := pp.far_future_fee_minor; v_code := 'far_future';
    v_reason := 'Your wedding is more than ' || pp.far_future_months || ' months away, so the far-future fee applies.';
  elsif v_prior < pp.free_publications_per_client then
    v_fee := 0; v_code := 'free_allowance';
    v_reason := 'Your first ' || pp.free_publications_per_client || ' published wedding(s) are free. You have published ' || v_prior || ' so far.';
  else
    v_fee := pp.publication_fee_minor; v_code := 'per_wedding';
    v_reason := 'You have used your ' || pp.free_publications_per_client || ' free publication(s), so the per-wedding fee applies.';
  end if;
  return jsonb_build_object(
    'fee_minor', v_fee, 'currency', w.currency, 'code', v_code, 'reason', v_reason,
    'status', coalesce(v_status, 'none'), 'prior_published', v_prior,
    'far_future_months', pp.far_future_months, 'free_publications_per_client', pp.free_publications_per_client);
end $$;
revoke all on function public.publication_quote_internal(uuid) from public, anon, authenticated;

create or replace function public.publication_quote(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if auth.uid() is null or not (public.current_platform_role() in ('owner', 'superadmin', 'admin')
      or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())) then
    raise exception 'Access denied.';
  end if;
  return public.publication_quote_internal(p_wedding_id);
end $$;
revoke all on function public.publication_quote(uuid) from public, anon;
grant execute on function public.publication_quote(uuid) to authenticated;

-- ---------------------------------------------------------------- KYC (private)
create table if not exists public.wedding_kyc (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  partner1_legal_name text check (length(partner1_legal_name) <= 120),
  partner2_legal_name text check (length(partner2_legal_name) <= 120),
  id_type text check (id_type in ('national_id', 'passport', 'other')),
  id_number text check (length(id_number) <= 40),
  nationality text check (length(nationality) <= 60),
  phone text check (length(phone) <= 30),
  email text check (length(email) <= 254),
  contact_name text check (length(contact_name) <= 120),
  contact_phone text check (length(contact_phone) <= 30),
  next_of_kin_name text check (length(next_of_kin_name) <= 120),
  next_of_kin_phone text check (length(next_of_kin_phone) <= 30),
  next_of_kin_relation text check (length(next_of_kin_relation) <= 60),
  consent_at timestamptz,
  consent_version text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.wedding_kyc enable row level security;
revoke all on public.wedding_kyc from anon, authenticated;

create or replace function public.kyc_is_complete(p_wedding_id uuid) returns boolean
language sql stable security definer set search_path = '' set row_security = off
as $$
  select exists (
    select 1 from public.wedding_kyc k
    where k.wedding_id = p_wedding_id
      and length(coalesce(k.partner1_legal_name, '')) > 1 and length(coalesce(k.partner2_legal_name, '')) > 1
      and k.id_type is not null and length(coalesce(k.id_number, '')) >= 4
      and length(coalesce(k.nationality, '')) > 1 and length(coalesce(k.phone, '')) >= 7
      and length(coalesce(k.email, '')) > 4 and k.consent_at is not null);
$$;

create or replace function public.mask_id_number(p text) returns text language sql immutable set search_path = ''
as $$ select case when p is null or p = '' then null when length(p) <= 4 then repeat('•', length(p))
  else repeat('•', length(p) - 4) || right(p, 4) end $$;

create or replace function public.get_wedding_kyc(p_wedding_id uuid, p_reveal boolean default false)
returns jsonb language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  k public.wedding_kyc;
  v_role public.platform_role := public.current_platform_role();
  v_is_client boolean;
  v_staff boolean := coalesce(v_role in ('owner', 'superadmin', 'admin'), false);
  v_show boolean;
begin
  select exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid()) into v_is_client;
  if auth.uid() is null or not (v_is_client or v_staff) then raise exception 'Access denied.'; end if;
  select * into k from public.wedding_kyc where wedding_id = p_wedding_id;
  if not found then return jsonb_build_object('exists', false, 'complete', false); end if;
  v_show := coalesce(p_reveal, false) and v_staff;
  if v_show then
    insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (p_wedding_id, auth.uid(), 'user', 'kyc_reveal', 'wedding_kyc', p_wedding_id::text, '{}');
  end if;
  return jsonb_build_object(
    'exists', true, 'complete', public.kyc_is_complete(p_wedding_id),
    'partner1_legal_name', k.partner1_legal_name, 'partner2_legal_name', k.partner2_legal_name,
    'id_type', k.id_type, 'id_number', case when v_show then k.id_number else null end,
    'id_number_masked', public.mask_id_number(k.id_number),
    'nationality', k.nationality, 'phone', k.phone, 'email', k.email,
    'contact_name', k.contact_name, 'contact_phone', k.contact_phone,
    'next_of_kin_name', k.next_of_kin_name, 'next_of_kin_phone', k.next_of_kin_phone,
    'next_of_kin_relation', k.next_of_kin_relation,
    'consent_at', k.consent_at, 'consent_version', k.consent_version);
end $$;
revoke all on function public.get_wedding_kyc(uuid, boolean) from public, anon;
grant execute on function public.get_wedding_kyc(uuid, boolean) to authenticated;

create or replace function public.save_wedding_kyc(p_wedding_id uuid, p_data jsonb, p_consent boolean)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  old public.wedding_kyc;
  v_id text := nullif(trim(coalesce(p_data->>'id_number', '')), '');
begin
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then raise exception 'Only the wedding organizer can save these details.'; end if;
  select * into old from public.wedding_kyc where wedding_id = p_wedding_id;
  if v_id is not null and v_id like '%•%' then v_id := old.id_number; end if;
  if p_data->>'id_type' is not null and p_data->>'id_type' not in ('national_id', 'passport', 'other') then
    raise exception 'Choose a valid ID type.';
  end if;
  insert into public.wedding_kyc (wedding_id, partner1_legal_name, partner2_legal_name, id_type, id_number, nationality,
    phone, email, contact_name, contact_phone, next_of_kin_name, next_of_kin_phone, next_of_kin_relation,
    consent_at, consent_version, updated_by, updated_at)
  values (p_wedding_id,
    nullif(trim(p_data->>'partner1_legal_name'), ''), nullif(trim(p_data->>'partner2_legal_name'), ''),
    nullif(p_data->>'id_type', ''), v_id, nullif(trim(p_data->>'nationality'), ''),
    nullif(trim(p_data->>'phone'), ''), nullif(lower(trim(p_data->>'email')), ''),
    nullif(trim(p_data->>'contact_name'), ''), nullif(trim(p_data->>'contact_phone'), ''),
    nullif(trim(p_data->>'next_of_kin_name'), ''), nullif(trim(p_data->>'next_of_kin_phone'), ''),
    nullif(trim(p_data->>'next_of_kin_relation'), ''),
    case when coalesce(p_consent, false) then now() end, case when coalesce(p_consent, false) then 'v1' end,
    auth.uid(), now())
  on conflict (wedding_id) do update set
    partner1_legal_name = excluded.partner1_legal_name, partner2_legal_name = excluded.partner2_legal_name,
    id_type = excluded.id_type, id_number = excluded.id_number, nationality = excluded.nationality,
    phone = excluded.phone, email = excluded.email, contact_name = excluded.contact_name,
    contact_phone = excluded.contact_phone, next_of_kin_name = excluded.next_of_kin_name,
    next_of_kin_phone = excluded.next_of_kin_phone, next_of_kin_relation = excluded.next_of_kin_relation,
    consent_at = coalesce(excluded.consent_at, public.wedding_kyc.consent_at),
    consent_version = coalesce(excluded.consent_version, public.wedding_kyc.consent_version),
    updated_by = auth.uid(), updated_at = now();
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'kyc_update', 'wedding_kyc', p_wedding_id::text, '{}');
  return true;
end $$;
revoke all on function public.save_wedding_kyc(uuid, jsonb, boolean) from public, anon;
grant execute on function public.save_wedding_kyc(uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- publish / unpublish / archive
create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  q jsonb;
  v_fee bigint;
  v_staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin'), false);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to publish a wedding.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  if auth.uid() is null or not (v_staff or w.client_owner_id = auth.uid()) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;
  if w.archived_at is not null then raise exception 'Restore the archived wedding before publishing.'; end if;
  if w.slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;
  if w.wedding_date is null then raise exception 'Set the wedding date before publishing.'; end if;
  if not v_staff and not public.kyc_is_complete(p_wedding_id) then
    raise exception 'Complete the couple verification details (legal names, ID, contact) before publishing.';
  end if;

  q := public.publication_quote_internal(p_wedding_id);
  v_fee := (q->>'fee_minor')::bigint;
  if v_fee > 0 then
    if v_staff then
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'waived', now(), 'staff-waiver', q->>'code')
      on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
    else
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'pending', q->>'code')
      on conflict (wedding_id) do update set amount_minor = excluded.amount_minor, reason_code = excluded.reason_code
        where public.publication_fees.status = 'pending';
      raise exception 'PAYMENT_REQUIRED: %', q->>'reason';
    end if;
  end if;
  update public.weddings set published_at = coalesce(published_at, now()), unpublished_at = null,
    first_published_at = coalesce(first_published_at, now()) where id = p_wedding_id;
  return true;
end $$;
grant execute on function public.publish_wedding_with_fee(uuid, boolean) to authenticated;

create or replace function public.unpublish_wedding(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to unpublish a wedding.'; end if;
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin', 'admin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then raise exception 'Only the Client or platform staff can unpublish this wedding.'; end if;
  update public.weddings set published_at = null, unpublished_at = now() where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'unpublish', 'weddings', p_wedding_id::text, '{}');
  return true;
end $$;
revoke all on function public.unpublish_wedding(uuid, boolean) from public, anon;
grant execute on function public.unpublish_wedding(uuid, boolean) to authenticated;

create or replace function public.archive_wedding(p_wedding_id uuid, p_archived boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin', 'admin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then raise exception 'Only the Client or platform staff can archive this wedding.'; end if;
  update public.weddings set
    archived_at = case when coalesce(p_archived, true) then now() else null end,
    published_at = case when coalesce(p_archived, true) then null else published_at end,
    unpublished_at = case when coalesce(p_archived, true) and published_at is not null then now() else unpublished_at end
  where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', case when coalesce(p_archived, true) then 'archive' else 'restore' end,
    'weddings', p_wedding_id::text, '{}');
  return true;
end $$;
revoke all on function public.archive_wedding(uuid, boolean) from public, anon;
grant execute on function public.archive_wedding(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- test-mode payments (service role only)
create or replace function public.record_test_publication_payment(p_wedding_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare w public.weddings; q jsonb; v_fee bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  q := public.publication_quote_internal(p_wedding_id);
  v_fee := (q->>'fee_minor')::bigint;
  if v_fee > 0 then
    insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider, reason_code)
    values (p_wedding_id, v_fee, w.currency, 'paid', now(), 'test-simulator', q->>'code')
    on conflict (wedding_id) do update set status = 'paid', paid_at = now(), provider = 'test-simulator',
      amount_minor = excluded.amount_minor, reason_code = excluded.reason_code;
  end if;
  return q;
end $$;
revoke all on function public.record_test_publication_payment(uuid) from public, anon, authenticated;
grant execute on function public.record_test_publication_payment(uuid) to service_role;

create or replace function public.record_test_purchase(
  p_kind text, p_wedding_id uuid, p_ref uuid, p_name text, p_email text, p_amount_minor bigint, p_extra jsonb
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  bps integer;
  fee bigint;
  v_id uuid := extensions.gen_random_uuid();
  v_stream text;
  v_vis text := coalesce(p_extra->>'visibility', 'hidden');
  vip public.vip_offers;
  tier public.sponsor_tiers;
  item public.registry_items;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id;
  if not found or w.published_at is null then raise exception 'This wedding is not accepting payments.'; end if;
  if w.wedding_date < (now() at time zone w.time_zone)::date then raise exception 'This wedding has taken place; contributions are closed.'; end if;
  if v_vis not in ('name', 'anonymous', 'hidden') then v_vis := 'hidden'; end if;
  select contribution_fee_basis_points into bps from public.platform_policies where id;

  if p_kind = 'vip' then
    select * into vip from public.vip_offers where id = p_ref and wedding_id = p_wedding_id for update;
    if not found then raise exception 'VIP offer not found.'; end if;
    if vip.seats_sold >= vip.seats_total then raise exception 'VIP seating is sold out.'; end if;
    if p_amount_minor <> vip.price_minor then raise exception 'Amount must equal the VIP seat price.'; end if;
    v_stream := 'VIP seating';
  elsif p_kind = 'sponsor' then
    select * into tier from public.sponsor_tiers where id = p_ref and wedding_id = p_wedding_id;
    if not found then raise exception 'Sponsorship tier not found.'; end if;
    if p_amount_minor < tier.min_amount_minor then raise exception 'Amount is below the tier minimum.'; end if;
    v_stream := left('Sponsorship: ' || tier.name, 100);
  elsif p_kind = 'pledge' then
    select * into item from public.registry_items where id = p_ref and wedding_id = p_wedding_id;
    if not found then raise exception 'Registry item not found.'; end if;
    v_stream := left(item.name, 100);
  else
    raise exception 'Unknown purchase type.';
  end if;

  fee := round(p_amount_minor::numeric * bps / 10000)::bigint;
  insert into public.contributions (id, wedding_id, stream_name, pledged_amount_minor, paid_amount_minor,
    platform_fee_basis_points, platform_fee_minor, net_paid_minor, currency, payment_status, display_name,
    visibility, public_consent_at, provider_name, provider_reference, paid_at, funds_available_at)
  values (v_id, p_wedding_id, v_stream, p_amount_minor, p_amount_minor, bps, fee, p_amount_minor - fee, w.currency,
    'paid', coalesce(nullif(left(trim(p_name), 100), ''), 'Anonymous guest'),
    v_vis, case when v_vis <> 'hidden' then now() end, 'test-simulator', 'TEST-' || v_id::text, now(), now());

  if p_kind = 'vip' then
    update public.vip_offers set seats_sold = seats_sold + 1 where id = vip.id;
    insert into public.vip_reservations (vip_offer_id, guest_name, guest_email, amount_minor, contribution_id)
    values (vip.id, left(coalesce(nullif(trim(p_name), ''), 'Guest'), 100), nullif(left(p_email, 200), ''), p_amount_minor, v_id);
  elsif p_kind = 'sponsor' then
    insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, website, amount_minor, tier_id, contribution_id)
    values (p_wedding_id, left(coalesce(nullif(trim(p_name), ''), 'Sponsor'), 100), nullif(left(p_email, 200), ''),
      nullif(left(p_extra->>'phone', 20), ''), nullif(left(p_extra->>'website', 300), ''), p_amount_minor, tier.id, v_id);
  end if;
  return v_id;
end $$;
revoke all on function public.record_test_purchase(text, uuid, uuid, text, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.record_test_purchase(text, uuid, uuid, text, text, bigint, jsonb) to service_role;

-- ---------------------------------------------------------------- public listing + site
drop function if exists public.list_published_weddings_paginated(integer, integer);
create or replace function public.list_published_weddings_paginated(p_offset integer default 0, p_limit integer default 12)
returns table(id uuid, slug text, couple_names text, wedding_date date, time_zone text, public_location text,
  currency text, palette text[], published_at timestamptz, created_at timestamptz, is_past boolean)
language sql stable security definer set search_path = '' set row_security = off
as $$
  select w.id, w.slug, w.couple_names, w.wedding_date, w.time_zone, w.public_location, w.currency, w.palette,
         w.published_at, w.created_at,
         (w.wedding_date < (now() at time zone w.time_zone)::date) as is_past
  from public.weddings as w
  where w.published_at is not null and w.archived_at is null and w.slug is not null
  order by (w.wedding_date < (now() at time zone w.time_zone)::date) asc, w.wedding_date asc nulls last, w.published_at desc
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;
revoke all on function public.list_published_weddings_paginated(integer, integer) from public;
grant execute on function public.list_published_weddings_paginated(integer, integer) to anon, authenticated;

create or replace function public.get_public_wedding_site(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id, 'slug', w.slug, 'couple_names', w.couple_names, 'welcome_story', w.welcome_story,
    'wedding_date', w.wedding_date, 'public_location', w.public_location, 'currency', w.currency,
    'max_guest_capacity', w.max_guest_capacity, 'palette', to_jsonb(w.palette), 'attire_notes', w.attire_notes,
    'time_zone', w.time_zone, 'background_music_url', w.background_music_url,
    'is_past', (w.wedding_date < (now() at time zone w.time_zone)::date),
    'accepting_rsvps', (
      select coalesce(sum(1 + r.plus_one_count), 0) < w.max_guest_capacity
      from public.guest_rsvps r where r.wedding_id = w.id and r.attendance_status = 'yes'
    ) and not (w.wedding_date < (now() at time zone w.time_zone)::date),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'event_time', v.event_time, 'event_date', coalesce(v.event_date, w.wedding_date),
        'map_link', v.map_link, 'description', v.description, 'is_main', v.is_main
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

-- Pass lookup by email for the same device/other device (returns only the pass code, name and status).
create or replace function public.lookup_guest_pass(p_wedding_id uuid, p_email text)
returns table (rsvp_id uuid, guest_name text, attendance_status text)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.guest_name, r.attendance_status::text from public.guest_rsvps r
  where r.wedding_id = p_wedding_id and r.guest_email = lower(trim(p_email)) and public.is_published_wedding(p_wedding_id);
$$;
grant execute on function public.lookup_guest_pass(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------- admin / owner back office
create or replace function public.require_staff(p_min text default 'admin') returns public.platform_role
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.current_platform_role();
begin
  if auth.uid() is null or r is null or r = 'client' then raise exception 'Staff access required.'; end if;
  if p_min = 'owner' and r <> 'owner' then raise exception 'Owner access required.'; end if;
  if p_min = 'superadmin' and r not in ('owner', 'superadmin') then raise exception 'SuperAdmin access required.'; end if;
  return r;
end $$;
revoke all on function public.require_staff(text) from public, anon;
grant execute on function public.require_staff(text) to authenticated;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return jsonb_build_object(
    'weddings', (select count(*) from public.weddings),
    'published', (select count(*) from public.weddings where published_at is not null),
    'archived', (select count(*) from public.weddings where archived_at is not null),
    'past', (select count(*) from public.weddings w where w.wedding_date < (now() at time zone w.time_zone)::date),
    'users', (select count(*) from public.profiles where platform_role <> 'owner'),
    'admins', (select count(*) from public.profiles where platform_role in ('admin', 'superadmin')),
    'rsvps', (select count(*) from public.guest_rsvps),
    'bids', (select count(*) from public.dj_song_bids),
    'collected_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
        select currency, sum(paid_amount_minor) t from public.contributions where payment_status = 'paid' group by currency) x), '{}'::jsonb),
    'fees_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
        select currency, sum(platform_fee_minor) t from public.contributions where payment_status = 'paid' group by currency) x), '{}'::jsonb),
    'publication_fees_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
        select currency, sum(amount_minor) t from public.publication_fees where status = 'paid' group by currency) x), '{}'::jsonb),
    'pending_payouts', (select count(*) from public.payout_records where status = 'requested'),
    'test_payments', (select count(*) from public.contributions where provider_name = 'test-simulator'));
end $$;

create or replace function public.admin_list_weddings() returns table (
  id uuid, slug text, couple_names text, wedding_date date, time_zone text, currency text, owner_email text,
  published_at timestamptz, archived_at timestamptz, is_past boolean, rsvps bigint, bids bigint,
  collected_minor bigint, fee_status text, kyc_complete boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return query select w.id, w.slug, w.couple_names, w.wedding_date, w.time_zone, w.currency::text, u.email::text,
    w.published_at, w.archived_at, (w.wedding_date < (now() at time zone w.time_zone)::date),
    (select count(*) from public.guest_rsvps r where r.wedding_id = w.id),
    (select count(*) from public.dj_song_bids b where b.wedding_id = w.id),
    coalesce((select sum(c.paid_amount_minor) from public.contributions c where c.wedding_id = w.id and c.payment_status = 'paid'), 0)::bigint,
    coalesce((select f.status from public.publication_fees f where f.wedding_id = w.id), 'none'),
    public.kyc_is_complete(w.id), w.created_at
  from public.weddings w left join auth.users u on u.id = w.client_owner_id
  order by w.created_at desc limit 500;
end $$;

create or replace function public.admin_list_users(p_search text default null) returns table (
  id uuid, email text, display_name text, platform_role text, wedding_count bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.require_staff();
begin
  return query select p.id, u.email::text, p.display_name, p.platform_role::text,
    (select count(*) from public.weddings w where w.client_owner_id = p.id), p.created_at
  from public.profiles p left join auth.users u on u.id = p.id
  where (r = 'owner' or p.platform_role <> 'owner')
    and (p_search is null or p_search = '' or u.email ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%')
  order by p.created_at desc limit 300;
end $$;

create or replace function public.admin_set_role(p_user_id uuid, p_role text) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.require_staff('superadmin'); ok boolean;
begin
  if p_role not in ('client', 'admin', 'superadmin') then raise exception 'Choose client, admin or superadmin.'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role.'; end if;
  ok := public.assign_platform_role(p_user_id, p_role::public.platform_role);
  if ok then
    insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
    values (auth.uid(), 'user', 'role_change:' || p_role, 'profiles', p_user_id::text, array['platform_role']);
  end if;
  return ok;
end $$;

create or replace function public.admin_ledger(p_limit integer default 200) returns table (
  id uuid, couple_names text, stream_name text, amount_minor bigint, fee_minor bigint, net_minor bigint,
  currency text, status text, provider text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return query select c.id, w.couple_names, c.stream_name, c.pledged_amount_minor, c.platform_fee_minor, c.net_paid_minor,
    c.currency::text, c.payment_status::text, c.provider_name, c.created_at
  from public.contributions c join public.weddings w on w.id = c.wedding_id
  order by c.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

create or replace function public.admin_payouts() returns table (
  id uuid, wedding_id uuid, couple_names text, amount_minor bigint, currency text, status text,
  requested_at timestamptz, note text, own_request boolean)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return query select p.id, p.wedding_id, w.couple_names, p.amount_minor, p.currency::text, p.status::text,
    p.requested_at, p.note, (p.requested_by = auth.uid())
  from public.payout_records p join public.weddings w on w.id = p.wedding_id
  order by p.requested_at desc limit 300;
end $$;

create or replace function public.admin_set_payout_status(p_payout_id uuid, p_status text, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare p public.payout_records;
begin
  perform public.require_staff();
  if p_status not in ('approved', 'sent', 'cancelled') then raise exception 'Invalid payout status.'; end if;
  select * into p from public.payout_records where id = p_payout_id for update;
  if not found then raise exception 'Payout not found.'; end if;
  if p.requested_by = auth.uid() and p_status in ('approved', 'sent') then
    raise exception 'Another staff member must approve a payout you requested.';
  end if;
  if not ((p.status = 'requested' and p_status in ('approved', 'cancelled'))
       or (p.status = 'approved' and p_status in ('sent', 'cancelled'))) then
    raise exception 'A % payout cannot move to %.', p.status, p_status;
  end if;
  update public.payout_records set status = p_status::public.payout_status, confirmed_by = auth.uid(),
    confirmed_at = now(), note = coalesce(left(p_note, 240), note) where id = p_payout_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p.wedding_id, auth.uid(), 'user', 'payout_' || p_status, 'payout_records', p_payout_id::text, array['status']);
  return true;
end $$;

create or replace function public.admin_audit(p_limit integer default 200) returns table (
  id bigint, created_at timestamptz, actor text, action text, table_name text, wedding_id uuid)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.require_staff();
begin
  return query select a.id, a.created_at,
    case when pr.platform_role = 'owner' and r <> 'owner' then 'Platform' else coalesce(u.email::text, 'system') end,
    a.action, a.table_name, a.wedding_id
  from public.audit_events a left join public.profiles pr on pr.id = a.actor_id left join auth.users u on u.id = a.actor_id
  order by a.created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

create or replace function public.admin_get_policies() returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return (select to_jsonb(pp) - 'updated_by' from public.platform_policies pp where pp.id);
end $$;

create or replace function public.admin_save_policies(p_data jsonb) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.require_staff();
begin
  update public.platform_policies set
    publication_fee_minor = coalesce((p_data->>'publication_fee_minor')::bigint, publication_fee_minor),
    far_future_months = coalesce((p_data->>'far_future_months')::int, far_future_months),
    far_future_fee_minor = coalesce((p_data->>'far_future_fee_minor')::bigint, far_future_fee_minor),
    free_publications_per_client = coalesce((p_data->>'free_publications_per_client')::int, free_publications_per_client),
    contribution_fee_basis_points = coalesce((p_data->>'contribution_fee_basis_points')::int, contribution_fee_basis_points),
    max_contribution_minor = case when r in ('owner', 'superadmin') then coalesce((p_data->>'max_contribution_minor')::bigint, max_contribution_minor) else max_contribution_minor end,
    max_payout_minor = case when r in ('owner', 'superadmin') then coalesce((p_data->>'max_payout_minor')::bigint, max_payout_minor) else max_payout_minor end,
    max_wedding_capacity = case when r in ('owner', 'superadmin') then coalesce((p_data->>'max_wedding_capacity')::int, max_wedding_capacity) else max_wedding_capacity end,
    updated_by = auth.uid(), updated_at = now()
  where id;
  insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
  values (auth.uid(), 'user', 'policy_update', 'platform_policies', 'true', array(select jsonb_object_keys(p_data)));
  return true;
end $$;

create or replace function public.admin_wedding_action(p_wedding_id uuid, p_action text) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  if p_action = 'archive' then update public.weddings set archived_at = now(), published_at = null where id = p_wedding_id;
  elsif p_action = 'restore' then update public.weddings set archived_at = null where id = p_wedding_id;
  elsif p_action = 'unpublish' then update public.weddings set published_at = null, unpublished_at = now() where id = p_wedding_id;
  elsif p_action = 'waive_fee' then
    insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider)
    select w.id, 1, w.currency, 'waived', now(), 'staff-waiver' from public.weddings w where w.id = p_wedding_id
    on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
  else raise exception 'Unknown action.';
  end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'admin_' || p_action, 'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_overview()', 'admin_list_weddings()', 'admin_list_users(text)', 'admin_set_role(uuid, text)',
    'admin_ledger(integer)', 'admin_payouts()', 'admin_set_payout_status(uuid, text, text)', 'admin_audit(integer)',
    'admin_get_policies()', 'admin_save_policies(jsonb)', 'admin_wedding_action(uuid, text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
