-- Appended inside readiness's synthetic transaction; never linked/Production.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
create function pg_temp.simple_request(amount bigint default 1000) returns uuid language plpgsql as $$
begin
  perform pg_temp.actor('client');
  return public.simple_payout_submit(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),amount,1,true);
end $$;
create function pg_temp.simple_action(p uuid,a text,k uuid default extensions.gen_random_uuid(),reference text default null,
  solo boolean default false,fee bigint default null) returns jsonb language sql as $$
  select public.simple_payout_action(p,k,a,case when a='hold' then 'other_review' else null end,fee,reference,solo,
    a in ('reviewed','processing'),true)
$$;
do $$ declare p uuid; p2 uuid; key uuid:=extensions.gen_random_uuid(); ref text; result jsonb; before_balance bigint;
begin
  before_balance:=public.simple_payout_available((select id from mr_ids where key='wedding'));
  if before_balance<>15800 then raise exception 'Wrong verified net/prior commitment baseline: %',before_balance; end if;
  perform pg_temp.actor('client');
  p:=public.simple_payout_submit(key,(select id from mr_ids where key='wedding'),1000,1,true);
  if p is distinct from public.simple_payout_submit(key,(select id from mr_ids where key='wedding'),1000,1,true) then raise exception 'Request replay duplicated'; end if;
  perform pg_temp.reject(format('select public.simple_payout_submit(%L,%L,1001,1,true)',key,
    (select id from mr_ids where key='wedding')),'retry changed');
  if public.simple_payout_available((select id from mr_ids where key='wedding'))<>before_balance-1000 then raise exception 'Request did not reserve exactly'; end if;
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''paid'',extensions.gen_random_uuid(),''NO-CLAIM'')',p),'claimed operator');
  perform pg_temp.simple_action(p,'hold');
  if public.simple_payout_state(p)<>'hold' then raise exception 'Hold lost'; end if;
  key:=extensions.gen_random_uuid();
  perform pg_temp.simple_action(p,'processing',key,null,true,100);
  perform pg_temp.simple_action(p,'processing',key,null,true,100);
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',%L,null,true,101)',p,key),'retry changed');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''cancelled'')',p),'already been claimed');
  perform pg_temp.simple_action(p,'hold');
  ref:=p::text;
  result:=pg_temp.simple_action(p,'paid',extensions.gen_random_uuid(),ref);
  if public.simple_payout_state(p)<>'paid' or not (result->>'operator_reported')::boolean
    or exists(select 1 from public.manual_payout_reconciliations where payout_id=p) then raise exception 'Wrong paid semantics'; end if;
  -- The second operator must differ from the genuine checker.
  p2:=pg_temp.simple_request();
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',extensions.gen_random_uuid(),null,false,0)',p2),'Another eligible leader');
  perform pg_temp.simple_action(p2,'reviewed');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',extensions.gen_random_uuid(),null,false,0)',p2),'Another eligible leader');
  perform pg_temp.actor('checker'); perform pg_temp.simple_action(p2,'processing',extensions.gen_random_uuid(),null,false,0);
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''paid'',extensions.gen_random_uuid(),''OTHER-SENDER'')',p2),'claimed operator');
  perform pg_temp.actor('checker');
  key:=extensions.gen_random_uuid(); perform pg_temp.simple_action(p2,'paid',key,p2::text);
  perform pg_temp.simple_action(p2,'paid',key,p2::text);
  insert into mr_ids values('simple_paid',p),('simple_normal',p2);
end $$;
-- Own obligations reduce availability; other weddings and test/direct funds do not add it.
savepoint simple_obligations;
insert into public.expenses(wedding_id,category,description,amount_minor,currency,status)
  values((select id from mr_ids where key='wedding'),'Fixture','Known unpaid expense',13000,'KES','approved');
select pg_temp.reject('select pg_temp.simple_request()','exceeds available');
rollback to simple_obligations;
savepoint simple_unknown_fee;
update public.contributions set provider_fee_pending=true where id=(select id from mr_ids where key='contribution');
select pg_temp.reject('select pg_temp.simple_request()','exceeds available');
rollback to simple_unknown_fee;
savepoint simple_kyc_revision;
do $$ declare p uuid:=pg_temp.simple_request(); begin
  update public.wedding_kyc set updated_at=clock_timestamp() where wedding_id=(select id from mr_ids where key='wedding');
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',extensions.gen_random_uuid(),null,true,0)',p),'unchanged recipient');
  perform pg_temp.simple_action(p,'cancelled');
end $$;
rollback to simple_kyc_revision;
-- New reservations cannot be spent by existing manual/automatic request wrappers.
savepoint simple_crosspath;
do $$ declare p uuid:=pg_temp.simple_request(9000); begin
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":true}');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,7000,100,''KES'',true)',
    (select id from mr_ids where key='wedding'),(select id from mr_ids where key='custody'),
    (select id from mr_ids where key='recipient')),'already committed');
end $$;
rollback to simple_crosspath;
-- Simple receipt -> old manual report must commit the same retained incident.
do $$ declare p uuid; e uuid; begin
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":true}');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),
    (select id from mr_ids where key='custody'),(select id from mr_ids where key='recipient'),1000,100,'KES',true);
  perform public.manual_payout_transition(p,'approved'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  e:=pg_temp.evidence('receipt',true);
  if public.manual_payout_report(p,(select id::text from mr_ids where key='simple_paid'),1000,100,'KES',clock_timestamp(),e) then
    raise exception 'Cross-path transaction ID reused'; end if;
  if not exists(select 1 from public.manual_payout_account_holds where payout_id=p) then raise exception 'Cross-path incident rolled back'; end if;
  perform pg_temp.policy('{"enabled":false}');
end $$;
-- Old receipt -> new Paid is held, not fabricated as reconciled or released.
do $$ declare p uuid:=pg_temp.simple_request(); key uuid:=extensions.gen_random_uuid(); reference text; begin
  perform pg_temp.actor('owner');
  -- Rollback only this synthetic legacy incident so we can obtain a fresh claim.
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',extensions.gen_random_uuid(),null,true,0)',p),'Conflicting transaction IDs');
  perform pg_temp.simple_action(p,'cancelled');
end $$;
set local role authenticated;
select pg_temp.actor('admin');
select pg_temp.reject('select public.simple_payout_workspace()','SuperAdmin');
select pg_temp.reject(format('select pg_temp.simple_action(%L,''hold'')',(select id from mr_ids where key='simple_paid')),'Leadership access');
select pg_temp.actor('client');
select pg_temp.reject('select public.simple_payout_workspace()','Staff access required');
select pg_temp.reject(format('select pg_temp.simple_action(%L,''hold'')',(select id from mr_ids where key='simple_normal')),'Leadership access');
select pg_temp.reject('select * from public.simple_payout_claims','permission denied');
reset role;
do $$ begin
  if public.live_payouts_enabled() or public.manual_payouts_enabled()
    or exists((select to_jsonb(b) from public.b2c_policy b) except (select value from mr_automatic_before)) then
    raise exception 'Offline reporting activated or modified an old gate'; end if;
end $$;
