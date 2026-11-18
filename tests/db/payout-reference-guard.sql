-- Disposable-database test; everything is rolled back. Foreign keys and
-- immutability triggers are bypassed with replica mode, while the reference
-- guards are forced to run, to exercise only the reciprocal duplicate checks.
begin;
set local session_replication_role=replica;
alter table public.simple_payout_receipts enable always trigger facilitator_reference_receipt_guard;
alter table public.manual_payout_receipts enable always trigger facilitator_reference_receipt_guard;
alter table public.facilitator_manual_receipts enable always trigger facilitator_manual_reference_guard;
alter table public.b2c_callback_events enable always trigger facilitator_b2c_reference_incident;

do $$
declare u uuid:=extensions.gen_random_uuid(); failed boolean;
begin
  insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
    values(extensions.gen_random_uuid(),'daraja','REFGUARD1',u);

  failed:=false;
  begin
    insert into public.simple_payout_receipts(payout_id,provider,transaction_reference,reported_by)
      values(extensions.gen_random_uuid(),'daraja','REFGUARD1',u);
  exception when others then failed:=sqlerrm like 'PAYOUT_REFERENCE:%'; end;
  if not failed then raise exception 'simple receipt reused a facilitator reference'; end if;

  failed:=false;
  begin
    insert into public.manual_payout_receipts(payout_id,provider,account_reference,transaction_reference,
      actual_minor,actual_fee_minor,currency,transferred_at,evidence_id)
      values(extensions.gen_random_uuid(),'daraja',extensions.gen_random_uuid(),'REFGUARD1',1,0,'KES',now(),
        extensions.gen_random_uuid());
  exception when others then failed:=sqlerrm like 'PAYOUT_REFERENCE:%'; end;
  if not failed then raise exception 'controlled receipt reused a facilitator reference'; end if;

  insert into public.simple_payout_receipts(payout_id,provider,transaction_reference,reported_by)
    values(extensions.gen_random_uuid(),'daraja','REFGUARD2',u);
  failed:=false;
  begin
    insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
      values(extensions.gen_random_uuid(),'daraja','REFGUARD2',u);
  exception when others then failed:=sqlerrm like 'PAYOUT_REFERENCE:%'; end;
  if not failed then raise exception 'facilitator receipt reused a simple reference'; end if;

  insert into public.manual_payout_receipts(payout_id,provider,account_reference,transaction_reference,
    actual_minor,actual_fee_minor,currency,transferred_at,evidence_id)
    values(extensions.gen_random_uuid(),'daraja',extensions.gen_random_uuid(),'REFGUARD3',1,0,'KES',now(),
      extensions.gen_random_uuid());
  failed:=false;
  begin
    insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
      values(extensions.gen_random_uuid(),'daraja','REFGUARD3',u);
  exception when others then failed:=sqlerrm like 'PAYOUT_REFERENCE:%'; end;
  if not failed then raise exception 'facilitator receipt reused a controlled reference'; end if;

  insert into public.b2c_callback_events(dispatch_id,event_key,kind,evidence)
    values(extensions.gen_random_uuid(),repeat('a',64),'result',
      '{"result_code":"0","transaction_id":"refguard4"}');
  failed:=false;
  begin
    insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
      values(extensions.gen_random_uuid(),'daraja','REFGUARD4',u);
  exception when others then failed:=sqlerrm like 'PAYOUT_REFERENCE:%'; end;
  if not failed then raise exception 'facilitator receipt reused a B2C success reference'; end if;

  -- A later B2C success observation is retained and records an incident.
  insert into public.b2c_callback_events(dispatch_id,event_key,kind,evidence)
    values(extensions.gen_random_uuid(),repeat('b',64),'result',
      '{"result_code":"0","transaction_id":"refguard1"}');
  if not exists(select 1 from public.facilitator_manual_incidents where transaction_reference='REFGUARD1')
    or not exists(select 1 from public.b2c_callback_events where event_key=repeat('b',64)) then
    raise exception 'B2C success did not retain observation and incident';
  end if;
  -- Unrelated references and failed results do not create incidents.
  insert into public.b2c_callback_events(dispatch_id,event_key,kind,evidence)
    values(extensions.gen_random_uuid(),repeat('c',64),'result',
      '{"result_code":"1","transaction_id":"REFGUARD1"}');
  if (select count(*) from public.facilitator_manual_incidents where transaction_reference like 'REFGUARD%')<>1 then
    raise exception 'Unexpected incident count';
  end if;
  insert into public.simple_payout_receipts(payout_id,provider,transaction_reference,reported_by)
    values(extensions.gen_random_uuid(),'daraja','REFGUARD5',u);
end $$;
rollback;
