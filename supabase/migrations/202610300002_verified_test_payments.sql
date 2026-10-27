-- Payment-gated guest actions, event dates, partner KYC, sponsor profiles and Owner policy controls.
-- No payment is considered complete until a provider event or server-side verification confirms it.

alter table public.contributions add column if not exists registry_item_id uuid
  references public.registry_items(id) on delete set null;
alter table public.contributions add column if not exists provider_fee_pending boolean not null default false;
alter table public.contributions add column if not exists verified_provider_payment boolean not null default false;
alter table public.contributions add column if not exists provider_fee_minor bigint
  check (provider_fee_minor is null or provider_fee_minor between 0 and 100000000000);
alter table public.contributions drop constraint if exists amount_consistency;
alter table public.contributions alter column payment_status drop default;
drop view if exists public.finance_summary;
drop view if exists public.public_contribution_ledger;
alter table public.contributions alter column payment_status type text using payment_status::text;
update public.contributions set payment_status = 'cancelled' where payment_status = 'pledged';
alter table public.contributions alter column payment_status set default 'pending';
alter table public.contributions drop constraint if exists contributions_payment_status_check;
alter table public.contributions add constraint contributions_payment_status_check
  check (payment_status in ('pending', 'paid', 'refunded', 'cancelled'));
alter table public.contributions add constraint amount_consistency check (
  (payment_status in ('pending', 'cancelled') and paid_amount_minor = 0 and platform_fee_minor = 0 and net_paid_minor = 0)
  or (payment_status = 'paid' and paid_amount_minor = pledged_amount_minor
      and platform_fee_minor + net_paid_minor = paid_amount_minor)
  or payment_status = 'refunded'
);
update public.contributions set provider_fee_pending = true
  where payment_status = 'paid' and provider_fee_minor is null;
drop function if exists public.record_test_rsvp_fees(uuid, text, jsonb);
drop function if exists public.record_test_campaign_pledge(uuid, uuid, uuid, text, bigint, text);
alter table public.vip_reservations add column if not exists payment_status text not null default 'paid'
  check (payment_status in ('pending', 'paid', 'cancelled'));
alter table public.vip_reservations add column if not exists expires_at timestamptz;

alter table public.venues add column if not exists event_type text;
update public.venues v
set event_date = w.wedding_date
from public.weddings w
where v.wedding_id = w.id and v.kind = 'main' and v.event_date is null;

alter table public.weddings drop constraint if exists weddings_palette_check;
alter table public.weddings drop constraint if exists weddings_palette_cardinality_check;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'weddings_palette_cardinality_check'
      and conrelid = 'public.weddings'::regclass) then
    alter table public.weddings add constraint weddings_palette_cardinality_check
      check (cardinality(palette) between 0 and 4 and array_position(palette, null) is null);
  end if;
end $$;

alter table public.venues drop constraint if exists venues_event_type_length;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venues_event_type_length'
      and conrelid = 'public.venues'::regclass) then
    alter table public.venues add constraint venues_event_type_length
      check (event_type is null or length(event_type) <= 60);
  end if;
end $$;

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
language plpgsql security definer set search_path = ''
as $$
declare
  v_wedding_id uuid;
  v_venue jsonb;
  v_name text;
  v_map_link text;
  v_address text;
  v_event_date date;
  v_event_time time;
  v_kind text;
  v_main_count integer := 0;
begin
  v_wedding_id := public.create_wedding(
    p_slug, p_couple_names, p_wedding_date, p_location, p_currency, p_capacity, p_palette
  );
  if jsonb_typeof(coalesce(p_venues, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_venues, '[]'::jsonb)) not between 1 and 30 then
    raise exception 'Add at least one event with a date, time and address.';
  end if;
  for v_venue in select value from jsonb_array_elements(p_venues)
  loop
    v_name := left(trim(coalesce(v_venue->>'name', '')), 100);
    v_map_link := nullif(trim(v_venue->>'mapLink'), '');
    v_address := nullif(left(trim(coalesce(v_venue->>'address', '')), 200), '');
    v_event_date := nullif(v_venue->>'eventDate', '')::date;
    v_event_time := nullif(v_venue->>'eventTime', '')::time;
    v_kind := case when v_venue->>'kind' = 'pre' then 'pre' else 'main' end;
    if v_name = '' or v_address is null or v_event_date is null or v_event_time is null then
      raise exception 'Every event needs a name, date, start time and street address.';
    end if;
    if v_map_link is not null and v_map_link !~ '^https?://' then
      raise exception 'Venue map links must use HTTP or HTTPS.';
    end if;
    if v_kind = 'main' then v_main_count := v_main_count + 1; end if;
    insert into public.venues (wedding_id, name, event_time, event_date, address, map_link,
      description, is_main, kind, sort_order)
    values (v_wedding_id, v_name, v_event_time, v_event_date, v_address,
      left(v_map_link, 500), left(nullif(v_venue->>'description', ''), 500),
      coalesce((v_venue->>'isMain')::boolean, false), v_kind,
      coalesce((v_venue->>'sortOrder')::integer, 0));
  end loop;
  if v_main_count = 0 then raise exception 'Add at least one wedding-day event.'; end if;
  return v_wedding_id;
end;
$$;

-- Each partner supplies their own identity and contact fields. Existing shared fields are
-- copied to partner 1 for backward compatibility; no data is deleted.
alter table public.wedding_kyc add column if not exists partner1_id_type text;
alter table public.wedding_kyc add column if not exists partner1_id_number text;
alter table public.wedding_kyc add column if not exists partner1_nationality text;
alter table public.wedding_kyc add column if not exists partner1_phone text;
alter table public.wedding_kyc add column if not exists partner1_email text;
alter table public.wedding_kyc add column if not exists partner2_id_type text;
alter table public.wedding_kyc add column if not exists partner2_id_number text;
alter table public.wedding_kyc add column if not exists partner2_nationality text;
alter table public.wedding_kyc add column if not exists partner2_phone text;
alter table public.wedding_kyc add column if not exists partner2_email text;
update public.wedding_kyc set
  partner1_id_type = coalesce(partner1_id_type, id_type),
  partner1_id_number = coalesce(partner1_id_number, id_number),
  partner1_nationality = coalesce(partner1_nationality, nationality),
  partner1_phone = coalesce(partner1_phone, phone),
  partner1_email = coalesce(partner1_email, email);

create or replace function public.kyc_is_complete(p_wedding_id uuid) returns boolean
language sql stable security definer set search_path = '' set row_security = off
as $$
  select exists (
    select 1 from public.wedding_kyc k
    where k.wedding_id = p_wedding_id
      and length(coalesce(k.partner1_legal_name, '')) > 1
      and length(coalesce(k.partner2_legal_name, '')) > 1
      and k.partner1_id_type in ('national_id', 'passport', 'other')
      and length(coalesce(k.partner1_id_number, '')) >= 4
      and length(coalesce(k.partner1_nationality, '')) > 1
      and length(coalesce(k.partner1_phone, '')) >= 7
      and length(coalesce(k.partner1_email, '')) > 4
      and k.partner2_id_type in ('national_id', 'passport', 'other')
      and length(coalesce(k.partner2_id_number, '')) >= 4
      and length(coalesce(k.partner2_nationality, '')) > 1
      and length(coalesce(k.partner2_phone, '')) >= 7
      and length(coalesce(k.partner2_email, '')) > 4
      and k.consent_at is not null
  );
$$;

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
  v_show := coalesce(p_reveal, false) and v_role in ('owner', 'superadmin');
  if v_show then
    insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (p_wedding_id, auth.uid(), 'user', 'kyc_reveal', 'wedding_kyc', p_wedding_id::text, '{}');
  end if;
  return jsonb_build_object(
    'exists', true, 'complete', public.kyc_is_complete(p_wedding_id),
    'partner1_legal_name', k.partner1_legal_name, 'partner2_legal_name', k.partner2_legal_name,
    'partner1_id_type', k.partner1_id_type, 'partner1_id_number', case when v_show then k.partner1_id_number else null end,
    'partner1_id_number_masked', public.mask_id_number(k.partner1_id_number),
    'partner1_nationality', k.partner1_nationality, 'partner1_phone', k.partner1_phone, 'partner1_email', k.partner1_email,
    'partner2_id_type', k.partner2_id_type, 'partner2_id_number', case when v_show then k.partner2_id_number else null end,
    'partner2_id_number_masked', public.mask_id_number(k.partner2_id_number),
    'partner2_nationality', k.partner2_nationality, 'partner2_phone', k.partner2_phone, 'partner2_email', k.partner2_email,
    'contact_name', k.contact_name, 'contact_phone', k.contact_phone,
    'next_of_kin_name', k.next_of_kin_name, 'next_of_kin_phone', k.next_of_kin_phone,
    'next_of_kin_relation', k.next_of_kin_relation, 'consent_at', k.consent_at, 'consent_version', k.consent_version
  );
end $$;

create or replace function public.save_wedding_kyc(p_wedding_id uuid, p_data jsonb, p_consent boolean)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  old public.wedding_kyc;
  p1id text := nullif(trim(coalesce(p_data->>'partner1_id_number', '')), '');
  p2id text := nullif(trim(coalesce(p_data->>'partner2_id_number', '')), '');
  staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin'), false);
begin
  if auth.uid() is null or not (
    public.current_platform_role() in ('owner', 'superadmin', 'admin')
    or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
  ) then raise exception 'Only an authorized organizer or platform staff member can save these details.'; end if;
  select * into old from public.wedding_kyc where wedding_id = p_wedding_id;
  if p1id like '%•%' then p1id := old.partner1_id_number; end if;
  if p2id like '%•%' then p2id := old.partner2_id_number; end if;
  if coalesce(p_data->>'partner1_id_type', '') not in ('national_id', 'passport', 'other')
     or coalesce(p_data->>'partner2_id_type', '') not in ('national_id', 'passport', 'other') then
    raise exception 'Choose a valid ID type for both partners.';
  end if;
  if length(trim(coalesce(p_data->>'partner1_legal_name', ''))) < 2
     or length(trim(coalesce(p_data->>'partner2_legal_name', ''))) < 2
     or length(coalesce(p1id, '')) < 4 or length(coalesce(p2id, '')) < 4
     or length(trim(coalesce(p_data->>'partner1_nationality', ''))) < 2
     or length(trim(coalesce(p_data->>'partner2_nationality', ''))) < 2
     or length(regexp_replace(coalesce(p_data->>'partner1_phone', ''), '[^0-9]', '', 'g')) not between 7 and 15
     or length(regexp_replace(coalesce(p_data->>'partner2_phone', ''), '[^0-9]', '', 'g')) not between 7 and 15
     or lower(trim(coalesce(p_data->>'partner1_email', ''))) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or lower(trim(coalesce(p_data->>'partner2_email', ''))) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Complete both partners’ legal name, ID, nationality, phone and email fields.';
  end if;
  if not coalesce(p_consent, false) then raise exception 'Both partners must consent to identity verification.'; end if;
  insert into public.wedding_kyc (wedding_id, partner1_legal_name, partner2_legal_name,
    partner1_id_type, partner1_id_number, partner1_nationality, partner1_phone, partner1_email,
    partner2_id_type, partner2_id_number, partner2_nationality, partner2_phone, partner2_email,
    id_type, id_number, nationality, phone, email, contact_name, contact_phone,
    next_of_kin_name, next_of_kin_phone, next_of_kin_relation,
    consent_at, consent_version, updated_by, updated_at)
  values (p_wedding_id, left(trim(p_data->>'partner1_legal_name'), 120), left(trim(p_data->>'partner2_legal_name'), 120),
    p_data->>'partner1_id_type', left(p1id, 40), left(trim(p_data->>'partner1_nationality'), 60),
    left(trim(p_data->>'partner1_phone'), 30), left(lower(trim(p_data->>'partner1_email')), 254),
    p_data->>'partner2_id_type', left(p2id, 40), left(trim(p_data->>'partner2_nationality'), 60),
    left(trim(p_data->>'partner2_phone'), 30), left(lower(trim(p_data->>'partner2_email')), 254),
    p_data->>'partner1_id_type', left(p1id, 40), left(trim(p_data->>'partner1_nationality'), 60),
    left(trim(p_data->>'partner1_phone'), 30), left(lower(trim(p_data->>'partner1_email')), 254),
    left(trim(p_data->>'contact_name'), 120), left(trim(p_data->>'contact_phone'), 30),
    left(trim(p_data->>'next_of_kin_name'), 120), left(trim(p_data->>'next_of_kin_phone'), 30),
    left(trim(p_data->>'next_of_kin_relation'), 60), now(), 'v2', auth.uid(), now())
  on conflict (wedding_id) do update set
    partner1_legal_name = excluded.partner1_legal_name, partner2_legal_name = excluded.partner2_legal_name,
    partner1_id_type = excluded.partner1_id_type, partner1_id_number = excluded.partner1_id_number,
    partner1_nationality = excluded.partner1_nationality, partner1_phone = excluded.partner1_phone, partner1_email = excluded.partner1_email,
    partner2_id_type = excluded.partner2_id_type, partner2_id_number = excluded.partner2_id_number,
    partner2_nationality = excluded.partner2_nationality, partner2_phone = excluded.partner2_phone, partner2_email = excluded.partner2_email,
    id_type = excluded.id_type, id_number = excluded.id_number, nationality = excluded.nationality,
    phone = excluded.phone, email = excluded.email, contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
    next_of_kin_name = excluded.next_of_kin_name, next_of_kin_phone = excluded.next_of_kin_phone,
    next_of_kin_relation = excluded.next_of_kin_relation, consent_at = now(), consent_version = 'v2',
    updated_by = auth.uid(), updated_at = now();
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'kyc_update', 'wedding_kyc', p_wedding_id::text, '{}');
  return public.kyc_is_complete(p_wedding_id);
end $$;

-- Staff-unpublished/archived weddings require staff republishing/restoration.
alter table public.weddings add column if not exists lifecycle_admin_restricted boolean not null default false;
alter table public.weddings add column if not exists allow_in_kind_sponsorship boolean not null default false;

create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  q jsonb;
  v_fee bigint;
  v_staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to publish a wedding.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  if auth.uid() is null or not (v_staff or w.client_owner_id = auth.uid()) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;
  if w.lifecycle_admin_restricted and not v_staff then
    raise exception 'This wedding was unpublished or suspended by platform staff. Contact an Admin or Owner to republish it.';
  end if;
  if w.archived_at is not null then raise exception 'Restore the archived wedding before publishing.'; end if;
  if w.slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;
  if w.wedding_date is null then raise exception 'Set the wedding date before publishing.'; end if;
  if not public.kyc_is_complete(p_wedding_id) then
    raise exception 'Submit complete KYC details for both partners before publishing. WeddingSite does not independently verify identity documents.';
  end if;
  if not exists (select 1 from public.venues v where v.wedding_id = p_wedding_id
      and v.event_time is not null and v.event_date is not null) then
    raise exception 'Add at least one wedding event with a date and time before publishing.';
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
    lifecycle_admin_restricted = false, first_published_at = coalesce(first_published_at, now()) where id = p_wedding_id;
  return true;
end $$;

create or replace function public.unpublish_wedding(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to unpublish a wedding.'; end if;
  if auth.uid() is null or not (staff or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())) then
    raise exception 'Only the Client or platform staff can unpublish this wedding.';
  end if;
  update public.weddings set published_at = null, unpublished_at = now(),
    lifecycle_admin_restricted = staff where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', case when staff then 'staff_unpublish' else 'client_unpublish' end,
    'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

create or replace function public.archive_wedding(p_wedding_id uuid, p_archived boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false);
begin
  if auth.uid() is null or not (staff or exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())) then
    raise exception 'Only the Client or platform staff can archive this wedding.';
  end if;
  if not coalesce(p_archived, true) and exists (
    select 1 from public.weddings where id = p_wedding_id and lifecycle_admin_restricted and not staff
  ) then raise exception 'Only platform staff can restore a wedding archived by staff.'; end if;
  update public.weddings set
    archived_at = case when coalesce(p_archived, true) then now() else null end,
    published_at = case when coalesce(p_archived, true) then null else published_at end,
    unpublished_at = case when coalesce(p_archived, true) and published_at is not null then now() else unpublished_at end,
    lifecycle_admin_restricted = case when staff then coalesce(p_archived, true) else lifecycle_admin_restricted end
  where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', case when coalesce(p_archived, true) then 'archive' else 'restore' end,
    'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

-- Payment action metadata is created by the server before redirect; only signed provider
-- confirmations transition it to paid and cause the action to complete.
alter table public.contributions add column if not exists purchase_action text;
alter table public.contributions add column if not exists purchase_data jsonb not null default '{}'::jsonb;
alter table public.contributions add column if not exists action_result jsonb;
alter table public.contributions add column if not exists action_completed_at timestamptz;
alter table public.contributions add column if not exists platform_fixed_fee_minor bigint not null default 0
  check (platform_fixed_fee_minor between 0 and 100000000);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contributions_purchase_action_check'
      and conrelid = 'public.contributions'::regclass) then
    alter table public.contributions add constraint contributions_purchase_action_check
      check (purchase_action is null or purchase_action in ('rsvp', 'song_bid', 'vip', 'sponsor', 'fundraiser', 'registry'));
  end if;
end $$;
alter table public.contributions add column if not exists action_idempotency_key uuid;
create unique index if not exists contributions_action_idempotency_unique
  on public.contributions(action_idempotency_key) where action_idempotency_key is not null;
update public.contributions set provider_fee_pending = true
  where payment_status = 'paid' and provider_fee_minor is null;

create table if not exists public.contribution_line_items (
  id uuid primary key default extensions.gen_random_uuid(),
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  category text not null check (length(category) between 1 and 40),
  label text not null check (length(label) between 1 and 120),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);
alter table public.contribution_line_items enable row level security;
revoke all on public.contribution_line_items from anon, authenticated;

alter table public.sponsors add column if not exists location text;
alter table public.sponsors add column if not exists offer text;
alter table public.sponsors add column if not exists public_contact boolean not null default false;
alter table public.sponsors add column if not exists in_kind boolean not null default false;
alter table public.sponsors drop constraint if exists sponsors_amount_minor_check;
alter table public.sponsors add constraint sponsors_amount_minor_check check (amount_minor >= 0);

create table if not exists public.sponsor_enquiries (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  company_name text not null check (length(company_name) between 1 and 100),
  contact_name text not null check (length(contact_name) between 1 and 100),
  contact_email text not null check (length(contact_email) between 5 and 254),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 30),
  location text check (location is null or length(location) <= 160),
  offer text check (offer is null or length(offer) <= 360),
  in_kind boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  public_contact boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.sponsor_enquiries add column if not exists public_contact boolean not null default false;
alter table public.sponsor_enquiries enable row level security;
revoke all on public.sponsor_enquiries from anon, authenticated;

create or replace function public.review_sponsor_enquiry(p_enquiry_id uuid, p_approved boolean)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare enquiry public.sponsor_enquiries; allow_in_kind boolean;
begin
  select * into enquiry from public.sponsor_enquiries where id = p_enquiry_id for update;
  if not found then raise exception 'Sponsor enquiry not found.'; end if;
  if not public.has_wedding_role(enquiry.wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only this wedding organizer can review the enquiry.';
  end if;
  if enquiry.status <> 'pending' then raise exception 'This sponsor enquiry has already been reviewed.'; end if;
  select w.allow_in_kind_sponsorship into allow_in_kind
    from public.weddings w where w.id = enquiry.wedding_id for update;
  if p_approved and not coalesce(allow_in_kind, false) then
    raise exception 'In-kind sponsor enquiries are currently disabled for this wedding.';
  end if;
  update public.sponsor_enquiries set status = case when p_approved then 'approved' else 'declined' end
    where id = enquiry.id;
  if p_approved then
    insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, amount_minor,
      location, offer, public_contact, in_kind, status)
    values (enquiry.wedding_id, enquiry.company_name, enquiry.contact_email, enquiry.contact_phone, 0,
      enquiry.location, enquiry.offer, enquiry.public_contact, true, 'active');
  end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (enquiry.wedding_id, auth.uid(), 'user',
      case when p_approved then 'sponsor_enquiry_approved' else 'sponsor_enquiry_declined' end,
      'sponsor_enquiries', enquiry.id::text, array['status']);
  return true;
end $$;
revoke all on function public.review_sponsor_enquiry(uuid, boolean) from public, anon;
grant execute on function public.review_sponsor_enquiry(uuid, boolean) to authenticated;

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
      'website', s.website, 'amount_minor', s.amount_minor, 'in_kind', s.in_kind, 'public_contact', s.public_contact,
      'contact_email', case when s.public_contact then s.contact_email else null end,
      'contact_phone', case when s.public_contact then s.contact_phone else null end
    ) order by s.amount_minor desc, s.created_at) from public.sponsors s
      left join public.contributions c on c.id = s.contribution_id
      where s.wedding_id = w.id and s.status = 'active'
        and (s.in_kind and s.contribution_id is null or c.payment_status = 'paid' and c.verified_provider_payment)), '[]'::jsonb)
  ) from public.weddings w where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
revoke all on function public.get_public_fundraising(text) from public;
grant execute on function public.get_public_fundraising(text) to anon, authenticated;

update public.vip_offers v set seats_sold = (
  select count(*)::integer from public.vip_reservations vr
  join public.contributions c on c.id = vr.contribution_id
  where vr.vip_offer_id = v.id and vr.payment_status = 'paid'
    and c.payment_status = 'paid' and c.verified_provider_payment
);

create or replace function public.get_wedding_setup_status(p_wedding_ids uuid[])
returns table (wedding_id uuid, kyc_submitted boolean)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if auth.uid() is null or coalesce(cardinality(p_wedding_ids), 0) > 100 then
    raise exception 'A valid signed-in wedding list is required.';
  end if;
  if exists (
    select 1 from public.weddings w
    where w.id = any(p_wedding_ids) and w.client_owner_id is distinct from auth.uid()
  ) then raise exception 'Wedding setup status access denied.'; end if;
  return query
    select w.id, public.kyc_is_complete(w.id)
    from public.weddings w where w.id = any(p_wedding_ids);
end $$;
revoke all on function public.get_wedding_setup_status(uuid[]) from public, anon;
grant execute on function public.get_wedding_setup_status(uuid[]) to authenticated;

create or replace function public.get_public_campaigns(p_slug text)
returns jsonb language sql stable security definer set search_path = '' set row_security = off
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'purpose', s.purpose, 'goal_minor', s.goal_minor, 'currency', s.currency,
    'raised_minor', r.raised,
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description,
        'target_minor', m.target_minor, 'reached', r.raised >= m.target_minor) order by m.sort_order, m.created_at)
      from public.fundraising_milestones m where m.stream_id = s.id), '[]'::jsonb)
  ) order by s.sort_order, s.created_at), '[]'::jsonb)
  from public.weddings w
  join public.fundraising_streams s on s.wedding_id = w.id and s.enabled
  cross join lateral (
    select coalesce(sum(c.paid_amount_minor), 0)::bigint as raised
    from public.contributions c
    where c.stream_id = s.id and c.payment_status = 'paid' and c.verified_provider_payment
  ) r
  where w.slug = lower(p_slug) and w.published_at is not null and w.archived_at is null;
$$;
revoke all on function public.get_public_campaigns(text) from public;
grant execute on function public.get_public_campaigns(text) to anon, authenticated;

create or replace function public.save_fundraising_campaigns(p_wedding_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  c jsonb; m jsonb;
  v_stream uuid;
  v_keep uuid[] := array[]::uuid[];
  v_mkeep uuid[];
  v_mid uuid;
  si integer := 0; mi integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id = p_wedding_id;
  if not found then raise exception 'Wedding not found.'; end if;
  if jsonb_typeof(p_payload) <> 'array' then raise exception 'Invalid campaigns.'; end if;
  if jsonb_array_length(p_payload) > 6 then raise exception 'At most 6 campaigns.'; end if;

  for c in select * from jsonb_array_elements(p_payload) loop
    v_stream := null;
    if (c->>'id') ~* '^[0-9a-f-]{36}$' then
      select id into v_stream from public.fundraising_streams where id = (c->>'id')::uuid and wedding_id = p_wedding_id;
    end if;
    if v_stream is null then
      insert into public.fundraising_streams (wedding_id, name, purpose, goal_minor, currency, enabled, sort_order)
      values (p_wedding_id, left(trim(c->>'name'), 100), left(coalesce(nullif(trim(c->>'purpose'), ''), trim(c->>'name')), 240),
              (c->>'goal_minor')::bigint, w.currency, coalesce((c->>'enabled')::boolean, true), si)
      returning id into v_stream;
    else
      update public.fundraising_streams set name = left(trim(c->>'name'), 100),
        purpose = left(coalesce(nullif(trim(c->>'purpose'), ''), trim(c->>'name')), 240),
        goal_minor = (c->>'goal_minor')::bigint, enabled = coalesce((c->>'enabled')::boolean, true), sort_order = si
      where id = v_stream;
    end if;
    v_keep := v_keep || v_stream;
    v_mkeep := array[]::uuid[]; mi := 0;
    for m in select * from jsonb_array_elements(coalesce(c->'milestones', '[]'::jsonb)) loop
      v_mid := null;
      if (m->>'id') ~* '^[0-9a-f-]{36}$' then
        select id into v_mid from public.fundraising_milestones where id = (m->>'id')::uuid and stream_id = v_stream;
      end if;
      if v_mid is null then
        insert into public.fundraising_milestones (stream_id, wedding_id, name, description, target_minor, sort_order)
        values (v_stream, p_wedding_id, left(trim(m->>'name'), 100), nullif(left(trim(coalesce(m->>'description', '')), 240), ''),
                (m->>'target_minor')::bigint, mi) returning id into v_mid;
      else
        update public.fundraising_milestones set name = left(trim(m->>'name'), 100),
          description = nullif(left(trim(coalesce(m->>'description', '')), 240), ''),
          target_minor = (m->>'target_minor')::bigint, sort_order = mi where id = v_mid;
      end if;
      v_mkeep := v_mkeep || v_mid; mi := mi + 1;
    end loop;
    update public.contributions set milestone_id = null
      where stream_id = v_stream and milestone_id is not null and not (milestone_id = any(v_mkeep));
    delete from public.fundraising_milestones where stream_id = v_stream and not (id = any(v_mkeep));
    si := si + 1;
  end loop;
  update public.fundraising_streams set enabled = false where wedding_id = p_wedding_id and not (id = any(v_keep));
end $$;
revoke all on function public.save_fundraising_campaigns(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_fundraising_campaigns(uuid, jsonb) to service_role;

create or replace function public.get_registry_with_totals(p_wedding_id uuid)
returns table (
  id uuid, name text, description text, category text, target_amount_minor bigint, notes text,
  raised_amount_minor bigint, raised_count integer, progress_percent numeric, currency char(3)
) language plpgsql security definer set search_path = '' set row_security = off
as $$
declare v_currency char(3);
begin
  select w.currency into v_currency from public.weddings w
    where w.id = p_wedding_id and public.is_published_wedding(w.id);
  if v_currency is null then return; end if;
  return query
  select ri.id, ri.name, ri.description, ri.category, ri.target_amount_minor, ri.notes,
    coalesce(sum(c.paid_amount_minor) filter (where c.payment_status = 'paid' and c.verified_provider_payment), 0)::bigint,
    count(c.id) filter (where c.payment_status = 'paid' and c.verified_provider_payment)::integer,
    case when ri.target_amount_minor > 0 then round(100.0 *
      coalesce(sum(c.paid_amount_minor) filter (where c.payment_status = 'paid' and c.verified_provider_payment), 0) /
      ri.target_amount_minor, 1) else 0 end,
    v_currency
  from public.registry_items ri
  left join public.contributions c on c.wedding_id = ri.wedding_id
    and (c.registry_item_id = ri.id or (c.registry_item_id is null and c.stream_name = ri.name))
    and c.payment_status = 'paid' and c.verified_provider_payment
  where ri.wedding_id = p_wedding_id
  group by ri.id, ri.name, ri.description, ri.category, ri.target_amount_minor, ri.notes
  order by ri.sort_order, ri.created_at;
end $$;
revoke all on function public.get_registry_with_totals(uuid) from public;
grant execute on function public.get_registry_with_totals(uuid) to anon, authenticated;

create or replace view public.public_contribution_ledger
with (security_barrier = true)
as
select id, wedding_id, stream_name,
  case when visibility = 'name' then display_name else 'Anonymous guest' end as display_name,
  visibility, paid_amount_minor as pledged_amount_minor, paid_amount_minor, currency,
  'paid'::text as payment_status, paid_at as created_at
from public.contributions
where payment_status = 'paid' and verified_provider_payment and public_consent_at is not null
  and visibility in ('name', 'anonymous') and public.is_published_wedding(wedding_id);
grant select on public.public_contribution_ledger to anon, authenticated;

create or replace view public.finance_summary
with (security_invoker = true)
as
with currencies as (
  select id as wedding_id, currency from public.weddings
  union select wedding_id, currency from public.contributions
  union select wedding_id, currency from public.expenses
  union select wedding_id, currency from public.payout_records
  union select wedding_id, currency from public.budget_lines
)
select w.id as wedding_id, currencies.currency,
  0::bigint as pledged_minor,
  coalesce(c.paid_minor, 0) as paid_gross_minor,
  coalesce(c.fees_minor, 0) as platform_fees_minor,
  coalesce(c.net_minor, 0) as net_contributions_minor,
  coalesce(e.proposed_minor, 0) as proposed_expenses_minor,
  coalesce(e.approved_minor, 0) as approved_expenses_minor,
  coalesce(e.paid_minor, 0) as paid_expenses_minor,
  coalesce(p.requested_minor, 0) as requested_payouts_minor,
  coalesce(p.sent_minor, 0) as sent_payouts_minor,
  coalesce(c.net_minor, 0) - coalesce(c.provider_fees_minor, 0)
    - coalesce(p.requested_minor, 0) - coalesce(p.sent_minor, 0) as estimated_unallocated_net_minor,
  coalesce(b.planned_minor, 0) as planned_budget_minor,
  coalesce(b.actual_minor, 0) as actual_budget_minor,
  coalesce(c.provider_fees_minor, 0) as provider_fees_minor,
  coalesce(c.provider_fee_hold_minor, 0) as provider_fee_hold_minor,
  coalesce(c.pending_minor, 0) as pending_checkout_minor
from public.weddings w
join currencies on currencies.wedding_id = w.id
left join lateral (
  select
    sum(paid_amount_minor) filter (where payment_status = 'paid' and verified_provider_payment) as paid_minor,
    sum(platform_fee_minor) filter (where payment_status = 'paid' and verified_provider_payment) as fees_minor,
    sum(net_paid_minor) filter (where payment_status = 'paid' and verified_provider_payment) as net_minor,
    sum(provider_fee_minor) filter (where payment_status = 'paid' and verified_provider_payment) as provider_fees_minor,
    sum(net_paid_minor) filter (where payment_status = 'paid' and verified_provider_payment and provider_fee_pending) as provider_fee_hold_minor,
    sum(pledged_amount_minor) filter (where payment_status = 'pending') as pending_minor
  from public.contributions where wedding_id = w.id and currency = currencies.currency
) c on true
left join lateral (
  select sum(amount_minor) filter (where status = 'proposed') as proposed_minor,
         sum(amount_minor) filter (where status = 'approved') as approved_minor,
         sum(amount_minor) filter (where status = 'paid') as paid_minor
  from public.expenses where wedding_id = w.id and currency = currencies.currency
) e on true
left join lateral (
  select sum(amount_minor) filter (where status in ('requested', 'approved')) as requested_minor,
         sum(amount_minor) filter (where status = 'sent') as sent_minor
  from public.payout_records where wedding_id = w.id and currency = currencies.currency
) p on true
left join lateral (
  select sum(planned_minor) as planned_minor, sum(actual_minor) as actual_minor
  from public.budget_lines where wedding_id = w.id and currency = currencies.currency
) b on true;
grant select on public.finance_summary to authenticated;

-- A server-owned action record is finalized in the same database transaction that marks
-- a provider payment as paid. No guest request can directly create a completed action.
alter table public.sponsors add column if not exists company_name text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sponsors_location_length'
      and conrelid = 'public.sponsors'::regclass) then
    alter table public.sponsors add constraint sponsors_location_length
      check (location is null or length(location) <= 160);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sponsors_offer_length'
      and conrelid = 'public.sponsors'::regclass) then
    alter table public.sponsors add constraint sponsors_offer_length
      check (offer is null or length(offer) <= 360);
  end if;
end $$;

-- Fixed platform commission is opt-in and only charged in its configured currency.
alter table public.platform_policies add column if not exists contribution_fixed_fee_minor bigint not null default 0
  check (contribution_fixed_fee_minor between 0 and 100000000);
alter table public.platform_policies add column if not exists contribution_fixed_fee_currency char(3) not null default 'USD'
  check (contribution_fixed_fee_currency ~ '^[A-Z]{3}$');
alter table public.platform_policies add column if not exists min_payout_minor bigint not null default 1000
  check (min_payout_minor between 0 and 100000000000);
alter table public.platform_policies add column if not exists payout_hold_days integer not null default 3
  check (payout_hold_days between 0 and 90);

create table if not exists public.platform_policy_history (
  id bigint generated always as identity primary key,
  changed_by uuid references public.profiles(id) on delete set null,
  old_values jsonb not null,
  new_values jsonb not null,
  changed_at timestamptz not null default now()
);
alter table public.platform_policy_history enable row level security;
revoke all on public.platform_policy_history from anon, authenticated;

create or replace function public.admin_save_policies(p_data jsonb) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  current_policy public.platform_policies;
  next_values jsonb;
begin
  if public.current_platform_role() is distinct from 'owner' then raise exception 'Only the protected Owner can change platform financial policies.'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'Platform policy updates must be a JSON object.';
  end if;
  if p_data ? 'contribution_fee_basis_points'
      and ((p_data->>'contribution_fee_basis_points')::integer not between 0 and 10000) then
    raise exception 'Platform commission must be between zero and one hundred percent.';
  end if;
  if p_data ? 'contribution_fixed_fee_minor'
      and ((p_data->>'contribution_fixed_fee_minor')::bigint not between 0 and 100000000) then
    raise exception 'Fixed commission is outside the allowed limit.';
  end if;
  if p_data ? 'contribution_fixed_fee_currency'
      and (p_data->>'contribution_fixed_fee_currency') !~ '^[A-Z]{3}$' then
    raise exception 'Fixed commission currency must be an uppercase three-letter ISO code.';
  end if;
  if p_data ? 'min_payout_minor' and ((p_data->>'min_payout_minor')::bigint not between 0 and 100000000000) then
    raise exception 'Minimum payout is outside the allowed limit.';
  end if;
  if p_data ? 'max_payout_minor' and ((p_data->>'max_payout_minor')::bigint not between 0 and 100000000000) then
    raise exception 'Maximum payout is outside the allowed limit.';
  end if;
  select * into current_policy from public.platform_policies where id for update;
  if coalesce((p_data->>'min_payout_minor')::bigint, current_policy.min_payout_minor)
      > coalesce((p_data->>'max_payout_minor')::bigint, current_policy.max_payout_minor) then
    raise exception 'Minimum payout cannot exceed the maximum payout.';
  end if;
  update public.platform_policies set
    publication_fee_minor = coalesce((p_data->>'publication_fee_minor')::bigint, publication_fee_minor),
    far_future_months = coalesce((p_data->>'far_future_months')::int, far_future_months),
    far_future_fee_minor = coalesce((p_data->>'far_future_fee_minor')::bigint, far_future_fee_minor),
    free_publications_per_client = coalesce((p_data->>'free_publications_per_client')::int, free_publications_per_client),
    contribution_fee_basis_points = coalesce((p_data->>'contribution_fee_basis_points')::int, contribution_fee_basis_points),
    contribution_fixed_fee_minor = coalesce((p_data->>'contribution_fixed_fee_minor')::bigint, contribution_fixed_fee_minor),
    contribution_fixed_fee_currency = coalesce((p_data->>'contribution_fixed_fee_currency')::char(3), contribution_fixed_fee_currency),
    min_payout_minor = coalesce((p_data->>'min_payout_minor')::bigint, min_payout_minor),
    payout_hold_days = coalesce((p_data->>'payout_hold_days')::int, payout_hold_days),
    max_contribution_minor = coalesce((p_data->>'max_contribution_minor')::bigint, max_contribution_minor),
    max_payout_minor = coalesce((p_data->>'max_payout_minor')::bigint, max_payout_minor),
    max_wedding_capacity = coalesce((p_data->>'max_wedding_capacity')::int, max_wedding_capacity),
    updated_by = auth.uid(), updated_at = now()
  where id;
  select to_jsonb(pp) - 'updated_by' into next_values from public.platform_policies pp where pp.id;
  insert into public.platform_policy_history (changed_by, old_values, new_values)
    values (auth.uid(), to_jsonb(current_policy) - 'updated_by', next_values);
  insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
    values (auth.uid(), 'user', 'policy_update', 'platform_policies', 'true', array(select jsonb_object_keys(p_data)));
  return true;
end $$;

create or replace function public.admin_policy_history(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if public.current_platform_role() is distinct from 'owner' then
    raise exception 'Only the protected Owner can view platform policy history.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'changed_at', h.changed_at, 'old_values', h.old_values, 'new_values', h.new_values
    ) order by h.changed_at desc)
    from (
      select changed_at, old_values, new_values
      from public.platform_policy_history
      order by changed_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) h
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_policy_history(integer) from public, anon;
grant execute on function public.admin_policy_history(integer) to authenticated;

-- Role changes are a protected Owner-only operation; other staff permissions remain unchanged.
create or replace function public.admin_set_role(p_user_id uuid, p_role text) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare ok boolean;
begin
  if public.current_platform_role() is distinct from 'owner' then raise exception 'Only the Owner can delegate platform roles.'; end if;
  if p_role not in ('client', 'admin', 'superadmin') then raise exception 'Choose client, admin or superadmin.'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role.'; end if;
  ok := public.assign_platform_role(p_user_id, p_role::public.platform_role);
  if ok then
    insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
      values (auth.uid(), 'user', 'owner_role_change:' || p_role, 'profiles', p_user_id::text, array['platform_role']);
  end if;
  return ok;
end $$;

drop function if exists public.record_verified_payment(text, text, uuid, bigint, text, text);
create function public.record_verified_payment(
  p_provider text, p_provider_event_id text, p_contribution_id uuid,
  p_amount_minor bigint, p_currency text, p_provider_reference text,
  p_provider_fee_minor bigint default null
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  c public.contributions;
  inserted_count integer;
  fee bigint;
  hold_days integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider not in ('stripe', 'paystack') or length(p_provider_event_id) not between 1 and 200 then
    raise exception 'Unsupported payment event.';
  end if;
  if p_provider_fee_minor is not null and (p_provider_fee_minor < 0 or p_provider_fee_minor > p_amount_minor) then
    raise exception 'Provider fee is outside the verified payment amount.';
  end if;
  select * into c from public.contributions where id = p_contribution_id for update;
  if not found then raise exception 'Payment record not found.'; end if;
  if c.provider_name is distinct from p_provider or p_provider_reference is null
      or (c.provider_reference is not null and c.provider_reference is distinct from p_provider_reference) then
    raise exception 'Verified provider or checkout reference does not match the payment record.';
  end if;
  if upper(p_currency) <> c.currency or p_amount_minor <> c.pledged_amount_minor then
    raise exception 'Verified amount or currency does not match the payment record.';
  end if;
  insert into public.payment_events (provider, provider_event_id, contribution_id)
    values (p_provider, p_provider_event_id, c.id) on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  if c.payment_status = 'paid' then
    if p_provider_fee_minor is not null and c.provider_fee_pending then
      update public.contributions set provider_fee_minor = p_provider_fee_minor,
        provider_fee_pending = p_provider_fee_minor > c.net_paid_minor
        where id = c.id;
      return true;
    end if;
    return false;
  end if;
  if c.payment_status <> 'pending' then return false; end if;

  fee := least(p_amount_minor,
    round(p_amount_minor::numeric * c.platform_fee_basis_points / 10000)::bigint
      + coalesce(c.platform_fixed_fee_minor, 0));
  select greatest(payout_hold_days, case when p_provider = 'paystack' then 3 else 0 end)
    into hold_days from public.platform_policies where id;
  update public.contributions set
    payment_status = 'paid',
    verified_provider_payment = true,
    paid_amount_minor = p_amount_minor,
    platform_fee_minor = fee,
    net_paid_minor = p_amount_minor - fee,
    provider_fee_minor = p_provider_fee_minor,
    provider_fee_pending = p_provider_fee_minor is null or p_provider_fee_minor > p_amount_minor - fee,
    provider_name = p_provider,
    provider_reference = left(p_provider_reference, 160),
    paid_at = now(),
    funds_available_at = now() + make_interval(days => coalesce(hold_days, 3))
  where id = c.id;
  return true;
end $$;
revoke all on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint) to service_role;

create table if not exists public.payment_action_reviews (
  id bigint generated always as identity primary key,
  contribution_id uuid not null unique references public.contributions(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  reason_code text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolution text
);
alter table public.payment_action_reviews enable row level security;
revoke all on public.payment_action_reviews from anon, authenticated;

create or replace function public.finalize_paid_checkout_action()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  d jsonb := coalesce(new.purchase_data, '{}'::jsonb);
  v_phone text;
  v_email text;
  v_status text;
  v_message text;
  v_rsvp uuid;
  v_ref text;
  v_vip public.vip_offers;
  v_sponsor_tier public.sponsor_tiers;
  v_item public.registry_items;
  v_bid record;
  v_reason text;
begin
  if new.payment_status <> 'paid' or old.payment_status = 'paid'
      or new.purchase_action is null or new.action_completed_at is not null then
    return new;
  end if;

  begin
    if new.purchase_action = 'fundraiser' then
      if not exists (select 1 from public.fundraising_streams s
        where s.id = new.stream_id and s.wedding_id = new.wedding_id and s.enabled) then
        raise exception 'fundraiser_unavailable';
      end if;
      if new.milestone_id is not null and not exists (select 1 from public.fundraising_milestones m
        where m.id = new.milestone_id and m.stream_id = new.stream_id) then
        raise exception 'fundraiser_milestone_unavailable';
      end if;
      new.action_result := jsonb_build_object('completed', true, 'kind', 'fundraiser');

    elsif new.purchase_action = 'registry' then
      select * into v_item from public.registry_items
        where id = new.registry_item_id and wedding_id = new.wedding_id;
      if not found then raise exception 'registry_item_unavailable'; end if;
      new.action_result := jsonb_build_object('completed', true, 'kind', 'registry', 'name', v_item.name);

    elsif new.purchase_action = 'song_bid' then
      select * into v_bid from public.place_dj_bid(new.wedding_id,
        left(trim(d->>'songTitle'), 160), left(trim(d->>'artist'), 100),
        new.paid_amount_minor, 'Guest');
      if v_bid.status <> 'placed' then raise exception 'song_bid_not_recorded'; end if;
      new.action_result := jsonb_build_object('completed', true, 'kind', 'song_bid',
        'songTitle', left(trim(d->>'songTitle'), 160), 'artist', left(trim(d->>'artist'), 100));

    elsif new.purchase_action = 'vip' then
      select * into v_vip from public.vip_offers where id = (d->>'refId')::uuid and wedding_id = new.wedding_id for update;
      if not found or v_vip.seats_sold >= v_vip.seats_total or v_vip.price_minor <> new.paid_amount_minor then
        raise exception 'vip_capacity_or_price_changed';
      end if;
      update public.vip_offers set seats_sold = seats_sold + 1 where id = v_vip.id;
      insert into public.vip_reservations (vip_offer_id, guest_name, guest_email, amount_minor, contribution_id, payment_status)
      values (v_vip.id, left(coalesce(nullif(trim(d->>'guestName'), ''), 'Guest'), 100),
        nullif(left(d->>'guestEmail', 200), ''), new.paid_amount_minor, new.id, 'paid');
      new.action_result := jsonb_build_object('completed', true, 'kind', 'vip', 'reservationId', new.id);

    elsif new.purchase_action = 'sponsor' then
      select * into v_sponsor_tier from public.sponsor_tiers where id = (d->>'refId')::uuid and wedding_id = new.wedding_id;
      if not found or new.paid_amount_minor < v_sponsor_tier.min_amount_minor then
        raise exception 'sponsor_package_unavailable';
      end if;
      insert into public.sponsors (wedding_id, company_name, contact_email, contact_phone, website, amount_minor,
        tier_id, contribution_id, location, offer, public_contact, status)
      values (new.wedding_id, left(trim(d->>'companyName'), 100), nullif(left(d->>'email', 200), ''),
        nullif(left(d->>'phone', 30), ''), nullif(left(d->>'website', 300), ''),
        new.paid_amount_minor, v_sponsor_tier.id, new.id,
        nullif(left(trim(d->>'location'), 160), ''), nullif(left(trim(d->>'offer'), 360), ''),
        coalesce((d->>'publicContact')::boolean, false), 'active');
      new.action_result := jsonb_build_object('completed', true, 'kind', 'sponsor');

    elsif new.purchase_action = 'rsvp' then
      v_phone := regexp_replace(coalesce(d->>'guestPhone', ''), '[^0-9]', '', 'g');
      if length(v_phone) < 8 or length(v_phone) > 15 then raise exception 'rsvp_phone_invalid'; end if;
      select guest_email into v_email from public.guest_rsvps
        where wedding_id = new.wedding_id and phone in (v_phone, '+' || v_phone)
        order by created_at asc limit 1;
      v_email := coalesce(v_email, nullif(lower(trim(d->>'guestEmail')), ''),
        'p' || v_phone || '@phone.weddingsite.invalid');
      select r.status, r.message, r.rsvp_id into v_status, v_message, v_rsvp
        from public.submit_rsvp_with_pass(new.wedding_id, v_email, left(trim(d->>'guestName'), 100),
          true, coalesce((d->>'dietaryRequested')::boolean, false),
          left(coalesce(d->>'dietaryNotes', ''), 240),
          greatest(0, least(10, coalesce((d->>'plusOnes')::integer, 0)))) r;
      if v_status <> 'confirmed' or v_rsvp is null then raise exception 'rsvp_not_confirmed'; end if;
      update public.guest_rsvps set phone = v_phone,
        party_names = nullif(left(trim(d->>'partyNames'), 400), '')
        where id = v_rsvp;
      v_ref := (select ref_code from public.guest_rsvps where id = v_rsvp);
      new.action_result := jsonb_build_object('completed', true, 'kind', 'rsvp', 'rsvpId', v_rsvp, 'refCode', coalesce(v_ref, ''));
    end if;
    new.action_completed_at := now();
  exception when others then
    v_reason := sqlerrm;
    new.action_result := jsonb_build_object('completed', false, 'status', 'review_required');
    new.action_completed_at := null;
    insert into public.payment_action_reviews (contribution_id, wedding_id, reason_code)
      values (new.id, new.wedding_id, left(coalesce(v_reason, 'action_finalize_failed'), 120))
      on conflict (contribution_id) do nothing;
  end;
  return new;
end $$;

drop trigger if exists finalize_paid_checkout_action on public.contributions;
create trigger finalize_paid_checkout_action
  before update of payment_status on public.contributions
  for each row execute function public.finalize_paid_checkout_action();

drop function if exists public.withdrawable_balance(uuid, text);
create function public.withdrawable_balance(p_wedding_id uuid, p_currency text)
returns table (available_minor bigint, settling_minor bigint, held_minor bigint, next_available_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  return query
  select
    greatest(coalesce(sum(c.net_paid_minor - c.provider_fee_minor)
      filter (where c.provider_fee_pending = false and (c.funds_available_at is null or c.funds_available_at <= now())), 0)
      - coalesce((select sum(p.amount_minor) from public.payout_records p
          where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
            and p.status in ('requested', 'approved', 'sent')), 0), 0)::bigint,
    coalesce(sum(c.net_paid_minor - coalesce(c.provider_fee_minor, 0))
      filter (where c.provider_fee_pending = false and c.funds_available_at > now()), 0)::bigint,
    coalesce(sum(c.net_paid_minor) filter (where c.provider_fee_pending), 0)::bigint,
    min(c.funds_available_at) filter (where c.funds_available_at > now() and not c.provider_fee_pending)
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment;
  -- Historical simulator records remain visible only as unverified, never as spendable funds.
end;
$$;
revoke all on function public.withdrawable_balance(uuid, text) from public, anon;
grant execute on function public.withdrawable_balance(uuid, text) to authenticated;

create or replace function public.request_payout(
  p_wedding_id uuid, p_amount_minor bigint, p_currency text, p_note text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  result_id uuid;
  available_minor bigint;
  workspace_currency char(3);
  minimum_minor bigint;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to request a payout.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may request a payout.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid payout amount or currency.';
  end if;
  select currency into workspace_currency from public.weddings where id = p_wedding_id for update;
  if not found or workspace_currency <> upper(p_currency) then raise exception 'Payout currency must match the wedding currency.'; end if;
  select max_payout_minor, min_payout_minor into available_minor, minimum_minor from public.platform_policies where id;
  if p_amount_minor < minimum_minor or p_amount_minor > available_minor then
    raise exception 'Payout request is outside the configured minimum or maximum.';
  end if;
  select coalesce(sum(c.net_paid_minor - c.provider_fee_minor), 0)
    - coalesce((select sum(p.amount_minor) from public.payout_records p
      where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
        and p.status in ('requested', 'approved', 'sent')), 0)
  into available_minor
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment and not c.provider_fee_pending
    and (c.funds_available_at is null or c.funds_available_at <= now());
  if p_amount_minor > greatest(available_minor, 0) then
    raise exception 'Payout exceeds the settled net balance after platform and provider fees.';
  end if;
  insert into public.payout_records (wedding_id, amount_minor, currency, requested_by, note)
    values (p_wedding_id, p_amount_minor, p_currency, auth.uid(), left(p_note, 240))
    returning id into result_id;
  return result_id;
end;
$$;
revoke all on function public.request_payout(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.request_payout(uuid, bigint, text, text, boolean) to authenticated;

alter table public.dj_song_bids add column if not exists payment_status text not null default 'pending'
  check (payment_status in ('pending', 'paid', 'refunded'));

create or replace function public.place_dj_bid(
  p_wedding_id uuid, p_song_title text, p_artist_name text,
  p_bid_amount_minor bigint, p_bidder_name text
) returns table (status text, message text) language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  v_currency char(3);
  v_max bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Verified payment processing required.'; end if;
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
  insert into public.dj_song_bids (wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, status, payment_status)
    values (p_wedding_id, trim(p_song_title), trim(p_artist_name), p_bid_amount_minor, v_currency,
      coalesce(nullif(trim(p_bidder_name), ''), 'Guest'), 'submitted', 'paid');
  perform public.rank_dj_bids_for_wedding(p_wedding_id);
  return query select 'placed'::text, 'Your paid bid is on the leaderboard and supports the wedding fund.'::text;
end;
$$;
revoke all on function public.place_dj_bid(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.place_dj_bid(uuid, text, text, bigint, text) to service_role;

drop function if exists public.get_dj_leaderboard(uuid);
create function public.get_dj_leaderboard(p_wedding_id uuid)
returns table (rank_position integer, song_title text, artist_name text, bid_amount_minor bigint, bid_count bigint, currency char(3))
language sql stable security definer set search_path = '' set row_security = off
as $$
  with totals as (
    select min(b.song_title) as song_title, min(b.artist_name) as artist_name,
      sum(b.bid_amount_minor)::bigint as bid_amount_minor, min(b.currency) as currency,
      count(*)::bigint as bid_count,
      lower(trim(b.song_title)) as title_key, lower(trim(b.artist_name)) as artist_key
    from public.dj_song_bids b
    where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
      and public.is_published_wedding(p_wedding_id)
    group by lower(trim(b.song_title)), lower(trim(b.artist_name))
  )
  select row_number() over (order by t.bid_amount_minor desc, t.title_key, t.artist_key)::integer,
    t.song_title, t.artist_name, t.bid_amount_minor, t.bid_count, t.currency
  from totals t order by t.bid_amount_minor desc, t.title_key, t.artist_key limit 25;
$$;
revoke all on function public.get_dj_leaderboard(uuid) from public;
grant execute on function public.get_dj_leaderboard(uuid) to anon, authenticated, service_role;

create or replace function public.get_campaign_ledger(p_wedding_id uuid)
returns jsonb language sql stable security definer set search_path = '' set row_security = off
as $$
  select jsonb_build_object(
    'allow_in_kind_sponsorship', w.allow_in_kind_sponsorship,
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'goal_minor', s.goal_minor, 'enabled', s.enabled,
        'raised_minor', coalesce((select sum(c.paid_amount_minor) from public.contributions c
          where c.stream_id = s.id and c.payment_status = 'paid' and c.verified_provider_payment), 0),
        'payments', (select count(*) from public.contributions c
          where c.stream_id = s.id and c.payment_status = 'paid' and c.verified_provider_payment))
        order by s.sort_order, s.created_at)
      from public.fundraising_streams s where s.wedding_id = p_wedding_id), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select c.id, c.display_name as guest, c.paid_amount_minor as amount_minor, c.stream_name as campaign,
          m.name as milestone, 'paid'::text as status, c.provider_name as provider, c.paid_at as created_at
        from public.contributions c left join public.fundraising_milestones m on m.id = c.milestone_id
        where c.wedding_id = p_wedding_id and c.stream_id is not null
          and c.payment_status = 'paid' and c.verified_provider_payment
        order by c.paid_at desc limit 200) x), '[]'::jsonb)
  );
$$;
revoke all on function public.get_campaign_ledger(uuid) from public, anon, authenticated;
grant execute on function public.get_campaign_ledger(uuid) to service_role;

update public.publication_fees set status = 'pending'
  where status = 'paid' and provider = 'test-simulator';

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
    'bids', (select count(*) from public.dj_song_bids where payment_status = 'paid'),
    'collected_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(paid_amount_minor) t from public.contributions
      where payment_status = 'paid' and verified_provider_payment group by currency) x), '{}'::jsonb),
    'fees_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(platform_fee_minor) t from public.contributions
      where payment_status = 'paid' and verified_provider_payment group by currency) x), '{}'::jsonb),
    'provider_fees_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(provider_fee_minor) t from public.contributions
      where payment_status = 'paid' and verified_provider_payment and not provider_fee_pending group by currency) x), '{}'::jsonb),
    'net_to_weddings_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(net_paid_minor - provider_fee_minor) t from public.contributions
      where payment_status = 'paid' and verified_provider_payment and not provider_fee_pending group by currency) x), '{}'::jsonb),
    'provider_fee_holds_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(net_paid_minor) t from public.contributions
      where payment_status = 'paid' and verified_provider_payment and provider_fee_pending group by currency) x), '{}'::jsonb),
    'publication_fees_by_currency', coalesce((select jsonb_object_agg(currency, t) from (
      select currency, sum(amount_minor) t from public.publication_fees
      where status = 'paid' and provider is distinct from 'test-simulator' group by currency) x), '{}'::jsonb),
    'pending_payouts', (select count(*) from public.payout_records where status = 'requested'),
    'unverified_legacy_payments', (select count(*) from public.contributions where payment_status = 'paid' and not verified_provider_payment),
    'test_payments', (select count(*) from public.contributions where provider_name = 'test-simulator')
  );
end $$;

create or replace function public.admin_list_weddings() returns table (
  id uuid, slug text, couple_names text, wedding_date date, time_zone text, currency text, owner_email text,
  published_at timestamptz, archived_at timestamptz, is_past boolean, rsvps bigint, bids bigint,
  collected_minor bigint, fee_status text, kyc_complete boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return query select w.id, w.slug, w.couple_names, w.wedding_date, w.time_zone, w.currency::text,
    u.email::text, w.published_at, w.archived_at,
    (w.wedding_date < (now() at time zone w.time_zone)::date),
    (select count(*) from public.guest_rsvps r where r.wedding_id = w.id),
    (select count(*) from public.dj_song_bids b where b.wedding_id = w.id and b.payment_status = 'paid'),
    coalesce((select sum(c.paid_amount_minor) from public.contributions c where c.wedding_id = w.id
      and c.payment_status = 'paid' and c.verified_provider_payment), 0)::bigint,
    coalesce((select f.status from public.publication_fees f where f.wedding_id = w.id), 'none'),
    public.kyc_is_complete(w.id), w.created_at
  from public.weddings w left join auth.users u on u.id = w.client_owner_id
  order by w.created_at desc limit 500;
end $$;

create or replace function public.admin_wedding_metrics(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare result jsonb;
begin
  perform public.require_staff();
  select jsonb_build_object(
    'wedding', (select jsonb_build_object('id', w.id, 'slug', w.slug, 'couple_names', w.couple_names,
      'wedding_date', w.wedding_date, 'currency', w.currency, 'published', w.published_at is not null,
      'archived', w.archived_at is not null) from public.weddings w where w.id = p_wedding_id),
    'analytics', public.wedding_analytics(p_wedding_id),
    'party_size', (select coalesce(sum(1 + plus_one_count), 0) from public.guest_rsvps
      where wedding_id = p_wedding_id and attendance_status = 'yes'),
    'funds_by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object('campaign', t.stream_name, 'gross_minor', t.g, 'platform_fee_minor', t.f,
        'provider_fee_minor', t.pf, 'net_minor', t.n, 'count', t.c) order by t.g desc)
      from (select stream_name, sum(paid_amount_minor) g, sum(platform_fee_minor) f,
          sum(provider_fee_minor) pf, sum(net_paid_minor - provider_fee_minor) n, count(*) c
        from public.contributions where wedding_id = p_wedding_id and payment_status = 'paid'
          and verified_provider_payment and not provider_fee_pending group by stream_name) t), '[]'::jsonb),
    'top_songs', coalesce((
      select jsonb_agg(jsonb_build_object('song', s.title, 'artist', s.artist, 'total_minor', s.total, 'bids', s.bids) order by s.total desc)
      from (select (array_agg(song_title order by created_at))[1] title, (array_agg(artist_name order by created_at))[1] artist,
        sum(bid_amount_minor) total, count(*) bids from public.dj_song_bids
        where wedding_id = p_wedding_id and payment_status = 'paid'
        group by lower(trim(song_title)), lower(trim(artist_name)) order by sum(bid_amount_minor) desc limit 10) s), '[]'::jsonb),
    'top_inviters', coalesce((select jsonb_agg(to_jsonb(x)) from
      (select * from public.referral_summary(p_wedding_id) limit 10) x), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_wedding_metrics(uuid) from public, anon;
grant execute on function public.admin_wedding_metrics(uuid) to authenticated;

create or replace function public.admin_wedding_action(p_wedding_id uuid, p_action text) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare affected integer;
begin
  perform public.require_staff();
  if p_action = 'archive' then
    update public.weddings set archived_at = now(), published_at = null, unpublished_at = now(),
      lifecycle_admin_restricted = true where id = p_wedding_id;
  elsif p_action = 'restore' then
    update public.weddings set archived_at = null, lifecycle_admin_restricted = true where id = p_wedding_id;
  elsif p_action = 'unpublish' then
    update public.weddings set published_at = null, unpublished_at = now(),
      lifecycle_admin_restricted = true where id = p_wedding_id;
  elsif p_action = 'waive_fee' then
    insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider)
      select w.id, 1, w.currency, 'waived', now(), 'staff-waiver' from public.weddings w where w.id = p_wedding_id
      on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
  else raise exception 'Unknown action.'; end if;
  get diagnostics affected = row_count;
  if affected = 0 then raise exception 'Wedding not found.'; end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (p_wedding_id, auth.uid(), 'user', 'admin_' || p_action, 'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

-- Keep public contributor lists paid-only; pending checkout rows are private.
drop function if exists public.get_published_contributions_page(uuid, integer, integer);
create function public.get_published_contributions_page(
  p_wedding_id uuid, p_offset integer default 0, p_limit integer default 10
) returns table (
  guest_display_name text, pledged_amount_minor bigint, paid_amount_minor bigint,
  currency char(3), payment_status text, created_at timestamptz
) language sql stable security definer set search_path = ''
as $$
  select c.display_name, c.paid_amount_minor, c.paid_amount_minor,
    c.currency, 'paid'::text, c.paid_at
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.payment_status = 'paid'
    and public.is_published_wedding(p_wedding_id)
    and c.visibility in ('name', 'anonymous') and c.public_consent_at is not null
  order by c.paid_at desc nulls last limit least(greatest(coalesce(p_limit, 10), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
revoke all on function public.get_published_contributions_page(uuid, integer, integer) from public;
grant execute on function public.get_published_contributions_page(uuid, integer, integer) to anon, authenticated;
