-- A Daraja STK Query may answer ResultCode 4999 ("still under processing") while the
-- customer is entering their PIN. Earlier code treated that as a final failure and
-- cancelled the payment, so the later successful callback was ignored. This RPC lets
-- the server settle such a row only after the provider has independently confirmed
-- the exact bound CheckoutRequestID with ResultCode 0. It reopens and settles in one
-- transaction, so nothing changes unless the normal verified-payment path succeeds.
create or replace function public.recover_verified_daraja_payment(
  p_provider_event_id text,
  p_contribution_id uuid,
  p_amount_minor bigint,
  p_currency text,
  p_provider_reference text,
  p_provider_payment_reference text
) returns boolean
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  c public.contributions;
  recorded boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into c from public.contributions where id = p_contribution_id for update;
  if not found then raise exception 'Payment record not found.'; end if;
  if c.payment_status = 'pending' or c.payment_status = 'paid' then
    return public.record_verified_payment('daraja', p_provider_event_id, c.id, p_amount_minor,
      p_currency, p_provider_reference, null, null, p_provider_payment_reference);
  end if;
  if c.payment_status <> 'cancelled' or c.provider_name is distinct from 'daraja'
      or c.verified_provider_payment or c.provider_reference is null
      or c.provider_reference is distinct from p_provider_reference
      or (c.payment_environment = 'live' and (c.daraja_merchant_request_id is null or c.daraja_shortcode is null))
      or c.created_at < now() - interval '30 days'
      or exists (select 1 from public.payment_events e where e.contribution_id = c.id) then
    raise exception 'This payment is not eligible for verified recovery.';
  end if;
  update public.contributions set payment_status = 'pending' where id = c.id;
  recorded := public.record_verified_payment('daraja', p_provider_event_id, c.id, p_amount_minor,
    p_currency, p_provider_reference, null, null, p_provider_payment_reference);
  if not coalesce(recorded, false) then
    raise exception 'Verified recovery could not settle this payment.';
  end if;
  return true;
end $$;

revoke all on function public.recover_verified_daraja_payment(text, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.recover_verified_daraja_payment(text, uuid, bigint, text, text, text) to service_role;
