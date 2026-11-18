-- Isolated local/CI fixtures only. No provider calls; all effects roll back.
begin;
create temporary table referral_actors(kind text primary key,id uuid not null);
grant select on referral_actors to authenticated,service_role;
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Referral regression: %',label; end if; end $$;
grant execute on function pg_temp.assert_true(boolean,text) to authenticated,service_role;

do $$
declare kind text; uid uuid;
begin
  foreach kind in array array['owner','superadmin','admin','creator','referrer','other','outsider'] loop
    uid:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at)
      values(uid,case when kind='owner' then 'colyske@gmail.com' else kind||'@example.test' end,now());
    insert into referral_actors values(kind,uid);
    if kind='owner' then perform public.bootstrap_protected_owner(uid);
    elsif kind in ('superadmin','admin') then update public.profiles set platform_role=kind::public.platform_role where id=uid;
    end if;
  end loop;
end $$;
select pg_temp.assert_true((select not enabled and rate_basis_points=0 and first_effective_at is null from public.referral_policy),'default OFF');
select pg_temp.assert_true(public.referral_available_cap(5000,8880,2000,500,300,6000,100,400,1000)=4500,'cost/loss/commitment cap');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,0,0)=6880,'rate cannot exceed net fee reserve');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,null,0,0,100000,0,0,0)=0,'unknown cost');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,null,0,0,0)=0,'unknown platform settlement');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,null,0)=0,'unknown commitments');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,0,9000)=0,'committed commission reserve');
do $$
declare signature text; role_name text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach signature in array array['referral_reconcile_estimate(uuid)','referral_snapshot_contribution()',
      'referral_available_cap(bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint)'] loop
      perform pg_temp.assert_true(not has_function_privilege(role_name,'public.'||signature,'execute'),
        'internal function not externally executable: '||role_name||'/'||signature);
    end loop;
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare actor record; blocked boolean; table_name text; p jsonb;
begin
  for actor in select * from referral_actors loop
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    blocked:=false;
    begin p:=public.referral_admin_policy(); exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_true(blocked=(actor.kind not in ('owner','superadmin')),'policy read '||actor.kind);
    blocked:=false;
    begin perform public.referral_admin_ledger(); exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_true(blocked=(actor.kind not in ('owner','superadmin')),'ledger read '||actor.kind);
    blocked:=false;
    begin perform public.referral_admin_history(); exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_true(blocked=(actor.kind not in ('owner','superadmin')),'history read '||actor.kind);
    blocked:=false;
    begin perform public.referral_owner_policy(false,0,case when p is not null then (p->>'revision')::uuid end,true);
    exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_true(blocked=(actor.kind<>'owner'),'Owner-only write '||actor.kind);
    foreach table_name in array array['referral_policy','referral_policy_history','referral_accounts','referral_intents',
      'referral_attributions','referral_contribution_policy','referral_estimate_ledger','referral_balances'] loop
      blocked:=false;
      begin execute 'select count(*) from public.'||table_name;
      exception when insufficient_privilege then blocked:=true; end;
      perform pg_temp.assert_true(blocked,'raw table blocked '||table_name||'/'||actor.kind);
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub','',true);
  blocked:=false; begin perform public.referral_my_summary(); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'NULL actor denied');
end $$;
reset role;

create function pg_temp.create_referred(p_creator text,p_slug text,p_accept boolean) returns uuid
language plpgsql as $$
declare d jsonb; code text; wid uuid;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind=p_creator),true);
  select a.code into code from public.referral_accounts a join referral_actors x on x.id=a.user_id where x.kind='referrer';
  perform public.referral_capture(code);
  d:=public.referral_disclosure();
  wid:=public.referral_create_wedding(p_slug,'Private couple',current_date+30,'Local venue','KES',100,
    array['#244b3a'],jsonb_build_array(jsonb_build_object('name','Venue','eventDate',(current_date+30)::text,
      'eventTime','10:00','address','Local address','kind','main')),
    (d->>'intent_id')::uuid,case when p_accept then 'accept' else 'decline' end,
    (d->>'revision')::uuid,d->>'terms_version');
  return wid;
end $$;
do $$
declare i uuid; again uuid; code text; blocked boolean; p jsonb; rev uuid; wid uuid; legacy uuid; declined uuid;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  blocked:=false;
  begin perform public.referral_set_consent(true,'wrong-version'); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'terms version required');
  p:=public.referral_set_consent(true,'client-referrals-v1'); code:=p->>'code';
  blocked:=false; begin perform public.referral_capture(code); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'direct self-referral denied');
  legacy:=pg_temp.create_referred('creator','legacy-referred',true);
  perform pg_temp.assert_true((select not eligible from public.referral_attributions where wedding_id=legacy),'preactivation wedding permanently ineligible');
  insert into referral_actors values('legacy',legacy);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  p:=public.referral_admin_policy(); rev:=(p->>'revision')::uuid;
  p:=public.referral_owner_policy(true,100,rev,true);
  blocked:=false;
  begin perform public.referral_owner_policy(true,200,rev,true); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'stale Owner CAS rejected');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='creator'),true);
  blocked:=false; begin perform public.referral_capture(repeat('0',32)); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'invalid code does not capture');
  i:=public.referral_capture(code);
  again:=public.referral_capture(repeat('0',32));
  perform pg_temp.assert_true(i=again,'first valid pending capture wins');
  wid:=pg_temp.create_referred('creator','eligible-referred',true);
  insert into referral_actors values('wedding',wid);
  perform pg_temp.assert_true((select eligible from public.referral_attributions where wedding_id=wid),'new wedding eligible');
  declined:=pg_temp.create_referred('other','declined-referral',false);
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=declined),'couple decline no attribution');
  perform pg_temp.assert_true(exists(select 1 from public.referral_intents where creator_id=
    (select id from referral_actors where kind='other') and state='declined' and consumed_at is not null
    and disclosed_revision is not null and disclosed_terms_version='client-referrals-v1'),'declined disclosure receipt retained');
  blocked:=false;
  begin update public.referral_attributions set creator_id=(select id from referral_actors where kind='other') where wedding_id=wid;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'attribution immutable');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='outsider'),true);
  perform pg_temp.assert_true(jsonb_array_length(public.referral_my_summary()->'weddings')=0,'unrelated referrer sees no aggregate');
end $$;

-- A historical owner link must not be inferred from an unrelated later edit.
set constraints all immediate;
set constraints all deferred;
savepoint referral_link_unrelated_edit;
set local session_replication_role=replica;
update public.weddings set client_owner_id=(select id from referral_actors where kind='referrer')
  where id=(select id from referral_actors where kind='wedding');
set local session_replication_role=origin;
update public.weddings set couple_names='Edited fixture'
  where id=(select id from referral_actors where kind='wedding');
set constraints all immediate;
select pg_temp.assert_true(not exists(select 1 from public.referral_eligibility_events
  where wedding_id=(select id from referral_actors where kind='wedding')),
  'unrelated wedding edit does not manufacture an account link');
rollback to savepoint referral_link_unrelated_edit;
set constraints all deferred;
savepoint referral_link_real_edit;
update public.weddings set client_owner_id=(select id from referral_actors where kind='referrer')
  where id=(select id from referral_actors where kind='wedding');
set constraints all immediate;
select pg_temp.assert_true(exists(select 1 from public.referral_eligibility_events
  where wedding_id=(select id from referral_actors where kind='wedding') and reason='owner_account'),
  'actual owner change records exclusion');
rollback to savepoint referral_link_real_edit;
set constraints all deferred;

-- Verified LIVE Daraja fixtures; these do not call any provider or unlock payouts.
update public.daraja_live_approval set approved=true,shortcode='123456',
  approved_by=(select id from referral_actors where kind='owner'),approved_at=now() where singleton;
create function pg_temp.payment(p_kind text,p_live boolean,p_wedding uuid,p_currency text default 'KES') returns uuid
language plpgsql as $$
declare cid uuid;
begin
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,platform_fee_basis_points,
    provider_name,payment_environment,daraja_shortcode)
    values(p_wedding,'Private contributor stream',100000,p_currency,888,
      case when p_live then 'daraja' else 'stripe' end,case when p_live then 'live' else 'test' end,
      case when p_live then '123456' end) returning id into cid;
  if p_live then update public.contributions set provider_reference=cid::text,daraja_merchant_request_id=cid::text where id=cid; end if;
  insert into referral_actors values(p_kind,cid);
  return cid;
end $$;
do $$
declare wid uuid:=(select id from referral_actors where kind='wedding'); cid uuid; p jsonb;
begin
  cid:=pg_temp.payment('paid',true,wid);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.record_verified_payment('daraja','paid-event',cid,100000,'KES',cid::text,2000,now(),cid::text);
  cid:=pg_temp.payment('old-pending',true,wid);
  cid:=pg_temp.payment('test-money',false,wid,'USD');
  update public.contributions set payment_status='paid',verified_provider_payment=true,
    paid_amount_minor=100000,platform_fee_minor=8880,net_paid_minor=91120,
    provider_fee_minor=0,provider_fee_pending=false,funds_available_at=now()-interval '20 days' where id=cid;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  p:=public.referral_admin_policy();
  perform public.referral_owner_policy(true,200,(p->>'revision')::uuid,true);
  cid:=pg_temp.payment('new-rate',true,wid);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.record_verified_payment('daraja','new-rate-event',cid,100000,'KES',cid::text,2000,now(),cid::text);
  cid:=(select id from referral_actors where kind='old-pending');
  perform public.record_verified_payment('daraja','old-pending-event',cid,100000,'KES',cid::text,2000,now(),cid::text);
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=1000 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'original rate');
select pg_temp.assert_true((select held_estimate_minor=1000 from public.referral_balances where contribution_id=(select id from referral_actors where kind='old-pending')),'pending payment retains old rate');
select pg_temp.assert_true((select held_estimate_minor=2000 from public.referral_balances where contribution_id=(select id from referral_actors where kind='new-rate')),'new payment gets new rate');
select pg_temp.assert_true((select held_estimate_minor=0 and currency='USD' from public.referral_balances where contribution_id=(select id from referral_actors where kind='test-money')),'verified matured test USD excluded');

-- Owner reconciliation records are evidence only; they cannot unlock the balance.
update public.contributions set funds_available_at=now()-interval '1 day'
  where id=(select id from referral_actors where kind='paid');
set constraints all immediate;
set constraints all deferred;
-- Synthetic route change: production admission guards make this field immutable.
set local session_replication_role=replica;
update public.contributions set settlement_route='paystack_direct'
  where id=(select id from referral_actors where kind='paid');
set local session_replication_role=origin;
do $$
declare blocked boolean:=false;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  begin
    perform public.referral_funding_review_create((select id from referral_actors where kind='paid'),
      8880,2000,0,0,0,extensions.gen_random_uuid(),repeat('a',64),true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'direct Paystack split cannot be reviewed as platform-wallet funding');
end $$;
set local session_replication_role=replica;
update public.contributions set settlement_route='platform_wallet'
  where id=(select id from referral_actors where kind='paid');
set local session_replication_role=origin;
do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); r uuid; blocked boolean;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='admin'),true);
  blocked:=false;
  begin perform public.referral_funding_review_create(cid,8880,2000,0,0,0,extensions.gen_random_uuid(),repeat('a',64),true);
  exception when others then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'ordinary admin cannot record funding review');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  blocked:=false;
  begin perform public.referral_funding_review_create(cid,8881,2000,0,0,0,extensions.gen_random_uuid(),repeat('a',64),true);
  exception when others then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'settled platform fee cannot exceed recorded fee');
  blocked:=false;
  begin perform public.referral_funding_review_create(cid,8880,0,0,0,0,extensions.gen_random_uuid(),repeat('a',64),true);
  exception when others then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'known provider cost cannot be omitted');
  r:=public.referral_funding_review_create(cid,8880,2000,0,0,0,extensions.gen_random_uuid(),repeat('a',64),true);
  insert into referral_actors values('funding-review',r);
  blocked:=false;
  begin perform public.referral_funding_review_check(r,false,true);
  exception when others then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'submitter cannot independently review');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='superadmin'),true);
  perform pg_temp.assert_true(public.referral_funding_review_check(r,false,true),'independent review');
  perform pg_temp.assert_true(public.referral_funding_review_check(r,false,true),'same check replay');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  perform pg_temp.assert_true(public.referral_my_summary()->>'payable_minor'='0','funding review does not create payable balance');
end $$;

-- Exercise the private foundation only in a rolled-back synthetic transaction.
-- Replacing this constant is not an operational activation mechanism.
savepoint synthetic_reservation_core;
do $$
declare role_name text; blocked boolean;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    perform pg_temp.assert_true(not has_function_privilege(role_name,
      'public.facilitator_reservation_create_internal(uuid,uuid,uuid,uuid,text,bigint,jsonb)','execute'),
      role_name||' cannot execute private reservation core');
    perform pg_temp.assert_true(not has_table_privilege(role_name,'public.facilitator_reservation_requests','select')
      and not has_table_privilege(role_name,'public.facilitator_reservation_allocations','insert'),
      role_name||' cannot access private reservation ledger');
  end loop;
  blocked:=false;
  begin perform public.facilitator_reservation_create_internal(null,null,null,null,'KES',1,'[]'::jsonb);
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_DISABLED:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'reservation core is hard disabled');
end $$;
create or replace function public.facilitator_reservation_core_enabled() returns boolean
language sql immutable set search_path='' as $$ select true $$;
do $$
declare u uuid:=(select id from referral_actors where kind='referrer');
  owner_id uuid:=(select id from referral_actors where kind='owner');
  checker uuid:=(select id from referral_actors where kind='superadmin');
  source uuid:=(select id from referral_actors where kind='funding-review');
  recipient uuid; evidence uuid; inventory uuid; newer_inventory uuid; other_inventory uuid; adverse_review uuid;
  key_id uuid:=extensions.gen_random_uuid();
  first_id uuid; retry_id uuid; allocations jsonb; blocked boolean;
begin
  insert into public.facilitator_recipient_versions(user_id,request_key,full_name,phone,ownership_attested,consent_version)
    values(u,extensions.gen_random_uuid(),'Fictional facilitator','254700000003',true,'facilitator-mpesa-recipient-v1')
    returning revision_id into recipient;
  insert into public.facilitator_recipient_evidence(revision_id,external_reference,sha256,submitted_by)
    values(recipient,extensions.gen_random_uuid(),repeat('a',64),owner_id) returning id into evidence;
  insert into public.facilitator_recipient_checks(revision_id,evidence_id,checked_by,owner_solo)
    values(recipient,evidence,checker,false);
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by)
    values(extensions.gen_random_uuid(),'KES',extensions.gen_random_uuid(),now()-interval '2 days',
      now()-interval '1 hour',now()+interval '1 day',2000,0,0,0,true,
      extensions.gen_random_uuid(),repeat('b',64),owner_id) returning id into inventory;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(inventory,checker,false);
  perform set_config('request.jwt.claim.sub',u::text,true);
  allocations:=jsonb_build_array(jsonb_build_object('review',source,'amount','600'));
  first_id:=public.facilitator_reservation_create_internal(key_id,u,recipient,inventory,'KES',600,allocations);
  retry_id:=public.facilitator_reservation_create_internal(key_id,u,recipient,inventory,'KES',600,allocations);
  perform pg_temp.assert_true(first_id=retry_id,'identical request retains one reservation');
  perform pg_temp.assert_true((select count(*)=1 and sum(amount_minor)=600 from public.facilitator_reservation_allocations),
    'allocation reserves the requested source amount');
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(key_id,u,recipient,inventory,'KES',599,
      jsonb_build_array(jsonb_build_object('review',source,'amount','599')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_CONFLICT:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'changed idempotency replay denied');
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',401,
      jsonb_build_array(jsonb_build_object('review',source,'amount','401')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'source cannot be over-allocated');
  perform pg_temp.assert_true((select count(*)=1 from public.facilitator_reservation_requests),
    'failed reservation rolled back atomically');
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by,recorded_at)
    select extensions.gen_random_uuid(),currency,custody_scope_reference,period_start,now()-interval '30 minutes',
      expires_at,500,0,0,0,true,extensions.gen_random_uuid(),repeat('c',64),owner_id,clock_timestamp()+interval '1 second'
    from public.facilitator_funding_attestations where id=inventory returning id into newer_inventory;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(newer_inventory,checker,false);
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'older inventory cannot bypass newer adverse evidence');
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,newer_inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'pool deficit blocks new reservation');
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by)
    select extensions.gen_random_uuid(),currency,extensions.gen_random_uuid(),period_start,as_of,
      expires_at,2000,0,0,0,true,extensions.gen_random_uuid(),repeat('f',64),owner_id
    from public.facilitator_funding_attestations where id=inventory returning id into other_inventory;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(other_inventory,checker,false);
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,other_inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD: A retained custody scope%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'a deficit in another custody scope blocks admission');
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by,recorded_at)
    select extensions.gen_random_uuid(),currency,custody_scope_reference,period_start,as_of,
      expires_at,2000,0,0,0,true,extensions.gen_random_uuid(),repeat('f',64),owner_id,clock_timestamp()+interval '2 seconds'
    from public.facilitator_funding_attestations where id=newer_inventory returning id into other_inventory;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(other_inventory,checker,false);
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,other_inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'contradictory cash at the same snapshot time is held');
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by,recorded_at)
    select extensions.gen_random_uuid(),currency,custody_scope_reference,period_start,now()-interval '15 minutes',
      expires_at,2000,0,0,0,true,extensions.gen_random_uuid(),repeat('d',64),owner_id,clock_timestamp()+interval '3 seconds'
    from public.facilitator_funding_attestations where id=inventory returning id into inventory;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(inventory,checker,false);
  begin
    update public.weddings set client_owner_id=u where id=(select id from referral_actors where kind='wedding');
    update public.weddings set client_owner_id=(select id from referral_actors where kind='creator')
      where id=(select id from referral_actors where kind='wedding');
    blocked:=false;
    begin
      perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
        jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
    exception when raise_exception then
      if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
      blocked:=true;
    end;
    perform pg_temp.assert_true(blocked,'transient same-transaction link blocks before deferred eligibility trigger');
    raise exception 'SYNTHETIC_LINK_ROLLBACK';
  exception when raise_exception then
    if sqlerrm <> 'SYNTHETIC_LINK_ROLLBACK' then raise; end if;
  end;
  begin
    insert into public.wedding_memberships(wedding_id,user_id,role)
      values((select id from referral_actors where kind='wedding'),u,'admin');
    insert into public.wedding_memberships(wedding_id,user_id,role)
      values((select id from referral_actors where kind='wedding'),u,'client')
      on conflict (wedding_id,user_id) do nothing;
    perform pg_temp.assert_true(not exists(select 1 from public.referral_eligibility_events
      where wedding_id=(select id from referral_actors where kind='wedding')),
      'unsuccessful membership insert does not record an exclusion');
    update public.wedding_memberships set role='client'
      where wedding_id=(select id from referral_actors where kind='wedding') and user_id=u;
    update public.wedding_memberships set role='admin'
      where wedding_id=(select id from referral_actors where kind='wedding') and user_id=u;
    blocked:=false;
    begin
      perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
        jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
    exception when raise_exception then
      if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
      blocked:=true;
    end;
    perform pg_temp.assert_true(blocked,'transient client promotion blocks reservation');
    raise exception 'SYNTHETIC_MEMBERSHIP_ROLLBACK';
  exception when raise_exception then
    if sqlerrm <> 'SYNTHETIC_MEMBERSHIP_ROLLBACK' then raise; end if;
  end;
  declare new_wedding uuid:=extensions.gen_random_uuid(); new_intent uuid:=extensions.gen_random_uuid();
  begin
    insert into public.weddings(id,couple_names,currency,client_owner_id)
      values(new_wedding,'Fictional linked wedding','KES',u);
    insert into public.referral_intents(id,creator_id,referrer_id,state,consumed_at,disclosed_revision,disclosed_terms_version)
      values(new_intent,(select id from referral_actors where kind='creator'),u,'consumed',now(),
        extensions.gen_random_uuid(),'client-referrals-v1');
    insert into public.referral_attributions(wedding_id,referrer_id,creator_id,intent_id,disclosed_revision,terms_version,eligible)
      values(new_wedding,u,(select id from referral_actors where kind='creator'),new_intent,
        extensions.gen_random_uuid(),'client-referrals-v1',true);
    perform pg_temp.assert_true(exists(select 1 from public.referral_eligibility_events
      where wedding_id=new_wedding and reason='owner_account'),
      'link created before attribution is immediately excluded');
    raise exception 'SYNTHETIC_ATTRIBUTION_ROLLBACK';
  exception when raise_exception then
    if sqlerrm <> 'SYNTHETIC_ATTRIBUTION_ROLLBACK' then raise; end if;
  end;
  update public.referral_balances set held_estimate_minor=100
    where contribution_id=(select id from referral_actors where kind='paid');
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'source deficit blocks additional allocation');
  perform pg_temp.assert_true((select sum(amount_minor)=600 from public.facilitator_reservation_allocations),
    'source deficit does not release existing reservation');
  update public.referral_balances set held_estimate_minor=1000
    where contribution_id=(select id from referral_actors where kind='paid');
  insert into public.referral_funding_reviews(contribution_id,source_digest,currency,estimate_minor,
    platform_fee_minor,settled_platform_fee_minor,provider_cost_minor,losses_minor,holds_minor,
    other_commitments_minor,evidence_reference,evidence_sha256,recorded_by,recorded_at)
    select contribution_id,source_digest,currency,estimate_minor,platform_fee_minor,
      settled_platform_fee_minor,8500,losses_minor,holds_minor,other_commitments_minor,
      extensions.gen_random_uuid(),repeat('e',64),owner_id,clock_timestamp()+interval '1 second'
    from public.referral_funding_reviews where id=source returning id into adverse_review;
  insert into public.referral_funding_review_checks(review_id,checked_by,owner_solo)
    values(adverse_review,checker,false);
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_HOLD:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'newer adverse source evidence blocks older allocation and review');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  blocked:=false;
  begin
    perform public.facilitator_reservation_create_internal(extensions.gen_random_uuid(),u,recipient,inventory,'KES',1,
      jsonb_build_array(jsonb_build_object('review',source,'amount','1')));
  exception when raise_exception then
    if sqlerrm not like 'FACILITATOR_RESERVATION_AUTH:%' then raise; end if;
    blocked:=true;
  end;
  perform pg_temp.assert_true(blocked,'another user cannot request on behalf of the facilitator');
end $$;
rollback to savepoint synthetic_reservation_core;

do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); wid uuid; aid uuid; before_count bigint;
begin
  select wedding_id into wid from public.contributions where id=cid;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,refund_fee_allocation)
    values('stripe','refund','fixture-refund',cid,wid,50000,'KES','processed','platform') returning id into aid;
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,
    couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
    values(aid,wid,cid,'refund',-44560,'KES','platform','stripe','fixture-refund');
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=500 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'half refund nets basis');
do $$
declare rows jsonb;
begin
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  rows:=public.referral_funding_reviews_list();
  perform pg_temp.assert_true((rows->0->>'source_changed')::boolean,'refund invalidates prior funding review');
end $$;
select pg_temp.assert_true(exists(select 1 from public.referral_estimate_ledger where contribution_id=(select id from referral_actors where kind='paid') and estimate_delta_minor=-500),'negative adjustment preserved');
do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); n bigint;
begin
  select count(*) into n from public.referral_estimate_ledger;
  perform public.referral_reconcile_estimate(cid);
  perform public.referral_reconcile_estimate(cid);
  perform pg_temp.assert_true((select count(*)=n from public.referral_estimate_ledger),'idempotent replay');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  perform pg_temp.assert_true(public.referral_my_summary()->>'payable_minor'='0','payable enforced zero');
  perform pg_temp.assert_true(not (public.referral_my_summary()::text like '%Private contributor%'),'no contributor PII');
  insert into public.wedding_memberships(wedding_id,user_id,role)
    values((select id from referral_actors where kind='wedding'),(select id from referral_actors where kind='referrer'),'admin');
end $$;
do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); wid uuid; aid uuid;
begin
  select wedding_id into wid from public.contributions where id=cid;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor,refund_fee_allocation)
    values('stripe','refund','reviewed-refund',cid,wid,10000,'KES','review',10000,'manual_review') returning id into aid;
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=500 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'unconfirmed review does not invent refund principal');
insert into public.provider_adjustment_events(provider,provider_event_id,provider_adjustment_id,event_type,contribution_id,
  wedding_id,amount_minor,currency,provider_state,outcome)
  select 'stripe','reviewed-refund-event','reviewed-refund','refund.processed',id,wedding_id,10000,'KES','refund_processed','held'
  from public.contributions where id=(select id from referral_actors where kind='paid');
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=400 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'event-only refund confirmation changes source digest and nets basis');
do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); wid uuid; aid uuid;
begin
  select wedding_id into wid from public.contributions where id=cid;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status)
    values('stripe','dispute','lost-dispute',cid,wid,20000,'KES','lost') returning id into aid;
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,
    couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
    values(aid,wid,cid,'dispute_debit',-20000,'KES','provider_verified','stripe','lost-dispute');
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=200 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'lost dispute negative netting');
insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,
  couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
  select id,wedding_id,contribution_id,'dispute_reversal',20000,'KES','provider_verified','stripe','lost-dispute'
  from public.payment_adjustments where provider_adjustment_id='lost-dispute';
update public.payment_adjustments set status='won' where provider_adjustment_id='lost-dispute';
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=400 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'won dispute restores only previous debit');
select pg_temp.assert_true((select held_estimate_minor=400 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'later admin/helper authority not client identity');
do $$
declare cid uuid; wid uuid; p jsonb;
begin
  cid:=(select id from referral_actors where kind='new-rate');
  select wedding_id into wid from public.contributions where id=cid;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,refund_fee_allocation)
    values('stripe','refund','full-refund',cid,wid,100000,'KES','processed','couple');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  perform public.referral_set_consent(false,'client-referrals-v1');
  cid:=pg_temp.payment('withdrawn',true,wid);
  perform pg_temp.assert_true((select rate_basis_points=0 from public.referral_contribution_policy where contribution_id=cid),'withdrawal stops prospective snapshots');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  p:=public.referral_admin_policy();
  perform public.referral_owner_policy(false,0,(p->>'revision')::uuid,true);
  cid:=pg_temp.payment('policy-off',true,wid);
  perform pg_temp.assert_true((select rate_basis_points=0 from public.referral_contribution_policy where contribution_id=cid),'OFF stops prospective snapshots');
  perform pg_temp.assert_true((select rate_basis_points=100 from public.referral_contribution_policy
    where contribution_id=(select id from referral_actors where kind='paid')),'OFF does not reprice old snapshots');
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=0 from public.referral_balances where contribution_id=(select id from referral_actors where kind='new-rate')),'full refund removes entire estimate');
update public.wedding_memberships set role='client' where wedding_id=(select id from referral_actors where kind='wedding')
  and user_id=(select id from referral_actors where kind='referrer');
set constraints all immediate;
select pg_temp.assert_true((select held_estimate_minor=0 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'later provable client self link reverses');
select set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
select pg_temp.assert_true(exists(select 1 from jsonb_array_elements(public.referral_my_summary()->'weddings') item
  where item->>'reference'=(select id::text from referral_actors where kind='wedding')
  and (item->>'excluded_by_account_link')::boolean),'own summary discloses provable account-link exclusion');
select pg_temp.assert_true((select net_paid_minor=91120 and provider_fee_minor=2000 from public.contributions where id=(select id from referral_actors where kind='paid')),'couple/provider amounts unchanged');
select pg_temp.assert_true((select count(*)=0 from public.payout_records),'no payouts');
do $$
declare blocked boolean;
begin
  blocked:=false;
  begin delete from public.referral_estimate_ledger; exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'journal immutable');
end $$;
rollback;
