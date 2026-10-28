-- Daraja is enabled for KES collection (STK Push) only. It is not a payout
-- provider and is intentionally excluded from refund/dispute automation.

alter table public.payment_provider_configs
  drop constraint if exists payment_provider_configs_provider_check;
alter table public.payment_provider_configs
  add constraint payment_provider_configs_provider_check
  check (provider in ('stripe', 'paystack', 'daraja'));

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
  if p_provider not in ('stripe', 'paystack', 'daraja') or
     coalesce(cardinality(p_market_codes), 0) > 40 or coalesce(cardinality(p_currencies), 0) > 30 or
     (p_enabled and (coalesce(cardinality(p_market_codes), 0) = 0 or coalesce(cardinality(p_currencies), 0) = 0)) or
     exists (select 1 from unnest(coalesce(p_market_codes, '{}')) as markets(code) where markets.code !~ '^[A-Z0-9_-]{2,12}$') or
     exists (select 1 from unnest(coalesce(p_currencies, '{}')) as currencies(code) where currencies.code !~ '^[A-Z]{3}$') then
    raise exception 'Invalid gateway provider, market, or currency configuration.';
  end if;
  if p_provider = 'daraja' and p_enabled and
     (p_market_codes is distinct from array['KE']::text[] or p_currencies is distinct from array['KES']::char(3)[]) then
    raise exception 'Daraja collection is limited to the Kenya market and KES currency.';
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

create or replace function public.record_verified_payment(
  p_provider text, p_provider_event_id text, p_contribution_id uuid,
  p_amount_minor bigint, p_currency text, p_provider_reference text,
  p_provider_fee_minor bigint default null, p_provider_paid_at timestamptz default null
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  c public.contributions;
  inserted_count integer;
  fee bigint;
  hold_days integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider not in ('stripe', 'paystack', 'daraja') or length(p_provider_event_id) not between 1 and 200 then
    raise exception 'Unsupported payment event.';
  end if;
  if p_provider = 'daraja' and upper(p_currency) <> 'KES' then
    raise exception 'Daraja verified payments must be in KES.';
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
  select greatest(payout_hold_days, case when p_provider in ('paystack', 'daraja') then 3 else 0 end)
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
    paid_at = coalesce(p_provider_paid_at, now()),
    funds_available_at = coalesce(p_provider_paid_at, now()) + make_interval(days => coalesce(hold_days, 3))
  where id = c.id;
  return true;
end $$;
revoke all on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz) to service_role;

create or replace function public.record_verified_payment(
  p_provider text, p_provider_event_id text, p_contribution_id uuid,
  p_amount_minor bigint, p_currency text, p_provider_reference text,
  p_provider_fee_minor bigint, p_provider_paid_at timestamptz,
  p_provider_payment_reference text
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare recorded boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider not in ('stripe', 'paystack', 'daraja') then
    raise exception 'Unsupported payment provider.';
  end if;
  if p_provider_payment_reference is not null and length(p_provider_payment_reference) not between 1 and 200 then
    raise exception 'Invalid provider payment reference.';
  end if;
  recorded := public.record_verified_payment(
    p_provider, p_provider_event_id, p_contribution_id, p_amount_minor,
    p_currency, p_provider_reference, p_provider_fee_minor, p_provider_paid_at
  );
  if p_provider_payment_reference is not null then
    update public.contributions set provider_payment_reference = p_provider_payment_reference
    where id = p_contribution_id and provider_name = p_provider
      and (provider_payment_reference is null or provider_payment_reference = p_provider_payment_reference);
    if not found then raise exception 'Provider payment reference conflicts with the verified payment.'; end if;
  end if;
  return recorded;
end $$;
revoke all on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz, text) to service_role;
