-- Funds settlement delay. Paystack needs at least 2 days to settle, so funds are withdrawable from day 3.
-- Additive: existing paid rows have funds_available_at = null, which means "available now".
alter table public.contributions add column if not exists funds_available_at timestamptz;

create or replace function public.record_verified_payment(
  p_provider text, p_provider_event_id text, p_contribution_id uuid,
  p_amount_minor bigint, p_currency text, p_provider_reference text
) returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  c public.contributions;
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
      paid_at = now(),
      funds_available_at = case when p_provider = 'paystack' then now() + interval '3 days' else now() end
  where id = c.id;
  return true;
end;
$$;

-- Available-to-withdraw = settled net funds minus payouts already requested/approved/sent.
create or replace function public.withdrawable_balance(p_wedding_id uuid, p_currency text)
returns table (available_minor bigint, settling_minor bigint, next_available_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  return query
  select
    greatest(coalesce(sum(c.net_paid_minor) filter (where c.funds_available_at is null or c.funds_available_at <= now()), 0)
      - coalesce((select sum(p.amount_minor) from public.payout_records p
          where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
            and p.status in ('requested', 'approved', 'sent')), 0), 0)::bigint,
    coalesce(sum(c.net_paid_minor) filter (where c.funds_available_at > now()), 0)::bigint,
    min(c.funds_available_at) filter (where c.funds_available_at > now())
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency) and c.payment_status = 'paid';
end;
$$;
revoke all on function public.withdrawable_balance(uuid, text) from public, anon;
grant execute on function public.withdrawable_balance(uuid, text) to authenticated;

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
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency) and c.payment_status = 'paid'
    and (c.funds_available_at is null or c.funds_available_at <= now());
  if p_amount_minor > greatest(available_minor, 0) then
    raise exception 'Payout request exceeds the settled balance. Paystack funds become available from the 3rd day after payment.';
  end if;
  insert into public.payout_records (wedding_id, amount_minor, currency, requested_by, note)
  values (p_wedding_id, p_amount_minor, p_currency, auth.uid(), left(p_note, 240))
  returning id into result_id;
  return result_id;
end;
$$;
