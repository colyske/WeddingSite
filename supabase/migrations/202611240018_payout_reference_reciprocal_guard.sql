-- Reciprocal duplicate-reference protection across the existing manual
-- facilitator, simple/couple and controlled/B2C receipt rails. Earlier rails
-- only knew about each other; the facilitator model checked them one way.
-- Receipt writers reject a reference already used on another rail. A matching
-- provider success callback records an incident in the same transaction. If
-- the trigger fails, that callback transaction rolls back and must be retried.
-- The incident trigger is AFTER INSERT, so b2c_event's
-- ON CONFLICT DO NOTHING replays fire nothing, and its key is derived from the
-- event so any repeat is a no-op. Incidents are immutable and the existing
-- global incident block is released only after an evidence-bound staff review;
-- the affected claim and its incident remain retained and must not be resent.
-- External funding and past sends stay operator-checked.
create function public.facilitator_reference_receipt_guard() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  perform pg_advisory_xact_lock(71110001);
  if exists(select 1 from public.facilitator_manual_receipts
      where provider=new.provider and transaction_reference=upper(btrim(new.transaction_reference))) then
    raise exception 'PAYOUT_REFERENCE: Transaction ID already reported on a facilitator payout; hold and investigate.';
  end if;
  return new;
end $$;
create trigger facilitator_reference_receipt_guard before insert on public.simple_payout_receipts
  for each row execute function public.facilitator_reference_receipt_guard();
create trigger facilitator_reference_receipt_guard before insert on public.manual_payout_receipts
  for each row execute function public.facilitator_reference_receipt_guard();

create function public.facilitator_manual_reference_guard() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  perform pg_advisory_xact_lock(71110001);
  if exists(select 1 from public.simple_payout_receipts
      where provider=new.provider and transaction_reference=new.transaction_reference)
    or exists(select 1 from public.manual_payout_receipts
      where provider=new.provider and transaction_reference=new.transaction_reference)
    or (new.provider='daraja' and exists(select 1 from public.b2c_callback_events
      where kind='result' and evidence->>'result_code'='0'
        and upper(evidence->>'transaction_id')=new.transaction_reference)) then
    raise exception 'PAYOUT_REFERENCE: Transaction ID already used on another payout path; hold and investigate.';
  end if;
  return new;
end $$;
create trigger facilitator_manual_reference_guard before insert on public.facilitator_manual_receipts
  for each row execute function public.facilitator_manual_reference_guard();

create function public.facilitator_b2c_reference_incident() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare receipt public.facilitator_manual_receipts;
begin
  if new.kind<>'result' or new.evidence->>'result_code' is distinct from '0'
    or new.evidence->>'transaction_id' is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(71110001);
  select * into receipt from public.facilitator_manual_receipts
    where provider='daraja' and transaction_reference=upper(new.evidence->>'transaction_id');
  if found then
    insert into public.facilitator_manual_incidents(request_id,action_key,transaction_reference,actor_id)
      values(receipt.request_id,md5(new.dispatch_id::text||new.event_key)::uuid,receipt.transaction_reference,receipt.reported_by)
      on conflict do nothing;
  end if;
  return new;
end $$;
create trigger facilitator_b2c_reference_incident after insert on public.b2c_callback_events
  for each row execute function public.facilitator_b2c_reference_incident();

revoke all on function public.facilitator_reference_receipt_guard(),
  public.facilitator_manual_reference_guard(),public.facilitator_b2c_reference_incident()
  from public,anon,authenticated,service_role;
