-- Isolated local/CI fixtures only. No provider calls; all effects roll back.
begin;
create temporary table referral_actors(kind text primary key,id uuid not null);
create temporary table referral_codes(kind text primary key,code text not null);
grant select on referral_actors to authenticated,service_role;
grant select,insert on referral_codes to authenticated,service_role;
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Referral regression: %',label; end if; end $$;
grant execute on function pg_temp.assert_true(boolean,text) to authenticated,service_role;

do $$
declare kind text; uid uuid;
begin
  foreach kind in array array['owner','superadmin','admin','creator','default-creator','default-only-creator',
      'active-creator','legacy-pending-creator','referrer','platform-referrer','other','outsider'] loop
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
select pg_temp.assert_true(public.referral_public_rate()=jsonb_build_object('enabled',false,'rate_basis_points',null),
  'public rate hides disabled configuration');
select pg_temp.assert_true(has_function_privilege('anon','public.referral_public_rate()','execute'),
  'anonymous rate lookup is explicitly granted');
select pg_temp.assert_true((select count(*) from jsonb_object_keys(public.referral_public_rate()))=2,
  'public rate lookup exposes only enabled and rate');
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
select pg_temp.assert_true(not has_function_privilege('anon','public.referral_register_intent(uuid,text,boolean)','execute')
  and not has_function_privilege('authenticated','public.referral_register_intent(uuid,text,boolean)','execute')
  and has_function_privilege('service_role','public.referral_register_intent(uuid,text,boolean)','execute'),
  'registration intent is server-only');

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

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare p jsonb; blocked boolean;
begin
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  blocked:=false;
  begin
    perform public.referral_set_consent(true,'wrong-version');
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'terms version required');
  p:=public.referral_set_consent(true,'client-referrals-v1');
  insert into referral_codes values('referrer',p->>'code');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='platform-referrer'),true);
  p:=public.referral_set_consent(true,'client-referrals-v1');
  insert into referral_codes values('platform-referrer',p->>'code');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='other'),true);
  p:=public.referral_set_consent(true,'client-referrals-v1');
  insert into referral_codes values('other',p->>'code');
end $$;
reset role;
update public.referral_accounts set code='3b79b3fbb32894bf82dbaf21d2765deb'
  where user_id=(select id from referral_actors where kind='platform-referrer');
update referral_codes set code='3b79b3fbb32894bf82dbaf21d2765deb'
  where kind='platform-referrer';
insert into public.referral_intents(creator_id,referrer_id,is_default,eligible)
  values((select id from referral_actors where kind='legacy-pending-creator'),
    (select id from referral_actors where kind='referrer'),false,false);
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare code text; default_code text; blocked boolean;
begin
  select c.code into code from referral_codes c where c.kind='referrer';
  select c.code into default_code from referral_codes c where c.kind='platform-referrer';
  blocked:=false;
  begin perform public.referral_register_intent((select id from referral_actors where kind='referrer'),code,false);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'registration self referral denied');
  perform public.referral_register_intent((select id from referral_actors where kind='creator'),code,false);
  perform public.referral_register_intent((select id from referral_actors where kind='default-creator'),default_code,true);
  perform public.referral_register_intent((select id from referral_actors where kind='default-only-creator'),default_code,true);
  perform public.referral_register_intent((select id from referral_actors where kind='active-creator'),code,false);
  perform public.referral_register_intent((select id from referral_actors where kind='other'),code,false);
end $$;
reset role;

create function pg_temp.create_referred(p_creator text,p_slug text,p_accept boolean,p_default boolean default false) returns uuid
language plpgsql as $$
declare d jsonb; code text; wid uuid;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind=p_creator),true);
  if p_default then
    select a.code into code from public.referral_accounts a join referral_actors x on x.id=a.user_id where x.kind='platform-referrer';
    perform public.referral_capture_default(code);
  else
    select a.code into code from public.referral_accounts a join referral_actors x on x.id=a.user_id where x.kind='referrer';
    perform public.referral_capture(code);
  end if;
  d:=public.referral_disclosure();
  wid:=public.referral_create_wedding(p_slug,'Private couple',current_date+30,'Local venue','KES',100,
    array['#244b3a'],jsonb_build_array(jsonb_build_object('name','Venue','eventDate',(current_date+30)::text,
      'eventTime','10:00','address','Local address','kind','main')),
    (d->>'intent_id')::uuid,case when p_accept then 'accept' else 'decline' end,
    (d->>'revision')::uuid,d->>'terms_version');
  return wid;
end $$;
do $$
declare i uuid; again uuid; code text; second_code text; default_code text; blocked boolean; p jsonb; rev uuid;
  wid uuid; next_wid uuid; later_wid uuid; legacy uuid; declined uuid; default_intent uuid; d jsonb;
  default_first uuid; default_second uuid; default_later uuid; legacy_pending uuid;
begin
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
  p:=public.referral_set_consent(true,'client-referrals-v1'); code:=p->>'code';
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='platform-referrer'),true);
  p:=public.referral_set_consent(true,'client-referrals-v1');
  default_code:=p->>'code';
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='other'),true);
  p:=public.referral_set_consent(true,'client-referrals-v1'); second_code:=p->>'code';
  legacy:=pg_temp.create_referred('creator','legacy-referred',true);
  perform pg_temp.assert_true((select not eligible from public.referral_intents where creator_id=
    (select id from referral_actors where kind='creator')),'preactivation acceptance permanently ineligible');
  insert into referral_actors values('legacy',legacy);
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='owner'),true);
  p:=public.referral_admin_policy(); rev:=(p->>'revision')::uuid;
  p:=public.referral_owner_policy(true,100,rev,true);
  blocked:=false;
  begin perform public.referral_owner_policy(true,200,rev,true); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'stale Owner CAS rejected');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='outsider'),true);
  blocked:=false; begin perform public.referral_capture(code); exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'existing account cannot capture a new facilitator link');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='active-creator'),true);
  i:=public.referral_capture(code);
  again:=public.referral_capture(repeat('0',32));
  perform pg_temp.assert_true(i=again,'invalid later link preserves first valid registration intent');
  again:=public.referral_capture(second_code);
  perform pg_temp.assert_true(i=again and (select referrer_id=(select id from referral_actors where kind='referrer')
    from public.referral_intents where id=i),'later explicit code preserves first explicit attribution');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='default-creator'),true);
  default_intent:=public.referral_capture_default(default_code);
  perform pg_temp.assert_true((select is_default from public.referral_intents where id=default_intent),
    'no-referrer fallback is marked as default');
  again:=public.referral_capture(second_code);
  perform pg_temp.assert_true(default_intent=again and (select not is_default and
    referrer_id=(select id from referral_actors where kind='other')
    from public.referral_intents where id=default_intent),'explicit facilitator link replaces only pending default');
  wid:=pg_temp.create_referred('default-creator','default-upgrade-attributed',true);
  legacy_pending:=pg_temp.create_referred('legacy-pending-creator','legacy-pending-accepted',true);
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=wid),
    'accepted draft is not attributed before publication');
  wid:=pg_temp.create_referred('active-creator','active-first-draft',true);
  insert into referral_actors values('wedding',wid);
  next_wid:=pg_temp.create_referred('active-creator','active-second-draft',true);
  default_first:=pg_temp.create_referred('default-only-creator','default-first-draft',true,true);
  default_second:=pg_temp.create_referred('default-only-creator','default-second-draft',true,true);
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where creator_id=
    (select id from referral_actors where kind='active-creator')),'multiple drafts remain unattributed before publication');
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where creator_id=
    (select id from referral_actors where kind='default-only-creator')),'default intent remains unattributed before publication');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='active-creator'),true);
  d:=public.referral_disclosure();
  perform pg_temp.assert_true(d->>'intent_id' is null,'accepted account decision is not repeated on another draft');
  update public.weddings set first_published_at=clock_timestamp() where id=next_wid;
  update public.weddings set first_published_at=clock_timestamp() where id=default_second;
  update public.weddings set first_published_at=clock_timestamp() where id=default_first;
  update public.weddings set first_published_at=clock_timestamp() where id=wid;
  update public.weddings set first_published_at=clock_timestamp() where id=legacy;
  update public.weddings set first_published_at=clock_timestamp() where id=(select id from public.weddings where slug='default-upgrade-attributed');
  perform pg_temp.assert_true((select referrer_id=(select id from referral_actors where kind='referrer')
    from public.referral_attributions where wedding_id=next_wid),'first published draft gets facilitator attribution');
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=wid),
    'later-published draft does not inherit attribution');
  update referral_actors set id=next_wid where kind='wedding';
  perform pg_temp.assert_true((select not eligible from public.referral_attributions where wedding_id=legacy),
    'first publication retains preactivation ineligibility');
  perform pg_temp.assert_true((select referrer_id=(select id from referral_actors where kind='other')
    from public.referral_attributions where wedding_id=(select id from public.weddings where slug='default-upgrade-attributed')),
    'explicit facilitator receives the accepted attribution');
  update public.weddings set first_published_at=clock_timestamp() where id=legacy_pending;
  perform pg_temp.assert_true((select not eligible from public.referral_attributions where wedding_id=legacy_pending),
    'pre-migration pending intent remains permanently commission-ineligible after acceptance');
  perform pg_temp.assert_true((select referrer_id=(select id from referral_actors where kind='platform-referrer') and eligible
    from public.referral_attributions where wedding_id=default_second),'default referral attaches to the first published draft');
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=default_first),
    'default referral does not attach to a draft published later');
  later_wid:=pg_temp.create_referred('active-creator','active-later-draft',true);
  update public.weddings set first_published_at=clock_timestamp() where id=later_wid;
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=later_wid),
    'consumed facilitator attribution does not extend to later weddings or the default');
  default_later:=pg_temp.create_referred('default-only-creator','default-later-draft',true,true);
  update public.weddings set first_published_at=clock_timestamp() where id=default_later;
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=default_later),
    'consumed default attribution does not extend to later weddings');
  declined:=pg_temp.create_referred('other','declined-referral',false);
  perform pg_temp.assert_true(not exists(select 1 from public.referral_attributions where wedding_id=declined),'couple decline no attribution');
  perform pg_temp.assert_true(exists(select 1 from public.referral_intents where creator_id=
    (select id from referral_actors where kind='other') and state='declined' and consumed_at is not null
    and disclosed_revision is not null and disclosed_terms_version='client-referrals-v1'),'declined disclosure receipt retained');
  blocked:=false;
  begin update public.referral_attributions set creator_id=(select id from referral_actors where kind='other') where wedding_id=next_wid;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_true(blocked,'attribution immutable');
  perform set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='outsider'),true);
  perform pg_temp.assert_true(jsonb_array_length(public.referral_my_summary()->'weddings')=0,'unrelated referrer sees no aggregate');
end $$;
select pg_temp.assert_true(public.referral_public_rate()=jsonb_build_object('enabled',true,'rate_basis_points',100),
  'public rate lookup follows active Owner setting');

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

savepoint couple_basis_preview;
update public.contributions set funds_available_at=case
    when id=(select id from referral_actors where kind='old-pending') then now()+interval '1 day'
    else now()-interval '1 day' end
  where id in (select id from referral_actors where kind in ('paid','old-pending','new-rate'));
set constraints all immediate;
set constraints all deferred;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
set local role authenticated;
select pg_temp.assert_true((select v->>'basis_minor'='182240' and v->>'estimate_minor'='2733'
  from jsonb_array_elements(public.referral_my_summary()->'couple_basis_estimates') v
  where v->>'reference'=(select id::text from referral_actors where kind='wedding')),
  'preview uses released couple net and saved per-contribution rates, not held or test contributions');
select set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='outsider'),true);
select pg_temp.assert_true(jsonb_array_length(public.referral_my_summary()->'couple_basis_estimates')=0,
  'preview does not reveal another facilitator''s wedding');
reset role;
select set_config('request.jwt.claim.sub',(select id::text from referral_actors where kind='referrer'),true);
create temporary table preview_before as
  select public.simple_payout_balance_raw((select id from referral_actors where kind='wedding')) as balance,
    public.referral_my_summary()->'couple_basis_estimates' as preview,
    public.referral_my_summary()-'couple_basis_estimates' as legacy;
select pg_temp.assert_true((select legacy=public.referral_my_summary_legacy() from preview_before),
  'preview preserves all historical summary fields');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.referral_my_summary_legacy()','execute')
  and not has_function_privilege('anon','public.referral_my_summary()','execute'), 'internal legacy function and anonymous preview denied');
insert into public.expenses(wedding_id,category,description,amount_minor,currency,status)
  values((select id from referral_actors where kind='wedding'),'fixture','Synthetic expense',1000,'KES','approved');
select pg_temp.assert_true((select public.simple_payout_balance_raw(
    (select id from referral_actors where kind='wedding'))=balance-1000
    and public.referral_my_summary()->'couple_basis_estimates'=preview from preview_before),
  'couple expense reduces couple balance, not the facilitator calculation');
insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
  amount_minor,currency,status,hold_minor,refund_fee_allocation)
  values('stripe','refund','preview-refund',(select id from referral_actors where kind='paid'),
    (select id from referral_actors where kind='wedding'),10000,'KES','review',10000,'manual_review');
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select v->>'basis_minor'='172240' and v->>'estimate_minor'='2633'
  from jsonb_array_elements(public.referral_my_summary()->'couple_basis_estimates') v
  where v->>'reference'=(select id::text from referral_actors where kind='wedding')),
  'preview accounts for the couple adjustment hold');
update public.payment_adjustments set status='processed',hold_minor=0 where provider_adjustment_id='preview-refund';
insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,
  couple_net_delta_minor,currency,allocation,provider,provider_adjustment_id)
  select id,wedding_id,contribution_id,'refund',-4000,'KES','couple','stripe','preview-refund'
  from public.payment_adjustments where provider_adjustment_id='preview-refund';
set constraints all immediate;
set constraints all deferred;
select pg_temp.assert_true((select v->>'basis_minor'='178240' and v->>'estimate_minor'='2693'
  from jsonb_array_elements(public.referral_my_summary()->'couple_basis_estimates') v
  where v->>'reference'=(select id::text from referral_actors where kind='wedding')),
  'preview replaces the hold with the actual couple refund debit');
rollback to savepoint couple_basis_preview;

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
