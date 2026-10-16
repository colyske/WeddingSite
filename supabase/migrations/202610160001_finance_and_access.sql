create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.platform_role as enum ('client', 'admin', 'superadmin', 'owner');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.workspace_role as enum ('client', 'admin');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.contribution_status as enum ('pledged', 'paid', 'refunded');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.expense_status as enum ('proposed', 'approved', 'paid', 'void');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payout_status as enum ('requested', 'approved', 'sent', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.reconciliation_status as enum ('pending', 'matched', 'discrepancy');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null default 'WeddingSite member' check (length(display_name) between 1 and 100),
  platform_role public.platform_role not null default 'client',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists one_protected_owner on public.profiles (platform_role) where platform_role = 'owner';

create table if not exists public.weddings (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text unique check (slug is null or slug ~ '^[a-z0-9-]{3,80}$'),
  couple_names text not null check (length(couple_names) between 1 and 120),
  welcome_story text not null default '' check (length(welcome_story) <= 500),
  wedding_date date,
  public_location text,
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  max_guest_capacity integer not null default 150 check (max_guest_capacity between 1 and 5000),
  palette text[] not null default array['#244b3a', '#a9b5a2', '#be9b52', '#eee8d9']
    check (cardinality(palette) between 1 and 4 and array_position(palette, null) is null),
  client_owner_id uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wedding_memberships (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete restrict,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (wedding_id, user_id)
);

create table if not exists public.platform_policies (
  id boolean primary key default true check (id),
  publication_fee_minor bigint not null default 2500 check (publication_fee_minor between 0 and 100000000),
  contribution_fee_basis_points integer not null default 500 check (contribution_fee_basis_points between 0 and 10000),
  max_contribution_minor bigint not null default 100000000 check (max_contribution_minor between 1 and 100000000000),
  max_expense_minor bigint not null default 100000000 check (max_expense_minor between 1 and 100000000000),
  max_payout_minor bigint not null default 100000000 check (max_payout_minor between 1 and 100000000000),
  max_wedding_capacity integer not null default 5000 check (max_wedding_capacity between 1 and 50000),
  unreconciled_alert_days integer not null default 3 check (unreconciled_alert_days between 1 and 90),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.platform_policies (id) values (true) on conflict (id) do nothing;

create table if not exists public.fundraising_streams (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  purpose text not null check (length(purpose) between 1 and 240),
  goal_minor bigint not null check (goal_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (wedding_id, name)
);

create table if not exists public.payment_provider_configs (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'paystack')),
  enabled boolean not null default false,
  market_codes text[] not null default '{}',
  currencies char(3)[] not null default '{}',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (wedding_id, provider),
  check (array_position(currencies, null) is null and array_position(market_codes, null) is null)
);

create table if not exists public.contributions (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  stream_name text not null check (length(stream_name) between 1 and 100),
  pledged_amount_minor bigint not null check (pledged_amount_minor between 1 and 100000000000),
  paid_amount_minor bigint not null default 0 check (paid_amount_minor >= 0),
  platform_fee_basis_points integer not null default 0 check (platform_fee_basis_points between 0 and 10000),
  platform_fee_minor bigint not null default 0 check (platform_fee_minor >= 0),
  net_paid_minor bigint not null default 0 check (net_paid_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  payment_status public.contribution_status not null default 'pledged',
  display_name text not null default 'Anonymous guest' check (length(display_name) between 1 and 100),
  visibility text not null default 'hidden' check (visibility in ('name', 'anonymous', 'hidden')),
  public_consent_at timestamptz,
  provider_name text,
  provider_reference text,
  checkout_idempotency_key uuid unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint public_name_consent check (
    (visibility = 'hidden' and public_consent_at is null)
    or (visibility in ('name', 'anonymous') and public_consent_at is not null)
  ),
  constraint amount_consistency check (
    (payment_status = 'pledged' and paid_amount_minor = 0 and platform_fee_minor = 0 and net_paid_minor = 0)
    or (payment_status = 'paid' and paid_amount_minor = pledged_amount_minor
        and platform_fee_minor + net_paid_minor = paid_amount_minor)
    or payment_status = 'refunded'
  )
);

create table if not exists public.expenses (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  category text not null check (length(category) between 1 and 80),
  description text not null check (length(description) between 1 and 240),
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status public.expense_status not null default 'proposed',
  due_on date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  external_reference text check (external_reference is null or length(external_reference) <= 120)
);

create table if not exists public.payout_records (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status public.payout_status not null default 'requested',
  requested_by uuid references public.profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,
  provider_reference text check (provider_reference is null or length(provider_reference) <= 160),
  note text check (note is null or length(note) <= 240)
);

create table if not exists public.budget_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  category text not null check (length(category) between 1 and 80),
  planned_minor bigint not null default 0 check (planned_minor >= 0),
  actual_minor bigint not null default 0 check (actual_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (wedding_id, category)
);

create table if not exists public.reconciliation_records (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  provider text not null check (length(provider) between 1 and 60),
  statement_reference text not null check (length(statement_reference) between 1 and 120),
  expected_minor bigint not null,
  reported_minor bigint not null,
  difference_minor bigint generated always as (reported_minor - expected_minor) stored,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status public.reconciliation_status not null default 'pending',
  note text check (note is null or length(note) <= 400),
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz
);

create table if not exists public.payment_events (
  provider text not null,
  provider_event_id text not null,
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  received_at timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  wedding_id uuid,
  actor_id uuid references public.profiles(id) on delete set null,
  source text not null default 'user',
  action text not null,
  table_name text not null,
  record_id text,
  changed_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  title text not null check (length(title) between 1 and 160),
  due_on date,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  assignee_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.automation_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  kind text not null check (kind in ('task_due', 'rsvp_deadline')),
  days_before integer not null default 1 check (days_before between 0 and 60),
  enabled boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (wedding_id, kind, days_before)
);

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  rule_id uuid not null references public.automation_rules(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade,
  message_kind text not null,
  scheduled_for date not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (rule_id, task_id, recipient_id, scheduled_for)
);

create or replace function public.protect_owner_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.platform_role = 'owner' then
    raise exception 'The Owner account cannot be deleted.';
  end if;
  if tg_op = 'UPDATE' and old.platform_role = 'owner'
     and (new.platform_role <> 'owner' or new.id <> old.id) then
    raise exception 'The Owner account cannot be demoted or transferred through routine role updates.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists protect_owner_profile_trigger on public.profiles;
create trigger protect_owner_profile_trigger before update or delete on public.profiles
for each row execute function public.protect_owner_profile();

create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
begin
  v_name := nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 100), '');
  insert into public.profiles (id, display_name, platform_role)
  values (new.id, coalesce(v_name, 'WeddingSite member'), 'client')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists create_profile_for_auth_user_trigger on auth.users;
create trigger create_profile_for_auth_user_trigger after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create or replace function public.current_platform_role()
returns public.platform_role language sql stable security definer set search_path = ''
set row_security = off
as $$ select p.platform_role from public.profiles p where p.id = auth.uid() $$;

create or replace function public.can_access_wedding(p_wedding_id uuid)
returns boolean language sql stable security definer set search_path = ''
set row_security = off
as $$
  select coalesce(public.current_platform_role() in ('owner', 'superadmin'), false)
    or exists (
      select 1 from public.wedding_memberships m
      where m.wedding_id = p_wedding_id and m.user_id = auth.uid()
    )
$$;

create or replace function public.has_wedding_role(p_wedding_id uuid, p_roles public.workspace_role[])
returns boolean language sql stable security definer set search_path = ''
set row_security = off
as $$
  select coalesce(public.current_platform_role() = 'owner', false)
    or exists (
      select 1 from public.wedding_memberships m
      where m.wedding_id = p_wedding_id and m.user_id = auth.uid() and m.role = any(p_roles)
    )
$$;

create or replace function public.is_published_wedding(p_wedding_id uuid)
returns boolean language sql stable security definer set search_path = ''
set row_security = off
as $$ select exists (select 1 from public.weddings w where w.id = p_wedding_id and w.published_at is not null) $$;

create or replace function public.create_wedding(
  p_slug text, p_couple_names text, p_wedding_date date, p_location text,
  p_currency text, p_capacity integer, p_palette text[]
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare result_id uuid;
begin
  if auth.uid() is null or public.current_platform_role() not in ('client', 'owner') then
    raise exception 'A signed-in Client account is required to create a wedding workspace.';
  end if;
  if p_currency !~ '^[A-Z]{3}$' or p_capacity not between 1 and (
       select max_wedding_capacity from public.platform_policies where id
     ) or coalesce(cardinality(p_palette), 0) not between 1 and 4 or exists (
       select 1 from unnest(p_palette) as colors(color) where colors.color !~ '^#[0-9a-fA-F]{6}$'
     ) then
    raise exception 'Invalid wedding settings.';
  end if;
  insert into public.weddings
    (slug, couple_names, wedding_date, public_location, currency, max_guest_capacity, palette, client_owner_id)
  values
    (left(p_slug, 80), left(p_couple_names, 120), p_wedding_date, left(p_location, 120),
     upper(p_currency), p_capacity, p_palette, auth.uid())
  returning id into result_id;
  insert into public.wedding_memberships (wedding_id, user_id, role)
  values (result_id, auth.uid(), 'client');
  return result_id;
end;
$$;

create or replace function public.assign_platform_role(p_user_id uuid, p_role public.platform_role)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if public.current_platform_role() not in ('owner', 'superadmin') then
    raise exception 'Platform role management permission denied.';
  end if;
  if p_role = 'owner' then raise exception 'Owner assignment and transfer are not available through routine role management.'; end if;
  if public.current_platform_role() = 'superadmin' and (
    p_role = 'superadmin' or exists (
      select 1 from public.profiles p where p.id = p_user_id and p.platform_role in ('owner', 'superadmin')
    )
  ) then
    raise exception 'Only the protected Owner can assign or modify SuperAdmin accounts.';
  end if;
  update public.profiles set platform_role = p_role where id = p_user_id and platform_role <> 'owner';
  return found;
end;
$$;

create or replace function public.set_workspace_member_role(
  p_wedding_id uuid, p_user_id uuid, p_role public.workspace_role
) returns boolean language plpgsql security definer set search_path = ''
as $$
declare actor_role public.platform_role;
begin
  actor_role := public.current_platform_role();
  if actor_role not in ('owner', 'superadmin')
     and not (actor_role = 'client' and exists (
       select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid()
     )) then
    raise exception 'Workspace role management permission denied.';
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id and p.platform_role = 'owner') then
    raise exception 'The protected Owner cannot be managed as a workspace member.';
  end if;
  insert into public.wedding_memberships (wedding_id, user_id, role)
  values (p_wedding_id, p_user_id, p_role)
  on conflict (wedding_id, user_id) do update set role = excluded.role;
  return true;
end;
$$;

create or replace function public.configure_payment_provider(
  p_wedding_id uuid, p_provider text, p_enabled boolean,
  p_market_codes text[], p_currencies char(3)[], p_confirmed boolean
) returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to change gateway availability.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may configure gateways for this wedding.';
  end if;
  if p_provider not in ('stripe', 'paystack') or
     coalesce(cardinality(p_market_codes), 0) > 40 or coalesce(cardinality(p_currencies), 0) > 30 or
     (p_enabled and (coalesce(cardinality(p_market_codes), 0) = 0 or coalesce(cardinality(p_currencies), 0) = 0)) or
     exists (select 1 from unnest(coalesce(p_market_codes, '{}')) as markets(code) where markets.code !~ '^[A-Z0-9_-]{2,12}$') or
     exists (select 1 from unnest(coalesce(p_currencies, '{}')) as currencies(code) where currencies.code !~ '^[A-Z]{3}$') then
    raise exception 'Invalid gateway provider, market, or currency configuration.';
  end if;
  insert into public.payment_provider_configs
    (wedding_id, provider, enabled, market_codes, currencies, updated_by)
  values (p_wedding_id, p_provider, p_enabled, p_market_codes, p_currencies, auth.uid())
  on conflict (wedding_id, provider) do update
    set enabled = excluded.enabled, market_codes = excluded.market_codes,
        currencies = excluded.currencies, updated_by = auth.uid(), updated_at = now();
  return true;
end;
$$;

create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_id text;
  v_wedding_id uuid;
  v_changed text[];
begin
  v_new := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_old := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id', v_new ->> 'provider', v_old ->> 'provider');
  v_wedding_id := coalesce(
    (v_new ->> 'wedding_id')::uuid,
    (v_old ->> 'wedding_id')::uuid,
    case when tg_table_name = 'weddings' then coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid) end
  );
  select coalesce(array_agg(k), '{}') into v_changed
    from (
      select key as k from jsonb_each(v_new)
      union
      select key as k from jsonb_each(v_old)
    ) keys
    where v_new -> keys.k is distinct from v_old -> keys.k
      and keys.k not in ('updated_at', 'created_at');
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (
    v_wedding_id,
    auth.uid(),
    coalesce(nullif(current_setting('app.audit_source', true), ''), 'user'),
    lower(tg_op),
    tg_table_name,
    v_id,
    v_changed
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'weddings', 'wedding_memberships', 'platform_policies', 'fundraising_streams', 'payment_provider_configs', 'contributions',
    'expenses', 'payout_records', 'budget_lines', 'reconciliation_records', 'automation_rules'] loop
    execute format('drop trigger if exists audit_%I on public.%I', t, t);
    execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.audit_row_change()', t, t);
  end loop;
end $$;

create or replace function public.record_verified_payment(
  p_provider text,
  p_provider_event_id text,
  p_contribution_id uuid,
  p_amount_minor bigint,
  p_currency text,
  p_provider_reference text
) returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  c public.contributions%rowtype;
  inserted_count integer;
  fee bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider not in ('stripe', 'paystack') or length(p_provider_event_id) not between 1 and 200 then
    raise exception 'Unsupported payment event.';
  end if;
  select * into c from public.contributions where id = p_contribution_id for update;
  if not found then raise exception 'Contribution not found.'; end if;
  if c.provider_name is distinct from p_provider or c.provider_reference is distinct from p_provider_reference then
    raise exception 'Verified payment provider or checkout reference does not match the pledge.';
  end if;
  if upper(p_currency) <> c.currency or p_amount_minor <> c.pledged_amount_minor then
    raise exception 'Verified payment amount or currency does not match the pledge.';
  end if;
  insert into public.payment_events (provider, provider_event_id, contribution_id)
  values (p_provider, p_provider_event_id, c.id)
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then return false; end if;
  if c.payment_status <> 'pledged' then return false; end if;
  fee := round(p_amount_minor::numeric * c.platform_fee_basis_points / 10000)::bigint;
  update public.contributions
  set payment_status = 'paid',
      paid_amount_minor = p_amount_minor,
      platform_fee_minor = fee,
      net_paid_minor = p_amount_minor - fee,
      provider_name = p_provider,
      provider_reference = left(p_provider_reference, 160),
      paid_at = now()
  where id = c.id;
  return true;
end;
$$;

create or replace function public.record_expense(
  p_wedding_id uuid, p_category text, p_description text, p_amount_minor bigint,
  p_currency text, p_due_on date, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare result_id uuid;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to record an expense.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid expense amount or currency.';
  end if;
  if p_amount_minor > (select max_expense_minor from public.platform_policies where id) then
    raise exception 'Expense exceeds the configured per-record limit.';
  end if;
  insert into public.expenses (wedding_id, category, description, amount_minor, currency, due_on, created_by)
  values (p_wedding_id, left(p_category, 80), left(p_description, 240), p_amount_minor, p_currency, p_due_on, auth.uid())
  returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.request_payout(
  p_wedding_id uuid, p_amount_minor bigint, p_currency text, p_note text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  result_id uuid;
  available_minor bigint;
  workspace_currency char(3);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to request a payout.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may request a payout.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid payout amount or currency.';
  end if;
  select currency into workspace_currency from public.weddings where id = p_wedding_id for update;
  if not found or workspace_currency <> upper(p_currency) then
    raise exception 'Payout currency must match the wedding currency.';
  end if;
  if p_amount_minor > (select max_payout_minor from public.platform_policies where id) then
    raise exception 'Payout request exceeds the configured per-record limit.';
  end if;
  select coalesce(sum(c.net_paid_minor), 0)
    - coalesce((select sum(p.amount_minor) from public.payout_records p
      where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
        and p.status in ('requested', 'approved', 'sent')), 0)
  into available_minor
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency) and c.payment_status = 'paid';
  if p_amount_minor > greatest(available_minor, 0) then
    raise exception 'Payout request exceeds the currently recorded net contribution balance.';
  end if;
  insert into public.payout_records (wedding_id, amount_minor, currency, requested_by, note)
  values (p_wedding_id, p_amount_minor, p_currency, auth.uid(), left(p_note, 240))
  returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.record_reconciliation(
  p_wedding_id uuid, p_provider text, p_statement_reference text,
  p_expected_minor bigint, p_reported_minor bigint, p_currency text,
  p_note text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare result_id uuid;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to submit reconciliation evidence.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  if p_currency !~ '^[A-Z]{3}$' or abs(p_expected_minor) > 100000000000 or abs(p_reported_minor) > 100000000000 then
    raise exception 'Invalid reconciliation amount or currency.';
  end if;
  insert into public.reconciliation_records
    (wedding_id, provider, statement_reference, expected_minor, reported_minor, currency, note, recorded_by)
  values
    (p_wedding_id, left(p_provider, 60), left(p_statement_reference, 120), p_expected_minor, p_reported_minor,
     p_currency, left(p_note, 400), auth.uid())
  returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.save_budget_line(
  p_wedding_id uuid, p_category text, p_planned_minor bigint,
  p_actual_minor bigint, p_currency text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare result_id uuid;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to save a budget line.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may edit a budget.';
  end if;
  if nullif(trim(p_category), '') is null or p_planned_minor < 0 or p_actual_minor < 0 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid budget values.';
  end if;
  insert into public.budget_lines (wedding_id, category, planned_minor, actual_minor, currency, updated_by)
  values (p_wedding_id, left(p_category, 80), p_planned_minor, p_actual_minor, p_currency, auth.uid())
  on conflict (wedding_id, category) do update
    set planned_minor = excluded.planned_minor,
        actual_minor = excluded.actual_minor,
        currency = excluded.currency,
        updated_by = auth.uid(),
        updated_at = now()
  returning id into result_id;
  return result_id;
end;
$$;

create or replace function public.queue_due_reminders()
returns integer language plpgsql security definer set search_path = ''
as $$
declare inserted_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  insert into public.notification_outbox (wedding_id, rule_id, task_id, recipient_id, message_kind, scheduled_for)
  select r.wedding_id, r.id, t.id, t.assignee_id, r.kind, current_date
  from public.automation_rules r
  join public.tasks t on t.wedding_id = r.wedding_id
  where r.enabled and r.kind = 'task_due' and t.status in ('open', 'in_progress')
    and t.due_on = current_date + r.days_before
    and t.assignee_id is not null
  on conflict do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace view public.public_contribution_ledger
with (security_invoker = true)
as
select id, wedding_id, stream_name,
       case when visibility = 'name' then display_name else 'Anonymous guest' end as display_name,
       visibility, pledged_amount_minor, paid_amount_minor, currency,
       payment_status, created_at
from public.contributions
where public_consent_at is not null and visibility in ('name', 'anonymous');

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
  coalesce(c.pledged_minor, 0) as pledged_minor,
  coalesce(c.paid_minor, 0) as paid_gross_minor,
  coalesce(c.fees_minor, 0) as platform_fees_minor,
  coalesce(c.net_minor, 0) as net_contributions_minor,
  coalesce(e.proposed_minor, 0) as proposed_expenses_minor,
  coalesce(e.approved_minor, 0) as approved_expenses_minor,
  coalesce(e.paid_minor, 0) as paid_expenses_minor,
  coalesce(p.requested_minor, 0) as requested_payouts_minor,
  coalesce(p.sent_minor, 0) as sent_payouts_minor,
  coalesce(c.net_minor, 0) - coalesce(p.requested_minor, 0) - coalesce(p.sent_minor, 0) as estimated_unallocated_net_minor,
  coalesce(b.planned_minor, 0) as planned_budget_minor,
  coalesce(b.actual_minor, 0) as actual_budget_minor
from public.weddings w
join currencies on currencies.wedding_id = w.id
left join lateral (
  select sum(pledged_amount_minor) as pledged_minor,
         sum(paid_amount_minor) as paid_minor,
         sum(platform_fee_minor) as fees_minor,
         sum(net_paid_minor) as net_minor
  from public.contributions where wedding_id = w.id and currency = currencies.currency and payment_status <> 'refunded'
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

create or replace view public.finance_alerts
with (security_invoker = true)
as
select 'budget_overrun'::text as alert_type, b.wedding_id, b.category as subject,
       b.actual_minor - b.planned_minor as amount_minor, b.currency, b.updated_at as occurred_at
from public.budget_lines b where b.actual_minor > b.planned_minor
union all
select 'reconciliation_difference', r.wedding_id, r.statement_reference, r.difference_minor, r.currency, r.created_at
from public.reconciliation_records r where r.status <> 'matched'
union all
select 'payout_awaiting_review', p.wedding_id, p.id::text, p.amount_minor, p.currency, p.requested_at
from public.payout_records p where p.status = 'requested';

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists weddings_updated_at on public.weddings;
create trigger weddings_updated_at before update on public.weddings for each row execute function public.set_updated_at();
drop trigger if exists platform_policies_updated_at on public.platform_policies;
create trigger platform_policies_updated_at before update on public.platform_policies for each row execute function public.set_updated_at();
drop trigger if exists budget_lines_updated_at on public.budget_lines;
create trigger budget_lines_updated_at before update on public.budget_lines for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.weddings enable row level security;
alter table public.wedding_memberships enable row level security;
alter table public.platform_policies enable row level security;
alter table public.fundraising_streams enable row level security;
alter table public.payment_provider_configs enable row level security;
alter table public.contributions enable row level security;
alter table public.expenses enable row level security;
alter table public.payout_records enable row level security;
alter table public.budget_lines enable row level security;
alter table public.reconciliation_records enable row level security;
alter table public.payment_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.tasks enable row level security;
alter table public.automation_rules enable row level security;
alter table public.notification_outbox enable row level security;

drop policy if exists profile_self_read on public.profiles;
create policy profile_self_read on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists wedding_member_read on public.weddings;
create policy wedding_member_read on public.weddings for select to authenticated using (public.can_access_wedding(id));
drop policy if exists wedding_client_update on public.weddings;
create policy wedding_client_update on public.weddings for update to authenticated
using (public.has_wedding_role(id, array['client']::public.workspace_role[]))
with check (public.has_wedding_role(id, array['client']::public.workspace_role[]));
drop policy if exists membership_read on public.wedding_memberships;
create policy membership_read on public.wedding_memberships for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists policy_read on public.platform_policies;
create policy policy_read on public.platform_policies for select to authenticated
using (public.current_platform_role() in ('owner', 'superadmin'));
drop policy if exists policy_update on public.platform_policies;
create policy policy_update on public.platform_policies for update to authenticated
using (public.current_platform_role() in ('owner', 'superadmin'))
with check (public.current_platform_role() in ('owner', 'superadmin'));
drop policy if exists fundraising_stream_public_read on public.fundraising_streams;
create policy fundraising_stream_public_read on public.fundraising_streams for select to anon, authenticated
using (enabled and public.is_published_wedding(wedding_id)
  or auth.role() = 'authenticated' and public.can_access_wedding(wedding_id));
drop policy if exists payment_config_workspace_read on public.payment_provider_configs;
create policy payment_config_workspace_read on public.payment_provider_configs for select to authenticated
using (public.can_access_wedding(wedding_id));

drop policy if exists contribution_workspace_read on public.contributions;
create policy contribution_workspace_read on public.contributions for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists contribution_public_consent_read on public.contributions;
create policy contribution_public_consent_read on public.contributions for select to anon using (public_consent_at is not null and visibility in ('name', 'anonymous'));
drop policy if exists expense_workspace_read on public.expenses;
create policy expense_workspace_read on public.expenses for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists payout_workspace_read on public.payout_records;
create policy payout_workspace_read on public.payout_records for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists budget_workspace_read on public.budget_lines;
create policy budget_workspace_read on public.budget_lines for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists reconciliation_workspace_read on public.reconciliation_records;
create policy reconciliation_workspace_read on public.reconciliation_records for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists audit_workspace_read on public.audit_events;
create policy audit_workspace_read on public.audit_events for select to authenticated
using (wedding_id is null and public.current_platform_role() in ('owner', 'superadmin') or public.can_access_wedding(wedding_id));
drop policy if exists task_workspace_read on public.tasks;
create policy task_workspace_read on public.tasks for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists automation_workspace_read on public.automation_rules;
create policy automation_workspace_read on public.automation_rules for select to authenticated using (public.can_access_wedding(wedding_id));
drop policy if exists outbox_workspace_read on public.notification_outbox;
create policy outbox_workspace_read on public.notification_outbox for select to authenticated using (public.can_access_wedding(wedding_id));

revoke all on all tables in schema public from anon, authenticated;
grant select (id, wedding_id, stream_name, display_name, visibility, pledged_amount_minor, paid_amount_minor, currency, payment_status, created_at, public_consent_at)
  on public.contributions to anon;
grant select (id, wedding_id, name, purpose, goal_minor, currency) on public.fundraising_streams to anon;
grant select on public.profiles, public.weddings, public.wedding_memberships, public.platform_policies,
  public.fundraising_streams, public.payment_provider_configs, public.contributions, public.expenses, public.payout_records, public.budget_lines,
  public.reconciliation_records, public.audit_events, public.tasks, public.automation_rules,
  public.notification_outbox to authenticated;
grant select on public.public_contribution_ledger to anon, authenticated;
grant select on public.finance_summary, public.finance_alerts to authenticated;
grant update (slug, couple_names, welcome_story, wedding_date, public_location, currency, max_guest_capacity, palette, updated_at)
  on public.weddings to authenticated;
grant update (publication_fee_minor, contribution_fee_basis_points, max_contribution_minor, max_expense_minor, max_payout_minor, max_wedding_capacity, unreconciled_alert_days, updated_by, updated_at)
  on public.platform_policies to authenticated;
grant update (enabled, market_codes, currencies, updated_by, updated_at) on public.payment_provider_configs to authenticated;

revoke all on function public.record_verified_payment(text, text, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, uuid, bigint, text, text) to service_role;
grant execute on function public.current_platform_role() to authenticated;
grant execute on function public.can_access_wedding(uuid) to authenticated;
grant execute on function public.has_wedding_role(uuid, public.workspace_role[]) to authenticated;
grant execute on function public.is_published_wedding(uuid) to anon, authenticated;
revoke all on function public.queue_due_reminders() from public, anon, authenticated;
grant execute on function public.queue_due_reminders() to service_role;
revoke all on function public.record_expense(uuid, text, text, bigint, text, date, boolean) from public, anon;
grant execute on function public.record_expense(uuid, text, text, bigint, text, date, boolean) to authenticated;
revoke all on function public.request_payout(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.request_payout(uuid, bigint, text, text, boolean) to authenticated;
revoke all on function public.record_reconciliation(uuid, text, text, bigint, bigint, text, text, boolean) from public, anon;
grant execute on function public.record_reconciliation(uuid, text, text, bigint, bigint, text, text, boolean) to authenticated;
revoke all on function public.save_budget_line(uuid, text, bigint, bigint, text, boolean) from public, anon;
grant execute on function public.save_budget_line(uuid, text, bigint, bigint, text, boolean) to authenticated;
revoke all on function public.create_wedding(text, text, date, text, text, integer, text[]) from public, anon;
grant execute on function public.create_wedding(text, text, date, text, text, integer, text[]) to authenticated;
revoke all on function public.assign_platform_role(uuid, public.platform_role) from public, anon;
grant execute on function public.assign_platform_role(uuid, public.platform_role) to authenticated;
revoke all on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) from public, anon;
grant execute on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) to authenticated;
revoke all on function public.configure_payment_provider(uuid, text, boolean, text[], char(3)[], boolean) from public, anon;
grant execute on function public.configure_payment_provider(uuid, text, boolean, text[], char(3)[], boolean) to authenticated;

create index if not exists contributions_wedding_created_idx on public.contributions (wedding_id, created_at desc);
create unique index if not exists contribution_provider_reference_unique
  on public.contributions (provider_name, provider_reference) where provider_reference is not null;
create index if not exists expenses_wedding_status_idx on public.expenses (wedding_id, status, due_on);
create index if not exists payouts_wedding_status_idx on public.payout_records (wedding_id, status, requested_at desc);
create index if not exists reconciliation_wedding_status_idx on public.reconciliation_records (wedding_id, status, created_at desc);
create index if not exists tasks_due_idx on public.tasks (wedding_id, due_on) where status in ('open', 'in_progress');
