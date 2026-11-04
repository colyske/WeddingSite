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
do $$ declare p uuid; p2 uuid; v_key uuid:=extensions.gen_random_uuid(); ref text; result jsonb; before_balance bigint;
begin
  before_balance:=public.simple_payout_available((select id from mr_ids where key='wedding'));
  if before_balance<>15800 then raise exception 'Wrong verified net/prior commitment baseline: %',before_balance; end if;
  perform pg_temp.actor('client');
  p:=public.simple_payout_submit(v_key,(select id from mr_ids where key='wedding'),1000,1,true);
  if p is distinct from public.simple_payout_submit(v_key,(select id from mr_ids where key='wedding'),1000,1,true) then raise exception 'Request replay duplicated'; end if;
  perform pg_temp.reject(format('select public.simple_payout_submit(%L,%L,1001,1,true)',v_key,
    (select id from mr_ids where key='wedding')),'retry changed');
  if public.simple_payout_available((select id from mr_ids where key='wedding'))<>before_balance-1000 then raise exception 'Request did not reserve exactly'; end if;
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''paid'',extensions.gen_random_uuid(),''NO-CLAIM'')',p),'claimed operator');
  perform pg_temp.simple_action(p,'hold');
  if public.simple_payout_state(p)<>'hold' then raise exception 'Hold lost'; end if;
  v_key:=extensions.gen_random_uuid();
  perform pg_temp.simple_action(p,'processing',v_key,null,true,100);
  perform pg_temp.simple_action(p,'processing',v_key,null,true,100);
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''processing'',%L,null,true,101)',p,v_key),'retry changed');
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
  v_key:=extensions.gen_random_uuid(); perform pg_temp.simple_action(p2,'paid',v_key,p2::text);
  perform pg_temp.simple_action(p2,'paid',v_key,p2::text);
  insert into mr_ids values('simple_paid',p),('simple_normal',p2);
end $$;
-- Own obligations reduce availability; other weddings and test/direct funds do not add it.
select pg_temp.reject(format('insert into public.expenses(wedding_id,category,description,amount_minor,currency,status)
  values(%L,''Fixture'',''Cannot spend payout reservations'',14000,''KES'',''approved'')',
  (select id from mr_ids where key='wedding')),'already reserved');
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
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":true,"daily_minor":20000}');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,7000,100,''KES'',true)',
    (select id from mr_ids where key='wedding'),(select id from mr_ids where key='custody'),
    (select id from mr_ids where key='recipient')),'already committed');
end $$;
rollback to simple_crosspath;
savepoint simple_refund_after_claim;
do $$ declare p uuid:=pg_temp.simple_request(); a uuid:=extensions.gen_random_uuid(); b uuid:=extensions.gen_random_uuid();
  w uuid:=(select id from mr_ids where key='wedding'); c uuid:=(select id from mr_ids where key='contribution');
  available bigint; v_key uuid:=extensions.gen_random_uuid(); begin
  perform pg_temp.actor('owner');
  perform pg_temp.simple_action(p,'processing',extensions.gen_random_uuid(),null,true,100);
  available:=public.simple_payout_available(w);
  insert into public.payment_adjustments(id,provider,adjustment_kind,provider_adjustment_id,
    contribution_id,wedding_id,amount_minor,currency,status,hold_minor)
    values(a,'paystack','refund',a::text,c,w,100,'KES','pending',100);
  set constraints simple_payout_guard_adjustment immediate;
  if public.simple_payout_available(w)<>available-100 then raise exception 'Valid unreserved refund blocked or miscounted'; end if;
  set constraints simple_payout_guard_adjustment deferred;
  -- Processing an already reserved refund must replace its hold, not double debit.
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,couple_net_delta_minor,
    currency,allocation,provider,provider_adjustment_id)
    values(a,w,c,'refund',-100,'KES','couple','paystack',a::text);
  update public.payment_adjustments set status='processed',hold_minor=0 where id=a;
  set constraints simple_payout_guard_adjustment immediate;
  if public.simple_payout_available(w)<>available-100 then raise exception 'Hold to ledger refund double counted'; end if;
  set constraints simple_payout_guard_adjustment deferred;
  insert into public.payment_adjustments(id,provider,adjustment_kind,provider_adjustment_id,
    contribution_id,wedding_id,amount_minor,currency,status,hold_minor)
    values(b,'paystack','refund',b::text,c,w,available,'KES','failed',0);
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,
    entry_type,couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
    values(b,w,c,'refund_reviewed',-available,'KES','couple','paystack',b::text);
  set constraints simple_payout_guard_adjustment immediate;
  if not exists(select 1 from public.financial_adjustment_ledger where adjustment_id=b)
    or not exists(select 1 from public.simple_payout_deficits where wedding_id=w and deficit_minor=100)
    or public.simple_payout_available(w)<>0 then raise exception 'Actual refund/deficit accounting lost'; end if;
  if not exists(select 1 from public.simple_payout_claims where payout_id=p)
    or public.simple_payout_state(p)<>'hold'
    or not exists(select 1 from public.simple_payout_events where payout_id=p and state='hold' and system_event and actor_id is null)
    then raise exception 'Refund failed to retain and hold claimed payout'; end if;
  perform pg_temp.reject('select pg_temp.simple_request()','recorded adjustment deficit');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''cancelled'')',p),'already been claimed');
  perform pg_temp.simple_action(p,'paid',v_key,p::text);
  perform pg_temp.simple_action(p,'paid',v_key,p::text);
  if public.simple_payout_state(p)<>'paid' or not exists(select 1 from public.simple_payout_deficits where wedding_id=w) then
    raise exception 'Actual Paid replay erased deficit or failed'; end if;
end $$;
rollback to simple_refund_after_claim;
savepoint simple_adjustment_hold_after_claim;
do $$ declare p uuid:=pg_temp.simple_request(); a uuid:=extensions.gen_random_uuid();
  w uuid:=(select id from mr_ids where key='wedding'); c uuid:=(select id from mr_ids where key='contribution'); available bigint;
begin
  perform pg_temp.actor('owner'); perform pg_temp.simple_action(p,'processing',extensions.gen_random_uuid(),null,true,100);
  available:=public.simple_payout_available(w);
  insert into public.payment_adjustments(id,provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values(a,'paystack','dispute',a::text,c,w,100,'KES','open',100);
  set constraints simple_payout_guard_adjustment immediate;
  update public.payment_adjustments set hold_minor=available+1,amount_minor=available+1 where id=a;
  if public.simple_payout_state(p)<>'hold'
    or not exists(select 1 from public.payment_adjustments where id=a and hold_minor=available+1)
    or not exists(select 1 from public.simple_payout_deficits where wedding_id=w and deficit_minor=1) then
    raise exception 'Actual adjustment update did not persist deficit/hold'; end if;
end $$;
rollback to simple_adjustment_hold_after_claim;
savepoint simple_old_receipt;
do $$ declare p uuid:=pg_temp.simple_request(); reference text; v_key uuid:=extensions.gen_random_uuid(); begin
  perform pg_temp.actor('owner');
  perform pg_temp.simple_action(p,'processing',extensions.gen_random_uuid(),null,true,0);
  select transaction_reference into strict reference from public.manual_payout_receipts
    where payout_id=(select id from mr_ids where key='normal');
  if not (pg_temp.simple_action(p,'paid',v_key,reference)->>'conflict')::boolean then
    raise exception 'Old receipt reused on simple path'; end if;
  if not (pg_temp.simple_action(p,'paid',v_key,reference)->>'conflict')::boolean then
    raise exception 'Duplicate incident retry was not idempotent'; end if;
  if public.simple_payout_state(p)<>'hold'
    or not exists(select 1 from public.simple_payout_claims where payout_id=p)
    or exists(select 1 from public.simple_payout_receipts where payout_id=p) then
    raise exception 'Duplicate ID lost claim/reservation or marked Paid'; end if;
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''cancelled'')',p),'already been claimed');
  perform pg_temp.reject(format('select pg_temp.simple_action(%L,''paid'',extensions.gen_random_uuid(),''REPLACEMENT-ID'')',p),'conflicting outcome already holds');
end $$;
rollback to simple_old_receipt;
savepoint simple_preserve_paid;
insert into public.expenses(wedding_id,category,description,amount_minor,currency,status)
  values((select id from mr_ids where key='wedding'),'Fixture','Immutable paid history',100,'KES','paid');
select pg_temp.reject('update public.expenses set amount_minor=0 where description=''Immutable paid history''','cannot be rewritten');
rollback to simple_preserve_paid;
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
-- Existing incident blocks a fresh claim, while unclaimed cancellation stays safe.
do $$ declare p uuid:=pg_temp.simple_request(); begin
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
