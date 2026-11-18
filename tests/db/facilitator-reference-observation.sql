-- Appended to the rolled-back readiness fixture on a fully migrated disposable DB.
savepoint facilitator_simple_collision;
do $$
declare p uuid; sender uuid; k uuid:=extensions.gen_random_uuid(); result jsonb;
begin
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":0,"min_payout_minor":1000,"max_payout_minor":10000}');
  perform pg_temp.actor('client');
  p:=public.simple_payout_submit(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),1000,1,true,0,
    (select withdrawal_policy_revision from public.platform_policies where id=true),
    public.simple_payout_kyc_hash((select id from mr_ids where key='wedding')));
  perform pg_temp.actor('owner');
  perform public.simple_payout_action(p,extensions.gen_random_uuid(),'processing',null,null,null,true,true,true);
  sender:=(select id from mr_ids where key='owner');
  perform set_config('session_replication_role','replica',true);
  insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
    values(extensions.gen_random_uuid(),'daraja','FAC-SIMPLE-CONFLICT',sender);
  perform set_config('session_replication_role','origin',true);
  perform pg_temp.actor('admin');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,%L,''paid'',null,null,''fac-simple-conflict'',false,true,true)',p,k),
    'Leadership access required');
  perform pg_temp.actor('owner');
  result:=public.simple_payout_action(p,k,'paid',null,null,'fac-simple-conflict',false,true,true);
  if result->>'state'<>'hold' or result->>'conflict'<>'true'
    or public.simple_payout_state(p)<>'hold'
    or not exists(select 1 from public.simple_payout_claims where payout_id=p)
    or not exists(select 1 from public.simple_payout_incidents where payout_id=p
      and transaction_reference='FAC-SIMPLE-CONFLICT' and actor_id=sender)
    or exists(select 1 from public.simple_payout_receipts where payout_id=p) then
    raise exception 'Simple conflict lost observation, claim, or no-resend hold';
  end if;
  result:=public.simple_payout_action(p,k,'paid',null,null,'fac-simple-conflict',false,true,true);
  if result->>'replayed'<>'true' or result->>'conflict'<>'true'
    or (select count(*) from public.simple_payout_incidents where payout_id=p)<>1 then
    raise exception 'Simple conflict replay was not idempotent';
  end if;
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''cancelled'',null,null,null,false,false,true)',p),'already been claimed');
end $$;
rollback to facilitator_simple_collision;

savepoint facilitator_controlled_collision;
do $$
declare p uuid; e uuid; sender uuid; at_report timestamptz;
begin
  perform pg_temp.actor('owner');
  p:=pg_temp.request(extensions.gen_random_uuid(),true,1000,100);
  perform public.manual_payout_transition(p,'approved');
  perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  e:=pg_temp.evidence('receipt',true);
  sender:=(select id from mr_ids where key='owner');
  at_report:=clock_timestamp();
  perform set_config('session_replication_role','replica',true);
  insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
    values(extensions.gen_random_uuid(),'daraja','FAC-MANUAL-CONFLICT',sender);
  perform set_config('session_replication_role','origin',true);
  perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select public.manual_payout_report(%L,''fac-manual-conflict'',1000,100,''KES'',%L,%L)',
    p,at_report,e),'Protected Owner');
  perform pg_temp.actor('owner');
  if public.manual_payout_report(p,'fac-manual-conflict',1000,100,'KES',at_report,e)
    or public.manual_payout_report(p,'fac-manual-conflict',1000,100,'KES',at_report,e) then
    raise exception 'Controlled conflict was accepted';
  end if;
  if public.manual_payout_state(p)<>'executing'
    or not exists(select 1 from public.manual_payout_claims where payout_id=p)
    or (select count(*) from public.manual_payout_account_holds where payout_id=p
      and evidence_id=e and transaction_reference='FAC-MANUAL-CONFLICT'
      and actual_minor=1000 and actual_fee_minor=100 and currency='KES' and observed_at=at_report)<>1
    or exists(select 1 from public.manual_payout_receipts where payout_id=p) then
    raise exception 'Controlled conflict lost observed evidence or retained claim';
  end if;
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid manual payout transition');
end $$;
rollback to facilitator_controlled_collision;
