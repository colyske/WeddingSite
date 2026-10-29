-- Restrict organization-wide reads without removing per-wedding support.
do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.admin_overview()', 'public.admin_settlement_overview()',
    'public.admin_audit(integer)', 'public.admin_get_policies()',
    'public.admin_get_refund_policy()', 'public.admin_get_payment_controls()',
    'public.admin_set_payment_controls(text[],boolean)',
    'public.admin_ledger(integer)', 'public.admin_payouts()'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position('public.require_staff()' in definition) = 0 then
      raise exception 'Expected staff guard missing in %', signature;
    end if;
    execute replace(definition, 'public.require_staff()', 'public.require_staff(''superadmin'')');
  end loop;
end $$;

create or replace function public.admin_set_role(p_user_id uuid, p_role text) returns boolean
language plpgsql security definer set search_path = '' set row_security = off as $$
declare ok boolean;
begin
  perform public.require_staff('superadmin');
  if p_role is null or p_role not in ('client', 'admin', 'superadmin') then raise exception 'Choose a valid role.'; end if;
  if p_user_id = auth.uid() then raise exception 'You cannot change your own role.'; end if;
  ok := public.assign_platform_role(p_user_id, p_role::public.platform_role);
  if not ok then raise exception 'Platform role assignment is not permitted.'; end if;
  insert into public.audit_events(actor_id, source, action, table_name, record_id, changed_fields)
    values(auth.uid(), 'user', 'role_change:' || p_role, 'profiles', p_user_id::text, array['platform_role']);
  return true;
end $$;

-- The underlying authenticated RPC must also reject self-changes and missing actors.
create or replace function public.assign_platform_role(p_user_id uuid, p_role public.platform_role)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  if p_user_id = auth.uid() or p_role is null or p_role = 'owner' then
    raise exception 'Platform role assignment is not permitted.';
  end if;
  if public.current_platform_role() = 'superadmin' and (
    p_role = 'superadmin' or exists (select 1 from public.profiles
      where id = p_user_id and platform_role in ('owner', 'superadmin'))
  ) then raise exception 'Platform role assignment is not permitted.'; end if;
  update public.profiles set platform_role = p_role where id = p_user_id and platform_role <> 'owner';
  return found;
end $$;

create or replace function public.admin_list_users(p_search text default null)
returns table(id uuid, email text, display_name text, platform_role text, wedding_count bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off as $$
declare r public.platform_role := public.require_staff();
begin
  return query select p.id, u.email::text, p.display_name, p.platform_role::text,
    (select count(*) from public.weddings w where w.client_owner_id = p.id), p.created_at
  from public.profiles p left join auth.users u on u.id = p.id
  where (r = 'owner' or r = 'superadmin' and p.platform_role <> 'owner'
    or r = 'admin' and p.platform_role in ('client', 'admin'))
    and (p_search is null or p_search = '' or u.email ilike '%' || p_search || '%' or p.display_name ilike '%' || p_search || '%')
  order by p.created_at desc limit 300;
end $$;

create or replace function public.admin_policy_history(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off as $$
begin
  perform public.require_staff('superadmin');
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.changed_at desc) from (
    select changed_at, old_values, new_values from public.platform_policy_history
    order by changed_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) h), '[]'::jsonb);
end $$;

drop policy policy_update on public.platform_policies;
create policy policy_update on public.platform_policies for update to authenticated
  using (public.current_platform_role() = 'owner') with check (public.current_platform_role() = 'owner');
-- SuperAdmins may change provider availability via its audited RPC only, not fees.
create function public.guard_platform_policy_authority() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() = 'service_role' or session_user = 'postgres' and current_setting('role') = 'none' then return new; end if;
  perform public.require_staff('superadmin');
  if public.current_platform_role() <> 'owner' and
    (to_jsonb(new) - array['enabled_payment_providers','updated_by','updated_at'])
      is distinct from (to_jsonb(old) - array['enabled_payment_providers','updated_by','updated_at']) then
    raise exception 'Only the protected Owner can change platform fee and payout policies.';
  end if;
  return new;
end $$;
create trigger guard_platform_policy_authority before update on public.platform_policies
  for each row execute function public.guard_platform_policy_authority();

drop policy audit_workspace_read on public.audit_events;
create policy audit_workspace_read on public.audit_events for select to authenticated using (
  public.current_platform_role() = 'owner'
  or public.current_platform_role() = 'superadmin' and
    (wedding_id is not null or table_name <> 'profiles' and source <> 'protected_owner_bootstrap')
  or public.current_platform_role() not in ('owner','superadmin') and exists (select 1 from public.wedding_memberships m
    where m.wedding_id = audit_events.wedding_id and m.user_id = auth.uid())
);

do $$
declare item record;
begin
  for item in select * from (values
    ('contributions', 'contribution_workspace_read'), ('expenses', 'expense_workspace_read'),
    ('payout_records', 'payout_workspace_read'), ('budget_lines', 'budget_workspace_read'),
    ('reconciliation_records', 'reconciliation_workspace_read'),
    ('payment_adjustments', 'payment_adjustment_workspace_read'),
    ('financial_adjustment_ledger', 'financial_adjustment_workspace_read')
  ) as policies(table_name, policy_name) loop
    execute format('drop policy %I on public.%I', item.policy_name, item.table_name);
    execute format('create policy %I on public.%I for select to authenticated using (
      public.current_platform_role() in (''owner'',''superadmin'')
      or exists (select 1 from public.wedding_memberships m where m.wedding_id = %I.wedding_id and m.user_id = auth.uid())
    )', item.policy_name, item.table_name, item.table_name);
  end loop;
end $$;

-- Keep historic enquiries/cards intact; only decline/archive them, never create new in-kind offers.
alter table public.weddings alter column allow_in_kind_sponsorship set default false;
create function public.guard_paid_sponsorship_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'weddings' then
    if new.allow_in_kind_sponsorship and (tg_op = 'INSERT' or not old.allow_in_kind_sponsorship) then
      raise exception 'Free and in-kind sponsorship solicitation is no longer available.';
    end if;
  elsif tg_table_name = 'sponsor_enquiries' then
    if tg_op = 'INSERT' or new.status = 'approved' and old.status <> 'approved' then
      raise exception 'New free and in-kind sponsorship is no longer available.';
    end if;
  elsif new.in_kind and (tg_op = 'INSERT' or not old.in_kind) then
    raise exception 'New free and in-kind sponsorship is no longer available.';
  end if;
  return new;
end $$;
create trigger guard_paid_sponsorship_only before insert or update on public.weddings
  for each row execute function public.guard_paid_sponsorship_only();
create trigger guard_paid_sponsorship_only before insert or update on public.sponsors
  for each row execute function public.guard_paid_sponsorship_only();
create trigger guard_paid_sponsorship_only before insert or update on public.sponsor_enquiries
  for each row execute function public.guard_paid_sponsorship_only();

-- All integrations shipped so far accept test credentials only. Preserve original
-- monetary records, but separate their simulated balance from withdrawable cash.
alter table public.contributions add column payment_environment text not null default 'test'
  check (payment_environment in ('test','live'));
create function public.guard_payment_environment() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.payment_environment <> 'test' then
    raise exception 'Live payment settlement is not enabled.';
  end if;
  return new;
end $$;
create trigger guard_payment_environment before insert or update of payment_environment on public.contributions
  for each row execute function public.guard_payment_environment();

do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.withdrawable_balance(uuid,text)', 'public.request_payout(uuid,bigint,text,text,boolean)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position('and c.verified_provider_payment' in definition) = 0 then
      raise exception 'Expected verified-funds guard missing in %', signature;
    end if;
    definition := replace(definition, 'and c.verified_provider_payment',
      'and c.verified_provider_payment and c.payment_environment = ''live''');
    definition := replace(definition, 'l.currency = upper(p_currency)',
      'l.currency = upper(p_currency) and exists (select 1 from public.contributions live_payment where live_payment.id = l.contribution_id and live_payment.payment_environment = ''live'')');
    execute definition;
  end loop;
end $$;

create function public.guard_test_payouts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('requested','approved','sent') and not exists (
    select 1 from public.contributions c where c.wedding_id = new.wedding_id
      and c.currency = new.currency and c.payment_environment = 'live'
      and c.verified_provider_payment and c.payment_status = 'paid'
  ) then raise exception 'Test-provider funds cannot be paid out.'; end if;
  return new;
end $$;
create trigger guard_test_payouts before insert or update of status on public.payout_records
  for each row execute function public.guard_test_payouts();
