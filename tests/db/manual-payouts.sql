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
declare a uuid; custody uuid; prior public.manual_payout_statement_batches; b uuid; statement uuid:=extensions.gen_random_uuid();
  line uuid:=extensions.gen_random_uuid(); e uuid; caller uuid:=auth.uid(); receipt public.manual_payout_receipts; booked timestamptz;
begin
  select * into strict receipt from public.manual_payout_receipts where payout_id=p_id;
  select custody_id into custody from public.manual_payout_requests where id=p_id;
  select * into strict prior from public.manual_payout_statement_batches where custody_id=custody order by sequence desc limit 1;
  e:=pg_temp.evidence('statement');
  booked:=clock_timestamp();
  b:=public.manual_payout_append_statement(custody,prior.id,statement,clock_timestamp(),
    prior.closing_minor,0,receipt.actual_minor+receipt.actual_fee_minor,
    prior.closing_minor-receipt.actual_minor-receipt.actual_fee_minor,0,e);
  perform public.manual_payout_register_statement_debit(b,line,receipt.transaction_reference,receipt.actual_minor,
    receipt.actual_fee_minor,receipt.currency,booked,e);
  perform set_config('request.jwt.claim.sub',caller::text,true);
  return public.manual_payout_reconcile(p_id,'daraja',receipt.account_reference,statement,line,
    p_reference,p_actual,0,'KES',booked,p_evidence);
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
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',%L)',p,claim),'already claimed');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',p),'already claimed');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  perform public.manual_payout_transition(p,'uncertain');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,4001,0,''KES'')',
    (select id from mp_ids where key='wedding'),(select id from mp_ids where key='custody'),
    (select id from mp_ids where key='recipient')),'Uncertain');
  e:=pg_temp.evidence('receipt','sender');
  perform pg_temp.actor('sender');
  begin
    if public.manual_payout_report(p,'RECEIPT-ONE',6001,0,'KES',now(),e) then
      raise exception 'Mismatched receipt was accepted as paid evidence'; end if;
    if not exists(select 1 from public.manual_payout_account_holds where payout_id=p and actual_minor=6001)
      or public.manual_payout_state(p)<>'uncertain' then raise exception 'Mismatch did not retain an explicit account incident'; end if;
    raise exception using errcode='P9999',message='Rollback isolated mismatch regression';
  exception when sqlstate 'P9999' then null;
  end;
  perform public.manual_payout_report(p,'receipt-one',6000,0,'KES',now(),e);
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''paid'',null,%L)',p,e),'statement reconciliation');
  perform pg_temp.reject(format('select pg_temp.reconcile(%L,%L,''RECEIPT-ONE'',6000)',p,e),'Independent');
  e:=pg_temp.evidence('reconciliation','sender');
  perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select pg_temp.reconcile(%L,%L,''RECEIPT-ONE'',5999)',p,e),'mismatch');
  declare custody uuid; prior uuid; b uuid; statement uuid:=extensions.gen_random_uuid(); line uuid:=extensions.gen_random_uuid();
    statement_evidence uuid; unrelated uuid; booked timestamptz;
  begin
    select custody_id into custody from public.manual_payout_requests where id=p;
    select id into prior from public.manual_payout_statement_batches where custody_id=custody order by sequence desc limit 1;
    statement_evidence:=pg_temp.evidence('statement'); booked:=clock_timestamp();
    b:=public.manual_payout_append_statement(custody,prior,statement,clock_timestamp(),10000,0,6000,4000,0,statement_evidence);
    unrelated:=public.manual_payout_register_custody('daraja',pg_temp.account(),'KES',10000,
      clock_timestamp(),pg_temp.evidence('custody'),0);
    select statement_reference into unrelated from public.manual_payout_statement_batches where custody_id=unrelated;
    perform pg_temp.actor('checker');
    perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,extensions.gen_random_uuid(),%L,''RECEIPT-ONE'',6000,0,''KES'',%L,%L)',
      p,(select account_reference from public.manual_payout_receipts where payout_id=p),line,booked,e),'Registered statement batch');
    perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,%L,''RECEIPT-ONE'',6000,0,''KES'',%L,%L)',
      p,(select account_reference from public.manual_payout_receipts where payout_id=p),unrelated,line,booked,e),'Registered statement batch');
    perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,%L,''RECEIPT-ONE'',6000,0,''KES'',%L,%L)',
      p,(select account_reference from public.manual_payout_receipts where payout_id=p),statement,line,booked,e),'Exact registered statement debit');
    perform pg_temp.reject(format('insert into public.manual_payout_events(payout_id,state,actor_id) values(%L,''paid'',auth.uid())',p),
      'Paid requires atomically');
    perform pg_temp.reject(format('select public.manual_payout_register_statement_debit(%L,extensions.gen_random_uuid(),''OVER-CAPACITY'',6001,0,''KES'',%L,%L)',
      b,booked,statement_evidence),'capacity');
    perform pg_temp.reject(format('select public.manual_payout_register_statement_debit(%L,extensions.gen_random_uuid(),''FEE-CAPACITY'',6000,1,''KES'',%L,%L)',
      b,booked,statement_evidence),'capacity');
    perform pg_temp.reject(format('select public.manual_payout_register_statement_debit(%L,extensions.gen_random_uuid(),''WRONG-CURRENCY'',6000,0,''USD'',%L,%L)',
      b,booked,statement_evidence),'currency');
    perform public.manual_payout_register_statement_debit(b,line,'RECEIPT-ONE',6000,0,'KES',booked,statement_evidence);
    perform pg_temp.reject(format('select public.manual_payout_register_statement_debit(%L,%L,''DUPLICATE-LINE'',6000,0,''KES'',%L,%L)',
      b,line,booked,statement_evidence),'unique');
    perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,extensions.gen_random_uuid(),''RECEIPT-ONE'',6000,0,''KES'',%L,%L)',
      p,(select account_reference from public.manual_payout_receipts where payout_id=p),statement,booked,e),'Exact registered statement debit');
    perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,%L,''RECEIPT-ONE'',6000,0,''KES'',%L,%L)',
      p,(select account_reference from public.manual_payout_receipts where payout_id=p),statement,line,booked+interval '1 microsecond',e),'Exact registered statement debit');
    if public.manual_payout_state(p)<>'reported' or exists(select 1 from public.manual_payout_reconciliations where payout_id=p) then
      raise exception 'Rejected statement mapping exposed paid/reconciliation'; end if;
    perform public.manual_payout_reconcile(p,'daraja',(select account_reference from public.manual_payout_receipts where payout_id=p),
      statement,line,'RECEIPT-ONE',6000,0,'KES',booked,e);
    if not exists(select 1 from public.manual_payout_statement_debits where payout_id=p and batch_id=b and line_reference=line) then
      raise exception 'Successful reconciliation did not allocate its exact debit atomically'; end if;
  end;
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
  begin
    if public.manual_payout_report(p,'RECEIPT-ONE',1000,0,'KES',now(),e) then
      raise exception 'Duplicate receipt was accepted'; end if;
    if not exists(select 1 from public.manual_payout_account_holds where payout_id=p) then
      raise exception 'Duplicate receipt did not freeze the shared custody account'; end if;
    raise exception using errcode='P9999',message='Rollback isolated receipt-collision regression';
  exception when sqlstate 'P9999' then null;
  end;
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
  select id into original_batch from public.manual_payout_statement_batches where custody_id=a and previous_batch is null;
  select statement_reference,line_reference into statement,line from public.manual_payout_reconciliations where payout_id=p;
  e:=pg_temp.evidence('statement');
  select id into b2 from public.manual_payout_statement_batches where custody_id=a order by sequence desc limit 1;
  b:=public.manual_payout_append_statement(a,b2,extensions.gen_random_uuid(),clock_timestamp(),2000,5000,0,7000,0,e);
  perform pg_temp.reject(format('select public.manual_payout_append_statement(%L,%L,extensions.gen_random_uuid(),clock_timestamp(),10000,1,0,10001,0,%L)',
    a,original_batch,pg_temp.evidence('statement')),'chain');
  if not exists(select 1 from public.manual_payout_statement_debits where payout_id=p) then
    raise exception 'Paid was visible without its atomically allocated statement debit'; end if;
  perform pg_temp.reject(format('select public.manual_payout_include_debit(%L,%L,%L,%L)',p,b,line,e),'retired');
  c:=extensions.gen_random_uuid();
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
    provider_fee_minor,payment_environment,provider_name,paid_at)
    values(c,w,'Additional verified statement credit',5000,5000,0,5000,'KES','paid',true,false,0,'live','daraja',now()-interval '12 hours');
  perform public.manual_payout_register_settlement(c,a,extensions.gen_random_uuid(),5000,pg_temp.evidence('settlement'),b,
    (select statement_at from public.manual_payout_statement_batches where id=b));
  perform pg_temp.reject(format('select public.manual_payout_register_settlement(%L,%L,extensions.gen_random_uuid(),5000,%L,%L,%L)',
    c,a,pg_temp.evidence('settlement'),b,(select statement_at from public.manual_payout_statement_batches where id=b)),'envelope');
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
  -- Paid financial history cannot be edited to erase its obligation. Even a
  -- nonfinancial revision invalidates the mapping until its evidence is checked.
  perform pg_temp.reject(format('update public.expenses set amount_minor=600 where id=%L',expense),'Recorded paid commitment');
  update public.expenses set description='Changed historical snapshot' where id=expense;
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,6501,0,''KES'')',w,a,r),'Insufficient');
  update public.expenses set description='Historical paid expense' where id=expense;
  -- Fresh, smaller paid debit is included only in the subsequent statement period.
  expense:=extensions.gen_random_uuid(); at_expense:=clock_timestamp();
  insert into public.expenses(id,wedding_id,category,description,amount_minor,currency,status,paid_at)
    values(expense,w,'Fixture','New paid expense',100,'KES','paid',at_expense);
  b2:=public.manual_payout_append_statement(a,b,extensions.gen_random_uuid(),clock_timestamp(),7000,0,100,6900,0,pg_temp.evidence('statement'));
  perform public.manual_payout_map_source('expense',expense,a,b2,pg_temp.evidence('commitment'),extensions.gen_random_uuid(),at_expense);
  -- A newer source snapshot must never free an old statement's consumed capacity.
  begin
    update public.expenses set description='Changed mapped snapshot' where id=expense;
    perform public.manual_payout_map_source('expense',expense,a,null,pg_temp.evidence('commitment'));
    expense:=extensions.gen_random_uuid();
    insert into public.expenses(id,wedding_id,category,description,amount_minor,currency,status,paid_at)
      values(expense,w,'Fixture','Cannot reuse consumed debit capacity',100,'KES','paid',at_expense);
    perform pg_temp.reject(format('select public.manual_payout_map_source(''expense'',%L,%L,%L,%L,extensions.gen_random_uuid(),%L)',
      expense,a,b2,pg_temp.evidence('commitment'),at_expense),'capacity');
    raise exception using errcode='P9999',message='Rollback isolated capacity regression';
  exception when sqlstate 'P9999' then null;
  end;
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
-- Opening balances may already be net of paid history and include bank-held
-- funds. Record verified gross entitlement without inventing spendable capital.
savepoint net_opening;
do $$
declare a uuid; w uuid; c uuid:=extensions.gen_random_uuid(); expense uuid:=extensions.gen_random_uuid(); b uuid; p uuid; r uuid;
begin
  select id into w from mp_ids where key='wedding';
  perform pg_temp.actor('maker');
  a:=public.manual_payout_register_custody('daraja',pg_temp.account(),'KES',7000,now()-interval '1 day',pg_temp.evidence('custody'),1000);
  select id into b from public.manual_payout_statement_batches where custody_id=a;
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
    provider_fee_minor,payment_environment,provider_name,paid_at)
    values(c,w,'Verified gross before historical debit',10000,10000,0,10000,'KES',
      'paid',true,false,0,'live','daraja',now()-interval '2 days');
  insert into public.expenses(id,wedding_id,category,description,amount_minor,currency,status,paid_at)
    values(expense,w,'Fixture','Debit already in net opening balance',2000,'KES','paid',now()-interval '2 days');
  perform public.manual_payout_map_source('expense',expense,a,b,pg_temp.evidence('commitment'),extensions.gen_random_uuid(),now()-interval '2 days');
  perform public.manual_payout_register_settlement(c,a,extensions.gen_random_uuid(),10000,pg_temp.evidence('settlement'),b,now()-interval '36 hours');
  select id into r from public.manual_payout_recipients where wedding_id=w order by revision desc limit 1;
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,7001,0,''KES'')',w,a,r),'Insufficient');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,r,7000,0,'KES');
  perform public.manual_payout_transition(p,'cancelled');
  perform public.manual_payout_append_statement(a,b,extensions.gen_random_uuid(),clock_timestamp(),8000,0,0,8000,0,pg_temp.evidence('statement'));
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,r,8000,0,'KES');
  perform public.manual_payout_transition(p,'cancelled');
end $$;
rollback to net_opening;
savepoint fee_reconciliation;
do $$
declare p uuid; a uuid; prior public.manual_payout_statement_batches; b uuid; line uuid:=extensions.gen_random_uuid();
  statement uuid:=extensions.gen_random_uuid(); evidence uuid; reconciliation uuid; booked timestamptz;
begin
  select id into a from mp_ids where key='custody';
  perform pg_temp.actor('maker');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),(select id from mp_ids where key='wedding'),a,
    (select id from public.manual_payout_recipients where wedding_id=(select id from mp_ids where key='wedding')
      order by revision desc limit 1),1000,100,'KES');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('maker'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  evidence:=pg_temp.evidence('receipt');
  perform public.manual_payout_report(p,'WITH-ACTUAL-FEE',1000,100,'KES',clock_timestamp(),evidence);
  evidence:=pg_temp.evidence('statement'); booked:=clock_timestamp();
  select * into strict prior from public.manual_payout_statement_batches where custody_id=a order by sequence desc limit 1;
  b:=public.manual_payout_append_statement(a,prior.id,statement,clock_timestamp(),prior.closing_minor,0,1100,
    prior.closing_minor-1100,0,evidence);
  perform public.manual_payout_register_statement_debit(b,line,'WITH-ACTUAL-FEE',1000,100,'KES',booked,evidence);
  reconciliation:=pg_temp.evidence('reconciliation'); perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,%L,''WITH-ACTUAL-FEE'',1000,0,''KES'',%L,%L)',
    p,(select account_reference from public.manual_payout_custody where id=a),statement,line,booked,reconciliation),'mismatch');
  perform public.manual_payout_reconcile(p,'daraja',(select account_reference from public.manual_payout_custody where id=a),
    statement,line,'WITH-ACTUAL-FEE',1000,100,'KES',booked,reconciliation);
  if not exists(select 1 from public.manual_payout_statement_lines where batch_id=b and line_reference=line
    and direction='debit' and amount_minor=1100) or public.manual_payout_state(p)<>'paid' then
    raise exception 'Actual fee was not included exactly once in atomic paid debit'; end if;
end $$;
rollback to fee_reconciliation;
-- Contradictory late evidence cannot resurrect or rewrite terminal history.
savepoint late_outcome;
do $$
declare p uuid; e uuid; a uuid; w uuid; at_report timestamptz:=clock_timestamp();
begin
  select id,custody_id,wedding_id into strict p,a,w from public.manual_payout_requests
    where public.manual_payout_state(id)='not_transferred';
  e:=pg_temp.evidence('receipt','sender'); perform pg_temp.actor('sender');
  if public.manual_payout_report(p,'LATE-TRANSFER',1000,0,'KES',at_report,e) then
    raise exception 'Late transfer incorrectly accepted as a normal receipt'; end if;
  if public.manual_payout_state(p)<>'not_transferred'
    or (select count(*) from public.manual_payout_account_holds where payout_id=p)<>1 then
    raise exception 'Late receipt did not preserve terminal history and shared account hold'; end if;
  if public.manual_payout_report(p,'LATE-TRANSFER',1000,0,'KES',at_report,e) then
    raise exception 'Incident replay cannot become successful payment'; end if;
  if (select count(*) from public.manual_payout_account_holds where payout_id=p)<>1 then
    raise exception 'Incident replay duplicated its safety record'; end if;
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,1000,0,''KES'',true)',
    w,a,(select id from mp_ids where key='recipient')),'Held custody account');
  perform pg_temp.reject(format('delete from public.manual_payout_account_holds where payout_id=%L',p),'append-only');
end $$;
rollback to late_outcome;
-- A trusted automatic wrapper can carry a real journal ID/digest, not invented
-- manual evidence. Its own journal-correlation proof is tested in the B2C PR.
savepoint automatic_observation;
do $$
declare p uuid; a uuid; w uuid; journal uuid:=extensions.gen_random_uuid(); held uuid; principal uuid;
begin
  select id into a from mp_ids where key='custody';
  select id into w from mp_ids where key='wedding';
  select id into principal from mp_ids where key='maker';
  perform pg_temp.actor('maker');
  p:=public.manual_payout_request(extensions.gen_random_uuid(),w,a,
    (select id from public.manual_payout_recipients where wedding_id=w order by revision desc limit 1),1000,0,'KES');
  insert into public.manual_payout_claims(payout_id,execution_channel,claim_key,sender_id)
    values(p,'automatic_b2c',extensions.gen_random_uuid(),principal);
  update public.profiles set platform_role='client' where id=principal;
  perform set_config('request.jwt.claim.sub','',true);
  held:=public.manual_payout_hold_account(p,null,'automatic_b2c',principal,
    p_journal=>journal,p_journal_sha256=>repeat('a',64));
  if not exists(select 1 from public.manual_payout_account_holds where id=held and evidence_id is null
    and journal_reference=journal and authority_role_at_observation='client') then
    raise exception 'Service observation misrepresented manual evidence or discarded revoked-authority incident'; end if;
  perform pg_temp.reject(format('select public.manual_payout_eligible(%L,%L,%L,''KES'',1)',w,a,
    (select id from mp_ids where key='recipient')),'Held custody account');
end $$;
rollback to automatic_observation;
set local role authenticated;
select pg_temp.actor('client');
select pg_temp.reject('select public.manual_payout_overview()','Staff');
select pg_temp.reject('select public.manual_payout_request(extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),1,0,''KES'')','Staff');
select pg_temp.reject('select public.manual_payout_hold_account(extensions.gen_random_uuid(),null,''automatic_b2c'',extensions.gen_random_uuid())','permission denied');
reset role;
rollback;
