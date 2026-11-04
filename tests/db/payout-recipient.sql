-- Synthetic fixtures only, inside the readiness/withdrawal test transaction.
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
alter table public.contributions disable trigger guard_paystack_context;
do $$ declare w uuid; p uuid; p2 uuid; h text; k uuid:=extensions.gen_random_uuid(); before_balance bigint; detail jsonb;
begin
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":0,"min_payout_minor":1000,"max_payout_minor":10000}');
  w:=pg_temp.withdrawal_wedding(10000);
  h:=public.simple_payout_kyc_hash(w);
  perform pg_temp.actor('client');
  p:=public.simple_payout_submit(k,w,1000,1,true,0,
    (select withdrawal_policy_revision from public.platform_policies where id=true),h);
  detail:=public.simple_payout_recipient(p);
  if detail->>'expected_name'<>'Fixture One' or detail->>'phone'<>'254700000001'
    or detail->>'source'<>'request_snapshot' then raise exception 'Missing immutable recipient snapshot'; end if;
  if public.simple_payout_status(w)->'requests'->0->'recipient' is distinct from detail then
    raise exception 'Authorized couple missing recipient'; end if;
  perform pg_temp.actor('owner');
  perform public.simple_payout_action(p,extensions.gen_random_uuid(),'processing',null,null,null,true,true,true);
  before_balance:=public.simple_payout_available(w);
  update public.wedding_kyc set partner1_phone='254711111111',partner1_legal_name='Edited Fixture' where wedding_id=w;
  if public.simple_payout_recipient(p) is distinct from detail
    or public.simple_payout_status(w)->'requests'->0->'recipient' is distinct from detail then
    raise exception 'Edited KYC silently replaced original claim destination'; end if;
  perform pg_temp.actor('client');
  -- Ambiguous-submit retry still resolves the same request after KYC changes.
  if public.simple_payout_submit(k,w,1000,1,true,0,
    (select withdrawal_policy_revision from public.platform_policies where id=true),h)<>p then raise exception 'Retry changed request'; end if;
  perform pg_temp.reject(format('select public.simple_payout_submit(extensions.gen_random_uuid(),%L,1000,1,true,0,%s,%L)',
    w,(select withdrawal_policy_revision from public.platform_policies where id=true),h),'Recipient changed');
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''paid'',null,null,''NO-NAME-CHECK'',false,false,true)',p),
    'Explicitly confirm the actual transaction recipient');
  k:=extensions.gen_random_uuid();
  perform public.simple_payout_action(p,k,'paid',null,null,'SNAPSHOT-MATCH',false,true,true);
  perform public.simple_payout_action(p,k,'paid',null,null,'SNAPSHOT-MATCH',false,true,true);
  if public.simple_payout_state(p)<>'paid' or public.simple_payout_available(w)<>before_balance then
    raise exception 'Matching actual-name confirmation changed accounting or replay'; end if;
  perform pg_temp.actor('client');
  p2:=public.simple_payout_submit(extensions.gen_random_uuid(),w,1000,1,true,0,
    (select withdrawal_policy_revision from public.platform_policies where id=true),public.simple_payout_kyc_hash(w));
  perform pg_temp.actor('owner');
  perform public.simple_payout_action(p2,extensions.gen_random_uuid(),'processing',null,null,null,true,true,true);
  before_balance:=public.simple_payout_available(w);
  k:=extensions.gen_random_uuid();
  perform public.simple_payout_action(p2,k,'hold','outcome_uncertain',null,null,false,false,true);
  perform public.simple_payout_action(p2,k,'hold','outcome_uncertain',null,null,false,false,true);
  -- A generic later Hold cannot clear the durable uncertain-outcome latch.
  perform public.simple_payout_action(p2,extensions.gen_random_uuid(),'hold','recipient_check',null,null,false,false,true);
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''paid'',null,null,''MISMATCH-ATTEMPT'',false,true,true)',p2),
    'Uncertain recipient/outcome remains on Hold');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''cancelled'',null,null,null,false,false,true)',p2),
    'Processing has already been claimed');
  if public.simple_payout_state(p2)<>'hold' or public.simple_payout_available(w)<>before_balance
    or not exists(select 1 from public.simple_payout_claims where payout_id=p2)
    or exists(select 1 from public.simple_payout_receipts where payout_id=p2)
    or not (public.simple_payout_status(w)->'requests'->0->>'recipient_outcome_held')::boolean then
    raise exception 'Mismatch released reservation/claim, created a receipt or lost reload Hold'; end if;
  perform pg_temp.reject(format('update public.simple_payout_recipients set expected_name=''Other'' where payout_id=%L',p),'append-only');
  insert into mr_ids values('private_recipient_wedding',w),('private_recipient_payout',p);
end $$;
set local role authenticated;
select pg_temp.actor('owner');
select pg_temp.reject('select * from public.simple_payout_recipients','permission denied');
select pg_temp.reject('select public.simple_payout_recipient((select id from mr_ids where key=''private_recipient_payout''))','permission denied');
select pg_temp.actor('client');
select pg_temp.reject('select public.simple_payout_submit(extensions.gen_random_uuid(),(select id from mr_ids where key=''private_recipient_wedding''),1000,1,true)','permission denied');
select pg_temp.reject('select public.simple_payout_submit(extensions.gen_random_uuid(),(select id from mr_ids where key=''private_recipient_wedding''),1000,1,true,0,0)','permission denied');
select pg_temp.reject('select public.simple_payout_submit(extensions.gen_random_uuid(),(select id from mr_ids where key=''private_recipient_wedding''),1000,1,true,0,0,null)','Recipient changed');
select pg_temp.actor('admin');
select pg_temp.reject('select public.simple_payout_status((select id from mr_ids where key=''private_recipient_wedding''))','Wedding access required');
select pg_temp.reject('select public.simple_payout_workspace()','SuperAdmin');
select pg_temp.actor('maker');
do $$ begin
  if public.simple_payout_status((select id from mr_ids where key='private_recipient_wedding'))->'requests'->0->'recipient'->>'phone'<>'254711111111' then
    raise exception 'Authorized operator missing full destination'; end if;
end $$;
select pg_temp.actor('checker');
select pg_temp.reject('select public.simple_payout_action((select id from mr_ids where key=''private_recipient_payout''),extensions.gen_random_uuid(),''paid'',null,null,''WRONG-SENDER'',false,true,true)','Terminal record');
reset role;
select pg_temp.actor('admin');
do $$ declare other uuid:=extensions.gen_random_uuid(); begin
  insert into auth.users(id,email,email_confirmed_at) values(other,other::text||'@example.test',now());
  perform set_config('request.jwt.claim.sub',other::text,true);
end $$;
set local role authenticated;
select pg_temp.reject('select public.simple_payout_status((select id from mr_ids where key=''private_recipient_wedding''))','Wedding access required');
reset role;
set local role anon;
select pg_temp.reject('select public.simple_payout_status(null)','permission denied');
select pg_temp.reject('select public.simple_payout_workspace()','permission denied');
reset role;
alter table public.contributions enable trigger guard_payment_environment;
alter table public.contributions enable trigger guard_live_payment_context;
alter table public.contributions enable trigger guard_paystack_context;
