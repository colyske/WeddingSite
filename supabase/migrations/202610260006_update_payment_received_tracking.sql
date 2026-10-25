-- Update record_verified_payment RPC to track payment_received_at
-- Paystack takes 2-3 business days to transfer funds, so we'll set
-- payment_received_at to now + 3 calendar days (roughly 2 business days)
-- to conservatively track when funds should be available

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
      payment_received_at = case
        when p_provider = 'paystack' then now() + interval '3 days'
        else now()
      end
  where id = c.id;
  return true;
end;
$$;
