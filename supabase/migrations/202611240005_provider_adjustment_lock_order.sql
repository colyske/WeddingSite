-- Acquire the existing accounting lock before the adjustment writer locks any
-- source row. Provider retry remains necessary if the transaction fails.
alter function public.record_provider_adjustment(
  text,text,text,text,text,bigint,text,text,timestamptz
) rename to record_provider_adjustment_locked_body;

revoke all on function public.record_provider_adjustment_locked_body(
  text,text,text,text,text,bigint,text,text,timestamptz
) from public,anon,authenticated,service_role;

create function public.record_provider_adjustment(
  p_provider text, p_provider_event_id text, p_event_type text,
  p_adjustment_id text, p_payment_reference text, p_amount_minor bigint,
  p_currency text, p_state text, p_occurred_at timestamptz
) returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  return public.record_provider_adjustment_locked_body(
    p_provider,p_provider_event_id,p_event_type,p_adjustment_id,p_payment_reference,
    p_amount_minor,p_currency,p_state,p_occurred_at);
end $$;

revoke all on function public.record_provider_adjustment(
  text,text,text,text,text,bigint,text,text,timestamptz
) from public,anon,authenticated,service_role;
grant execute on function public.record_provider_adjustment(
  text,text,text,text,text,bigint,text,text,timestamptz
) to service_role;
