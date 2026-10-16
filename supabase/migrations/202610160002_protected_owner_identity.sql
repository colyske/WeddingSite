create table public.protected_platform_owner (
  singleton boolean primary key default true check (singleton),
  owner_email text not null check (owner_email = 'colyske@gmail.com'),
  owner_user_id uuid unique references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

do $$
declare
  existing_owner_id uuid;
begin
  select p.id
    into existing_owner_id
  from public.profiles p
  where p.platform_role = 'owner'
  limit 1;

  if existing_owner_id is not null and not exists (
    select 1
    from auth.users u
    where u.id = existing_owner_id
      and lower(u.email) = 'colyske@gmail.com'
      and u.email_confirmed_at is not null
  ) then
    raise exception 'Existing platform role configuration requires operator review before migration.';
  end if;

  insert into public.protected_platform_owner (singleton, owner_email, owner_user_id)
  values (true, 'colyske@gmail.com', existing_owner_id);
end;
$$;

create or replace function public.guard_protected_owner_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Platform identity configuration cannot be removed.';
  end if;

  if new.singleton is distinct from true
     or new.owner_email is distinct from 'colyske@gmail.com'
     or (tg_op = 'UPDATE' and old.owner_user_id is not null
         and new.owner_user_id is distinct from old.owner_user_id) then
    raise exception 'Platform identity configuration cannot be changed.';
  end if;

  if new.owner_user_id is not null and not exists (
    select 1
    from auth.users u
    where u.id = new.owner_user_id
      and lower(u.email) = 'colyske@gmail.com'
      and u.email_confirmed_at is not null
  ) then
    raise exception 'Platform identity configuration cannot be changed.';
  end if;

  return new;
end;
$$;

create trigger guard_protected_owner_identity_trigger
before update or delete on public.protected_platform_owner
for each row execute function public.guard_protected_owner_identity();

alter table public.protected_platform_owner enable row level security;
revoke all on public.protected_platform_owner from public, anon, authenticated, service_role;

create or replace function public.protect_owner_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.platform_role = 'owner' then
      raise exception 'Profile change is not permitted.';
    end if;
    return old;
  end if;

  if new.platform_role = 'owner' and not exists (
    select 1
    from public.protected_platform_owner o
    where o.singleton
      and o.owner_user_id = new.id
  ) then
    raise exception 'Profile change is not permitted.';
  end if;

  if tg_op = 'UPDATE' and old.platform_role = 'owner'
     and (new.platform_role is distinct from 'owner' or new.id is distinct from old.id) then
    raise exception 'Profile change is not permitted.';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_owner_profile_trigger on public.profiles;
create trigger protect_owner_profile_trigger
before insert or update or delete on public.profiles
for each row execute function public.protect_owner_profile();

create or replace function public.bootstrap_protected_owner(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  verified_user_id uuid;
  existing_owner_id uuid;
begin
  select u.id
    into verified_user_id
  from auth.users u
  where u.id = p_user_id
    and lower(u.email) = 'colyske@gmail.com'
    and u.email_confirmed_at is not null;

  if verified_user_id is null then
    raise exception 'No confirmed account matches the authorized platform identity.';
  end if;

  select o.owner_user_id
    into existing_owner_id
  from public.protected_platform_owner o
  where o.singleton
  for update;

  if existing_owner_id is not null and existing_owner_id <> verified_user_id then
    raise exception 'Platform identity has already been provisioned.';
  end if;

  update public.protected_platform_owner
    set owner_user_id = verified_user_id
  where singleton;

  perform set_config('app.audit_source', 'protected_owner_bootstrap', true);

  insert into public.profiles (id, display_name, platform_role)
  values (verified_user_id, 'Colin Mundia', 'owner')
  on conflict (id) do update
    set display_name = 'Colin Mundia',
        platform_role = 'owner';

  insert into public.audit_events
    (actor_id, source, action, table_name, record_id, changed_fields)
  values
    (verified_user_id, 'protected_owner_bootstrap', 'bootstrap', 'profiles',
     verified_user_id::text, array['platform_role']);

  return verified_user_id;
end;
$$;

revoke all on function public.bootstrap_protected_owner(uuid) from public, anon, authenticated;
grant execute on function public.bootstrap_protected_owner(uuid) to service_role;

create or replace function public.assign_platform_role(p_user_id uuid, p_role public.platform_role)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.current_platform_role() not in ('owner', 'superadmin') then
    raise exception 'Platform role management permission denied.';
  end if;
  if p_role = 'owner' then
    raise exception 'Platform role assignment is not permitted.';
  end if;
  if public.current_platform_role() = 'superadmin' and (
    p_role = 'superadmin' or exists (
      select 1 from public.profiles p where p.id = p_user_id and p.platform_role in ('owner', 'superadmin')
    )
  ) then
    raise exception 'Platform role assignment is not permitted.';
  end if;
  update public.profiles
    set platform_role = p_role
  where id = p_user_id and platform_role <> 'owner';
  return found;
end;
$$;

create or replace function public.set_workspace_member_role(
  p_wedding_id uuid, p_user_id uuid, p_role public.workspace_role
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.platform_role;
begin
  actor_role := public.current_platform_role();
  if actor_role not in ('owner', 'superadmin')
     and not (actor_role = 'client' and exists (
       select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid()
     )) then
    raise exception 'Workspace role management permission denied.';
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id and p.platform_role = 'owner') then
    raise exception 'Workspace role change is not permitted.';
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
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to change gateway availability.';
  end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Wedding settings permission denied.';
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

create or replace function public.request_payout(
  p_wedding_id uuid, p_amount_minor bigint, p_currency text, p_note text, p_confirmed boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_id uuid;
  available_minor bigint;
  workspace_currency char(3);
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to request a payout.';
  end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Payout request permission denied.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid payout amount or currency.';
  end if;
  select currency into workspace_currency
  from public.weddings where id = p_wedding_id for update;
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

create or replace function public.save_budget_line(
  p_wedding_id uuid, p_category text, p_planned_minor bigint,
  p_actual_minor bigint, p_currency text, p_confirmed boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_id uuid;
begin
  if not coalesce(p_confirmed, false) then
    raise exception 'Explicit confirmation is required to save a budget line.';
  end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Budget editing permission denied.';
  end if;
  if nullif(trim(p_category), '') is null or p_planned_minor < 0 or
     p_actual_minor < 0 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid budget values.';
  end if;
  insert into public.budget_lines
    (wedding_id, category, planned_minor, actual_minor, currency, updated_by)
  values
    (p_wedding_id, left(p_category, 80), p_planned_minor, p_actual_minor, p_currency, auth.uid())
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

drop policy if exists audit_workspace_read on public.audit_events;
create policy audit_workspace_read on public.audit_events
for select to authenticated
using (
  (
    public.current_platform_role() = 'owner'
    and (wedding_id is null or public.can_access_wedding(wedding_id))
  )
  or (
    public.current_platform_role() = 'superadmin'
    and (
      (wedding_id is null and table_name <> 'profiles' and source <> 'protected_owner_bootstrap')
      or (wedding_id is not null and public.can_access_wedding(wedding_id))
    )
  )
  or (
    public.current_platform_role() not in ('owner', 'superadmin')
    and wedding_id is not null
    and public.can_access_wedding(wedding_id)
  )
);
