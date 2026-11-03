-- Appended inside the real-policy rollback fixture by manual-payout-workspace.mjs.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
create temporary table mw_before as
  select (select count(*) from public.manual_payout_requests) requests,
    (select count(*) from public.manual_payout_claims) claims,
    (select jsonb_agg(to_jsonb(p)) from public.manual_payout_operating_policies p) policies,
    (select jsonb_agg(to_jsonb(p)) from public.b2c_policy p) automatic;
do $$ begin
  if has_table_privilege('authenticated','public.manual_payout_intents','INSERT')
    or has_table_privilege('service_role','public.manual_payout_intent_reviews','INSERT')
    or has_function_privilege('anon','public.manual_payout_submit_intent(uuid,uuid,bigint,boolean)','EXECUTE')
    or has_function_privilege('service_role','public.manual_payout_workspace()','EXECUTE') then
    raise exception 'Direct intent/workspace bypass'; end if;
end $$;
select pg_temp.actor('client');
do $$
declare k uuid:=extensions.gen_random_uuid(); i uuid;
begin
  i:=public.manual_payout_submit_intent(k,(select id from mr_ids where key='wedding'),1200,true);
  if i<>public.manual_payout_submit_intent(k,(select id from mr_ids where key='wedding'),1200,true) then
    raise exception 'Intent replay changed id'; end if;
  insert into mr_ids values('intent',i);
  perform pg_temp.reject(format('select public.manual_payout_submit_intent(%L,%L,1201,true)',k,
    (select id from mr_ids where key='wedding')),'Idempotency');
  perform pg_temp.reject(format('select public.manual_payout_submit_intent(extensions.gen_random_uuid(),%L,1200,true)',
    (select id from mr_ids where key='wedding')),'already awaits');
  if (public.manual_payout_intent_history((select id from mr_ids where key='wedding'))->0->>'status')<>'pending' then
    raise exception 'Missing couple pending history'; end if;
end $$;
set local role authenticated;
select pg_temp.reject('select public.manual_payout_workspace()','Staff access required');
select pg_temp.reject(format('select public.manual_payout_review_intent(%L,''declined'',null,null,null,null,false,true)',
  (select id from mr_ids where key='intent')),'Staff access required');
select pg_temp.actor('admin');
select pg_temp.reject('select public.manual_payout_workspace()','SuperAdmin');
select pg_temp.reject(format('select public.manual_payout_submit_intent(extensions.gen_random_uuid(),%L,1200,true)',
  (select id from mr_ids where key='wedding')),'Access denied');
select pg_temp.reject(format('select public.manual_payout_intent_history(%L)',(select id from mr_ids where key='wedding')),'Access denied');
reset role;
select pg_temp.actor('owner');
do $$ begin
  if (select count(*) from public.manual_payout_requests)<>(select requests from mw_before)
    or (select count(*) from public.manual_payout_claims)<>(select claims from mw_before)
    or (select jsonb_agg(to_jsonb(p)) from public.manual_payout_operating_policies p) is distinct from (select policies from mw_before)
    or (select jsonb_agg(to_jsonb(p)) from public.b2c_policy p) is distinct from (select automatic from mw_before) then
    raise exception 'Intent changed finance/policies'; end if;
  perform pg_temp.reject(format('select public.manual_payout_review_intent(%L,''created'',extensions.gen_random_uuid(),%L,%L,100,true,true)',
    (select id from mr_ids where key='intent'),(select id from mr_ids where key='custody'),(select id from mr_ids where key='recipient')),
    'MANUAL_PAYOUT_BLOCKED');
  if exists(select 1 from public.manual_payout_intent_reviews) then raise exception 'Failed creation consumed intent'; end if;
end $$;
select pg_temp.policy('{"enabled":true}');
-- Normal staff review creates exactly one reservation, requiring another approver.
do $$
declare p uuid; k uuid:=extensions.gen_random_uuid(); i uuid:=(select id from mr_ids where key='intent');
begin
  perform pg_temp.actor('maker');
  p:=public.manual_payout_review_intent(i,'created',k,(select id from mr_ids where key='custody'),
    (select id from mr_ids where key='recipient'),100,false,true);
  if p<>public.manual_payout_review_intent(i,'created',k,(select id from mr_ids where key='custody'),
    (select id from mr_ids where key='recipient'),100,false,true) then raise exception 'Staff replay duplicated'; end if;
  perform pg_temp.reject(format('select public.manual_payout_review_intent(%L,''created'',extensions.gen_random_uuid(),%L,%L,100,false,true)',
    i,(select id from mr_ids where key='custody'),(select id from mr_ids where key='recipient')),'replay changed');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''approved'')',p),'different leader');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('maker'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  perform pg_temp.finish(p,false);
  if public.manual_payout_state(p)<>'paid' then raise exception 'Intent-backed normal payout not paid'; end if;
  insert into mr_ids values('intent_payout',p);
end $$;
-- Another intent may be declined OFF, without a reservation.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
do $$
declare i uuid; before_count bigint:=(select count(*) from public.manual_payout_requests);
begin
  perform pg_temp.actor('client');
  i:=public.manual_payout_submit_intent(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),1500,true);
  perform pg_temp.actor('owner');
  perform public.manual_payout_review_intent(i,'declined',null,null,null,null,false,true);
  perform public.manual_payout_review_intent(i,'declined',null,null,null,null,false,true);
  if (select count(*) from public.manual_payout_requests)<>before_count then raise exception 'Decline reserved funds'; end if;
end $$;
-- Explicit Owner solo also starts with couple review, retains separate evidence.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":true}');
do $$
declare i uuid; p uuid; ws jsonb; h jsonb;
begin
  perform pg_temp.actor('client');
  i:=public.manual_payout_submit_intent(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),1500,true);
  perform pg_temp.actor('owner');
  p:=public.manual_payout_review_intent(i,'created',extensions.gen_random_uuid(),(select id from mr_ids where key='custody'),
    (select id from mr_ids where key='recipient'),100,true,true);
  perform public.manual_payout_transition(p,'approved');
  perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  perform pg_temp.policy('{"enabled":false}');
  perform pg_temp.finish(p,true);
  ws:=public.manual_payout_workspace();
  if jsonb_array_length(ws->'intents')<>3 or jsonb_array_length(ws->'accounts')=0
    or jsonb_array_length(ws->'evidence')=0 or not exists(select 1 from jsonb_array_elements(ws->'requests') r
      where r->>'id'=p::text and r->'claim'->>'channel'='manual_external'
        and r->'receipt' is not null and r->'reconciliation' is not null) then
    raise exception 'Workspace does not support follow-up references'; end if;
  if ws::text ~ 'kyc_snapshot_hash|partner1_|partner2_|nationality|phone|email|external_reference|sha256' then
    raise exception 'Workspace leaked sensitive/internal evidence metadata'; end if;
  perform pg_temp.actor('client');
  h:=public.manual_payout_intent_history((select id from mr_ids where key='wedding'));
  if jsonb_array_length(h)<>3 or h::text ~ 'actor_id|requested_by|evidence|custody|account|recipient|sender_id' then
    raise exception 'Couple history private staff data leak'; end if;
  if public.live_payouts_enabled() then raise exception 'Automatic gate changed'; end if;
end $$;
