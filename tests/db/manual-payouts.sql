-- ISOLATED LOCAL/CI ONLY. All fixtures, gate substitutions and history roll back.
begin;
create temporary table mp_ids(key text primary key,id uuid not null);
grant select on mp_ids to authenticated;
create function pg_temp.actor(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',(select id::text from mp_ids where key=p_key),true);
  perform set_config('request.jwt.claim.role','authenticated',true);
end $$;
create function pg_temp.reject(p_sql text,p_message text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if position(p_message in sqlerrm)=0 then raise exception 'Unexpected rejection: %; expected %',sqlerrm,p_message; end if;
    return;
  end;
  raise exception 'Expected rejection: %',p_sql;
end $$;
do $$
declare k text; u uuid; wid uuid:=extensions.gen_random_uuid(); cid uuid;
begin
  foreach k in array array['owner','maker','checker','sender','admin','client'] loop
    u:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at) values(u,
      case when k='owner' then 'colyske@gmail.com' else u::text||'@example.test' end,now());
    if k='owner' then perform public.bootstrap_protected_owner(u);
    elsif k<>'client' then update public.profiles set platform_role=
      (case when k='admin' then 'admin' else 'superadmin' end)::public.platform_role where id=u; end if;
    insert into mp_ids values(k,u);
  end loop;
  select id into cid from mp_ids where key='client';
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wid,cid,'Isolated manual fixture','KES',current_date+30);
  insert into mp_ids values('wedding',wid);
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,cid,'client');
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
    partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
    partner2_nationality,partner2_phone,partner2_email,consent_at)
    values(wid,'Fixture One','passport','FIXTURE1','Kenyan','254700000001','one@example.test',
      'Fixture Two','passport','FIXTURE2','Kenyan','254700000002','two@example.test',now());
end $$;
set local role authenticated;
select pg_temp.actor('admin');
select pg_temp.reject('select public.manual_payout_overview()','SuperAdmin');
select pg_temp.reject('select public.manual_payout_submit_evidence(''recipient'',extensions.gen_random_uuid(),repeat(''a'',64))','SuperAdmin');
select pg_temp.reject('select public.admin_set_payout_status(extensions.gen_random_uuid(),''sent'')','SuperAdmin');
select pg_temp.actor('maker');
select pg_temp.reject('select public.manual_payout_submit_evidence(''recipient'',extensions.gen_random_uuid(),repeat(''a'',64))','MANUAL_PAYOUT_BLOCKED');
select pg_temp.reject('select public.manual_payout_submit_evidence(''policy'',extensions.gen_random_uuid(),repeat(''a'',64))','Owner');
select pg_temp.reject('select public.admin_set_payout_status(extensions.gen_random_uuid(),''approved'')','MANUAL_PAYOUT_BLOCKED');
select pg_temp.reject('select public.admin_set_payout_status(extensions.gen_random_uuid(),''sent'')','MANUAL_PAYOUT_BLOCKED');
select pg_temp.reject('select * from public.manual_payout_recipients','permission denied');
select pg_temp.reject('select public.legacy_payout_status_internal(extensions.gen_random_uuid(),''sent'',null)','permission denied');
reset role;
do $$ begin
  if public.manual_payouts_enabled() or public.live_payouts_enabled() then raise exception 'Payout gates must be OFF'; end if;
end $$;
-- Transaction-local simulation, never migration/application configuration.
create or replace function public.manual_payouts_enabled() returns boolean language sql as $$ select true $$;
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
do $$
declare v_id uuid;
begin
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
    provider_fee_minor,payment_environment,provider_name,paid_at)
    values((select id from mp_ids where key='wedding'),'Isolated verified custody fixture',10000,10000,
      0,10000,'KES','paid',true,false,0,'live','daraja',now()-interval '2 days') returning id into v_id;
  insert into mp_ids values('contribution',v_id);
end $$;
create function pg_temp.evidence(p_kind text,p_submitter text default 'maker') returns uuid language plpgsql as $$
declare e uuid;
begin
  perform pg_temp.actor(p_submitter);
  e:=public.manual_payout_submit_evidence(p_kind,extensions.gen_random_uuid(),
    encode(extensions.digest(extensions.gen_random_uuid()::text,'sha256'),'hex'));
  perform pg_temp.reject(format('select public.manual_payout_check_evidence(%L)',e),'different leader');
  perform pg_temp.actor('checker');
  perform public.manual_payout_check_evidence(e);
  perform pg_temp.actor('maker');
  return e;
end $$;
create function pg_temp.account() returns uuid language plpgsql as $$
declare e uuid;
begin
  e:=pg_temp.evidence('account');
  return public.manual_payout_register_account(extensions.gen_random_uuid(),'daraja',extensions.gen_random_uuid(),e);
end $$;
create function pg_temp.reconcile(p_id uuid,p_evidence uuid,p_reference text,p_actual bigint) returns boolean language plpgsql as $$
declare a uuid;
begin
  select account_reference into a from public.manual_payout_receipts where payout_id=p_id;
  return public.manual_payout_reconcile(p_id,'daraja',a,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
    p_reference,p_actual,0,'KES',now(),p_evidence);
end $$;
do $$
declare e uuid; a uuid; r uuid; p uuid; w uuid; c uuid; v_key uuid:=extensions.gen_random_uuid();
begin
  select id into w from mp_ids where key='wedding';
  select id into c from mp_ids where key='contribution';
  e:=pg_temp.evidence('custody');
  a:=public.manual_payout_register_custody('daraja',pg_temp.account(),'KES',10000,now()-interval '1 day',e,0);
  insert into mp_ids values('custody',a);
  r:=public.manual_payout_recipient(w,pg_temp.evidence('recipient'),'daraja','KES');
  insert into mp_ids values('recipient',r);
  perform public.manual_payout_register_settlement(c,a,extensions.gen_random_uuid(),10000,pg_temp.evidence('settlement'),null,now()-interval '36 hours');
  perform pg_temp.reject(format('select public.manual_payout_register_settlement(%L,%L,extensions.gen_random_uuid(),10000,%L,null,now()-interval ''36 hours'')',
    c,a,pg_temp.evidence('settlement')),'envelope');
  p:=public.manual_payout_request(v_key,w,a,r,6000,0,'KES');
  insert into mp_ids values('payout',p);
  if p<>public.manual_payout_request(v_key,w,a,r,6000,0,'KES') then raise exception 'Replay changed identity'; end if;
  perform pg_temp.reject(format('select public.manual_payout_request(%L,%L,%L,%L,6001,0,''KES'')',v_key,w,a,r),'Idempotency');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,4001,0,''KES'')',w,a,r),'Insufficient');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,1,-1,''KES'')',w,a,r),'Invalid');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,1,0,''USD'')',w,a,r),'currency');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''approved'')',p),'different');
  perform pg_temp.actor('checker');
  perform public.manual_payout_transition(p,'approved');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',p),'Independent sender');
end $$;
-- Refund/dispute after approval is serialized on the same contribution/wedding.
savepoint adjustment_race;
insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
  amount_minor,currency,status,hold_minor)
  select 'paystack','refund','isolated-race',c.id,c.wedding_id,5000,'KES','pending',5000
    from public.contributions c where c.id=(select id from mp_ids where key='contribution');
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'Insufficient');
rollback to adjustment_race;
savepoint recipient_race;
select pg_temp.actor('maker');
select public.manual_payout_recipient((select id from mp_ids where key='wedding'),pg_temp.evidence('recipient'),'daraja','KES');
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'revision');
rollback to recipient_race;
savepoint consent_race;
update public.wedding_kyc set consent_at=null where wedding_id=(select id from mp_ids where key='wedding');
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'consent');
rollback to consent_race;
savepoint revoked_authority;
update public.profiles set platform_role='client' where id=(select id from mp_ids where key='checker');
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'revoked');
rollback to revoked_authority;
savepoint changed_policy;
select pg_temp.actor('owner');
update public.platform_policies set min_payout_minor=7000 where id;
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'configured minimum');
rollback to changed_policy;
savepoint held_funds;
update public.contributions set funds_available_at=now()+interval '1 day'
  where id=(select id from mp_ids where key='contribution');
select pg_temp.actor('sender');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mp_ids where key='payout')),'Insufficient');
rollback to held_funds;
do $$
declare p uuid; claim uuid:=extensions.gen_random_uuid(); e uuid;
begin
  select id into p from mp_ids where key='payout';
  perform pg_temp.actor('sender');
  perform public.manual_payout_transition(p,'executing',claim);
  perform public.manual_payout_transition(p,'executing',claim);
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',p),'already claimed');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  perform public.manual_payout_transition(p,'uncertain');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,4001,0,''KES'')',
    (select id from mp_ids where key='wedding'),(select id from mp_ids where key='custody'),
    (select id from mp_ids where key='recipient')),'Insufficient');
  e:=pg_temp.evidence('receipt','sender');
  perform pg_temp.actor('sender');
  perform pg_temp.reject(format('select public.manual_payout_report(%L,''RECEIPT-ONE'',6001,0,''KES'',now(),%L)',p,e),'mismatch');
  perform public.manual_payout_report(p,'receipt-one',6000,0,'KES',now(),e);
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''paid'',null,%L)',p,e),'statement reconciliation');
  perform pg_temp.reject(format('select pg_temp.reconcile(%L,%L,''RECEIPT-ONE'',6000)',p,e),'Independent');
  e:=pg_temp.evidence('reconciliation','sender');
  perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select pg_temp.reconcile(%L,%L,''RECEIPT-ONE'',5999)',p,e),'mismatch');
  perform pg_temp.reconcile(p,e,'RECEIPT-ONE',6000);
  if public.manual_payout_state(p)<>'paid' then raise exception 'Expected independent reconciliation'; end if;
  if (select count(distinct actor_id) from public.manual_payout_events where payout_id=p
      and state in ('requested','approved','executing'))<>3 then raise exception 'Actors overwritten'; end if;
  perform pg_temp.reject(format('update public.manual_payout_events set state=''cancelled'' where payout_id=%L',p),'append-only');
end $$;
-- Duplicate receipt rejected for another request in the same provider/account scope.
do $$
declare p uuid; e uuid; a uuid; w uuid; r uuid;
begin
  select id into a from mp_ids where key='custody';
  select id into w from mp_ids where key='wedding';
  select id into r from mp_ids where key='recipient';
  perform pg_temp.actor('maker');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,r,1000,0,'KES');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('sender'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  e:=pg_temp.evidence('receipt','sender'); perform pg_temp.actor('sender');
  perform pg_temp.reject(format('select public.manual_payout_report(%L,''RECEIPT-ONE'',1000,0,''KES'',now(),%L)',p,e),'unique');
  if public.manual_payout_state(p)<>'executing' then raise exception 'Receipt collision released reservation'; end if;
  e:=pg_temp.evidence('no_transfer','sender'); perform pg_temp.actor('sender');
  perform public.manual_payout_transition(p,'resolution_proposed',null,e);
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''not_transferred'',null,%L)',p,e),'Independent');
  perform pg_temp.actor('checker');
  perform public.manual_payout_transition(p,'not_transferred',null,e);
  perform pg_temp.actor('client');
  if public.manual_payout_history(w)::text like '%evidence%' or public.manual_payout_history(w)::text like '%actor%' then
    raise exception 'Private evidence leaked to couple'; end if;
  perform pg_temp.reject('select public.manual_payout_history(extensions.gen_random_uuid())','Access denied');
end $$;
-- A single contribution can never fund two accounts, even with separate evidence.
do $$
declare a uuid;
begin
  a:=public.manual_payout_register_custody('daraja',pg_temp.account(),'KES',10000,
    now(),pg_temp.evidence('custody'),0);
  perform pg_temp.reject(format('select public.manual_payout_register_settlement(%L,%L,extensions.gen_random_uuid(),10000,%L,null,now()-interval ''36 hours'')',
    (select id from mp_ids where key='contribution'),a,pg_temp.evidence('settlement')),'unique');
end $$;
-- Exactly two eligible actors can complete a normal manual request.
do $$
declare p uuid; e uuid;
begin
  perform pg_temp.actor('maker');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),(select id from mp_ids where key='wedding'),
    (select id from mp_ids where key='custody'),(select id from mp_ids where key='recipient'),1000,0,'KES');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('maker'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  e:=public.manual_payout_submit_evidence('receipt',extensions.gen_random_uuid(),repeat('b',64));
  perform public.manual_payout_report(p,'TWO-ACTORS',1000,0,'KES',now(),e);
  perform pg_temp.reject(format('select pg_temp.reconcile(%L,%L,''TWO-ACTORS'',1000)',p,e),'Independent');
  perform pg_temp.actor('checker'); perform public.manual_payout_check_evidence(e);
  perform pg_temp.actor('maker');
  e:=public.manual_payout_submit_evidence('reconciliation',extensions.gen_random_uuid(),repeat('e',64));
  perform pg_temp.actor('checker'); perform public.manual_payout_check_evidence(e);
  perform pg_temp.reconcile(p,e,'TWO-ACTORS',1000);
  if (select count(distinct actor_id) from public.manual_payout_events where payout_id=p)<>2 then
    raise exception 'Normal review must work with exactly two authorized actors'; end if;
end $$;
-- Explicit protected Owner solo mode retains evidence, claims, receipts and audit.
do $$
declare p uuid; e uuid; r uuid; w uuid;
begin
  select id into w from mp_ids where key='wedding';
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,1000,0,''KES'',true)',
    w,(select id from mp_ids where key='custody'),(select id from mp_ids where key='recipient')),'Only protected Owner');
  perform pg_temp.actor('owner');
  e:=public.manual_payout_submit_evidence('recipient',extensions.gen_random_uuid(),repeat('c',64));
  perform public.manual_payout_check_evidence(e,true);
  r:=public.manual_payout_recipient(w,e,'daraja','KES');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,(select id from mp_ids where key='custody'),r,1000,0,'KES',true);
  perform public.manual_payout_transition(p,'approved');
  perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  e:=public.manual_payout_submit_evidence('receipt',extensions.gen_random_uuid(),repeat('d',64));
  perform public.manual_payout_check_evidence(e,true);
  perform public.manual_payout_report(p,'OWNER-SOLO',1000,0,'KES',now(),e);
  e:=public.manual_payout_submit_evidence('reconciliation',extensions.gen_random_uuid(),repeat('e',64));
  perform public.manual_payout_check_evidence(e,true);
  perform pg_temp.reconcile(p,e,'OWNER-SOLO',1000);
  if (select count(distinct actor_id) from public.manual_payout_events where payout_id=p)<>1 or
    exists(select 1 from public.manual_payout_events where payout_id=p and not owner_solo) then
    raise exception 'Owner solo mode must explicitly audit the actual single actor on every transition'; end if;
  perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Protected Owner');
end $$;
-- Replenishment, exact paid-debit inclusion and legacy opening allocations.
do $$
declare a uuid; p uuid; w uuid; r uuid; e uuid; b uuid; b2 uuid; original_batch uuid; c uuid; expense uuid;
  line uuid; statement uuid; at_expense timestamptz; balance jsonb; adjustment uuid;
begin
  select id into a from mp_ids where key='custody';
  select id into w from mp_ids where key='wedding';
  select id into p from mp_ids where key='payout';
  select id into original_batch from public.manual_payout_statement_batches where custody_id=a;
  select statement_reference,line_reference into statement,line from public.manual_payout_reconciliations where payout_id=p;
  e:=pg_temp.evidence('statement');
  b:=public.manual_payout_append_statement(a,original_batch,statement,clock_timestamp(),10000,5000,6000,9000,0,e);
  perform pg_temp.reject(format('select public.manual_payout_append_statement(%L,%L,extensions.gen_random_uuid(),clock_timestamp(),10000,1,0,10001,0,%L)',
    a,original_batch,pg_temp.evidence('statement')),'chain');
  perform public.manual_payout_include_debit(p,b,line,e);
  perform pg_temp.reject(format('select public.manual_payout_include_debit(%L,%L,%L,%L)',p,b,line,e),'unique');
  c:=extensions.gen_random_uuid();
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
    provider_fee_minor,payment_environment,provider_name,paid_at)
    values(c,w,'Additional verified statement credit',5000,5000,0,5000,'KES','paid',true,false,0,'live','daraja',now()-interval '12 hours');
  perform public.manual_payout_register_settlement(c,a,extensions.gen_random_uuid(),5000,pg_temp.evidence('settlement'),b,now()-interval '6 hours');
  perform pg_temp.reject(format('select public.manual_payout_register_settlement(%L,%L,extensions.gen_random_uuid(),5000,%L,%L,now()-interval ''6 hours'')',
    c,a,pg_temp.evidence('settlement'),b),'envelope');
  perform pg_temp.actor('client'); balance:=public.manual_payout_balance(w);
  if (balance->>'statement_backed_minor')::bigint<>15000 or (balance->>'spent_minor')::bigint<>8000
    or (balance->>'reserved_minor')::bigint<>0 or (balance->>'available_minor')::bigint<>0 then
    raise exception 'Shared nonwithdrawable balance disagrees with requests/spending: %',balance; end if;
  e:=pg_temp.evidence('recipient'); r:=public.manual_payout_recipient(w,e,'daraja','KES');
  -- Existing paid expense before opening: deduct entitlement once, not bank balance twice.
  expense:=extensions.gen_random_uuid();
  insert into public.expenses(id,wedding_id,category,description,amount_minor,currency,status,paid_at)
    values(expense,w,'Fixture','Historical paid expense',500,'KES','paid',now()-interval '2 days');
  perform public.manual_payout_map_source('expense',expense,a,original_batch,pg_temp.evidence('commitment'),
    extensions.gen_random_uuid(),now()-interval '2 days');
  -- A changed source invalidates that mapping; the affected increment remains held.
  update public.expenses set amount_minor=600 where id=expense;
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,6500,0,''KES'')',w,a,r),'Insufficient');
  update public.expenses set amount_minor=500 where id=expense;
  -- Fresh, smaller paid debit is included only in the subsequent statement period.
  expense:=extensions.gen_random_uuid(); at_expense:=clock_timestamp();
  insert into public.expenses(id,wedding_id,category,description,amount_minor,currency,status,paid_at)
    values(expense,w,'Fixture','New paid expense',100,'KES','paid',at_expense);
  b2:=public.manual_payout_append_statement(a,b,extensions.gen_random_uuid(),clock_timestamp(),9000,0,100,8900,0,pg_temp.evidence('statement'));
  perform public.manual_payout_map_source('expense',expense,a,b2,pg_temp.evidence('commitment'),extensions.gen_random_uuid(),at_expense);
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,r,6400,0,'KES');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('maker'); perform public.manual_payout_transition(p,'cancelled');
  perform pg_temp.actor('client'); balance:=public.manual_payout_balance(w);
  if (balance->>'known_obligations_minor')::bigint<>600 or (balance->>'reserved_minor')::bigint<>0 then
    raise exception 'Source/reflected amounts double-counted: %',balance; end if;
  perform pg_temp.actor('maker');
  adjustment:=extensions.gen_random_uuid();
  insert into public.payment_adjustments(id,provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor)
    values(adjustment,'paystack','dispute','isolated-bounded-reversal',c,w,200,'KES','lost',0);
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,couple_net_delta_minor,
    currency,provider,provider_adjustment_id)
    values(adjustment,w,c,'dispute_debit',-200,'KES','paystack','isolated-bounded-reversal');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,6400,0,''KES'')',w,a,r),'Insufficient');
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,couple_net_delta_minor,
    currency,provider,provider_adjustment_id)
    values(adjustment,w,c,'dispute_reversal',200,'KES','paystack','isolated-bounded-reversal');
  update public.payment_adjustments set status='won' where id=adjustment;
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,r,6400,0,'KES');
  perform public.manual_payout_transition(p,'cancelled');
  -- An unbacked positive entry cannot create entitlement above collected principal.
  adjustment:=extensions.gen_random_uuid();
  insert into public.payment_adjustments(id,provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor)
    values(adjustment,'paystack','dispute','isolated-unbacked-positive',c,w,200,'KES','won',0);
  insert into public.financial_adjustment_ledger(adjustment_id,wedding_id,contribution_id,entry_type,couple_net_delta_minor,
    currency,provider,provider_adjustment_id)
    values(adjustment,w,c,'dispute_reversal',200,'KES','paystack','isolated-unbacked-positive');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,6500,0,''KES'')',w,a,r),'Insufficient');
end $$;
set local role authenticated;
select pg_temp.actor('client');
select pg_temp.reject('select public.manual_payout_overview()','Staff');
select pg_temp.reject('select public.manual_payout_request(extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),1,0,''KES'')','Staff');
reset role;
rollback;
