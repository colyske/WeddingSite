-- Live Daraja (M-Pesa STK Push) collection: default OFF, additive.
-- Admission requires the protected Owner's approval record here AND the application's
-- explicit environment switches. Payouts stay locked by a separate gate that this
-- migration cannot enable (payouts_enabled is constrained to false).

create table if not exists public.daraja_live_approval (
  singleton boolean primary key default true check (singleton),
  approved boolean not null default false,
  shortcode text check (shortcode is null or shortcode ~ '^[0-9]{5,7}$'),
  approved_by uuid,
  approved_at timestamptz,
  payouts_enabled boolean not null default false check (payouts_enabled = false),
  check (not approved or (shortcode is not null and approved_by is not null and approved_at is not null))
);
insert into public.daraja_live_approval(singleton) values (true) on conflict do nothing;
alter table public.daraja_live_approval enable row level security;
revoke all on public.daraja_live_approval from public, anon, authenticated;

-- Immutable merchant context for a live payment, persisted at admission/initiation.
alter table public.contributions
  add column if not exists daraja_shortcode text check (daraja_shortcode is null or daraja_shortcode ~ '^[0-9]{5,7}$'),
  add column if not exists daraja_merchant_request_id text check (daraja_merchant_request_id is null or length(daraja_merchant_request_id) between 1 and 160);

create or replace function public.live_payouts_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select payouts_enabled and approved from public.daraja_live_approval), false)
$$;
revoke all on function public.live_payouts_enabled() from public, anon;
grant execute on function public.live_payouts_enabled() to authenticated, service_role;

-- Only Daraja rows may be live; every other live-specific rule lives in the context guard.
create or replace function public.guard_payment_environment() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.payment_environment <> 'test' and not (new.payment_environment = 'live' and new.provider_name = 'daraja') then
    raise exception 'Live payment settlement is not enabled.';
  end if;
  return new;
end $$;

create or replace function public.guard_live_payment_context() returns trigger
language plpgsql security definer set search_path = '' as $$
declare approval public.daraja_live_approval;
begin
  if tg_op = 'INSERT' then
    if new.payment_environment <> 'live' then
      if new.daraja_shortcode is not null or new.daraja_merchant_request_id is not null then
        raise exception 'Daraja merchant context is only valid on live payments.';
      end if;
      return new;
    end if;
    select * into approval from public.daraja_live_approval;
    if not coalesce(approval.approved, false) or approval.shortcode is distinct from new.daraja_shortcode then
      raise exception 'Live Daraja collection is not approved for this shortcode.';
    end if;
    if new.provider_name is distinct from 'daraja' or new.currency <> 'KES' or new.payment_status <> 'pending'
       or new.verified_provider_payment or new.provider_reference is not null
       or new.daraja_merchant_request_id is not null then
      raise exception 'A live Daraja payment must be admitted as a pending KES request with no provider reference.';
    end if;
    return new;
  end if;

  if old.payment_environment is distinct from new.payment_environment then
    raise exception 'Payment environment is immutable.';
  end if;
  if new.payment_environment <> 'live' then
    if new.daraja_shortcode is not null or new.daraja_merchant_request_id is not null then
      raise exception 'Daraja merchant context is only valid on live payments.';
    end if;
    return new;
  end if;
  if new.provider_name is distinct from old.provider_name or new.currency is distinct from old.currency
     or new.pledged_amount_minor is distinct from old.pledged_amount_minor
     or new.daraja_shortcode is distinct from old.daraja_shortcode
     or (old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference)
     or (old.daraja_merchant_request_id is not null
       and new.daraja_merchant_request_id is distinct from old.daraja_merchant_request_id) then
    raise exception 'Live payment context is immutable once recorded.';
  end if;
  -- Settlement (through record_verified_payment or any direct update) needs the exact
  -- request IDs and merchant to have been persisted BEFORE the paid transition.
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    if old.provider_reference is null or old.daraja_merchant_request_id is null or old.daraja_shortcode is null
       or old.payment_status <> 'pending' or not new.verified_provider_payment
       or new.provider_name is distinct from 'daraja' or new.currency <> 'KES' then
      raise exception 'Live payment cannot settle without its persisted request and merchant context.';
    end if;
  end if;
  if new.verified_provider_payment and not old.verified_provider_payment and new.payment_status <> 'paid' then
    raise exception 'Verification flag requires a paid live payment.';
  end if;
  return new;
end $$;
drop trigger if exists guard_live_payment_context on public.contributions;
create trigger guard_live_payment_context before insert or update on public.contributions
  for each row execute function public.guard_live_payment_context();

-- Withdrawable funds and payout creation stay empty until the separate payout gate is on.
do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.withdrawable_balance(uuid,text)', 'public.request_payout(uuid,bigint,text,text,boolean)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position('c.payment_environment = ''live''' in definition) = 0 then
      raise exception 'Expected live-environment guard missing in %', signature;
    end if;
    definition := replace(definition, 'c.payment_environment = ''live''',
      'c.payment_environment = ''live'' and public.live_payouts_enabled()');
    definition := replace(definition, 'live_payment.payment_environment = ''live''',
      'live_payment.payment_environment = ''live'' and public.live_payouts_enabled()');
    execute definition;
  end loop;
end $$;

-- A live Daraja payment alone never unlocks payouts: the gate must be on, the funds
-- paid, and the unknown provider fee resolved.
create or replace function public.guard_test_payouts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('requested','approved','sent') and (not public.live_payouts_enabled() or not exists (
    select 1 from public.contributions c where c.wedding_id = new.wedding_id
      and c.currency = new.currency and c.payment_environment = 'live'
      and c.verified_provider_payment and c.payment_status = 'paid' and not c.provider_fee_pending
  )) then raise exception 'Test-provider funds cannot be paid out.'; end if;
  return new;
end $$;

create or replace function public.owner_get_daraja_live_approval() returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off as $$
begin
  perform public.require_staff('owner');
  return (select jsonb_build_object('approved', approved, 'shortcode', shortcode, 'approved_at', approved_at,
    'payouts_enabled', payouts_enabled) from public.daraja_live_approval);
end $$;

-- Only the protected Owner may approve; revoking never needs a shortcode.
create or replace function public.owner_set_daraja_live_approval(p_approved boolean, p_shortcode text default null)
returns boolean language plpgsql security definer set search_path = '' set row_security = off as $$
begin
  perform public.require_staff('owner');
  if p_approved is null then raise exception 'Choose approve or revoke.'; end if;
  if p_approved and (p_shortcode is null or p_shortcode !~ '^[0-9]{5,7}$') then
    raise exception 'Enter the production shortcode being approved.';
  end if;
  update public.daraja_live_approval set
    approved = p_approved,
    shortcode = case when p_approved then p_shortcode else null end,
    approved_by = case when p_approved then auth.uid() else null end,
    approved_at = case when p_approved then now() else null end;
  insert into public.audit_events(actor_id, source, action, table_name, record_id, changed_fields)
    values(auth.uid(), 'user', case when p_approved then 'daraja_live_approve' else 'daraja_live_revoke' end,
      'daraja_live_approval', 'singleton', array['approved']);
  return true;
end $$;

revoke all on function public.owner_get_daraja_live_approval() from public, anon;
revoke all on function public.owner_set_daraja_live_approval(boolean, text) from public, anon;
grant execute on function public.owner_get_daraja_live_approval() to authenticated;
grant execute on function public.owner_set_daraja_live_approval(boolean, text) to authenticated;
