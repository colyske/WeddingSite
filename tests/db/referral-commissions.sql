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
select pg_temp.assert_true(public.referral_available_cap(5000,8880,2000,500,300,6000,100,400,1000)=4000,'cost/loss/commitment cap');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,0,0)=6880,'rate cannot exceed net fee reserve');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,null,0,0,100000,0,0,0)=0,'unknown cost');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,null,0,0,0)=0,'unknown platform settlement');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,null,0)=0,'unknown commitments');
select pg_temp.assert_true(public.referral_available_cap(10000,8880,2000,0,0,100000,0,0,9000)=0,'committed commission reserve');

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
  blocked:=false;
  begin update public.referral_attributions set creator_id=(select id from referral_actors where kind='other') where wedding_id=wid;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'attribution immutable');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='outsider'),true);
  perform pg_temp.assert_true(jsonb_array_length(public.referral_my_summary()->'weddings')=0,'unrelated referrer sees no aggregate');
end $$;

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

do $$
declare cid uuid:=(select id from referral_actors where kind='paid'); wid uuid; aid uuid; before_count bigint;
begin
  select wedding_id into wid from public.contributions where id=cid;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,refund_fee_allocation)
    values('stripe','refund','fixture-refund',cid,wid,50000,'KES','processed','platform') returning id into aid;
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,
    couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
    values(aid,wid,cid,'refund',-45560,'KES','platform','stripe','fixture-refund');
end $$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=500 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'half refund nets basis');
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
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select held_estimate_minor=500 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'later admin/helper authority not client identity');
update public.wedding_memberships set role='client' where wedding_id=(select id from referral_actors where kind='wedding')
  and user_id=(select id from referral_actors where kind='referrer');
set constraints all immediate;
select pg_temp.assert_true((select held_estimate_minor=0 from public.referral_balances where contribution_id=(select id from referral_actors where kind='paid')),'later provable client self link reverses');
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
