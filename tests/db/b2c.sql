-- Local Supabase only; synthetic funds, no provider calls, every effect rolled back.
begin;
-- Exercise already-tested reservation plumbing separately from the new hard
-- destination-ownership prerequisite (tests/db/b2c-prerequisites.sql).
create or replace function public.b2c_destination_ownership_verified(p_wedding uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select true $$;
create or replace function public.b2c_reserve(p_payout uuid,p_key uuid,p_originator uuid,p_callback_hash text,
  p_shortcode text,p_command text,p_allow_auto boolean default false) returns jsonb
language sql security definer set search_path = '' as $$
  select public.b2c_reserve_reviewed_internal(p_payout,p_key,p_originator,p_callback_hash,p_shortcode,p_command,p_allow_auto)
$$;
create function pg_temp.b2c_reject(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)=0 then raise; end if;
    return;
  end;
  raise exception 'Expected B2C rejection: %',statement;
end $$;
do $$
declare oid uuid:=extensions.gen_random_uuid(); cid uuid:=extensions.gen_random_uuid();
  sid uuid:=extensions.gen_random_uuid(); other_staff uuid:=extensions.gen_random_uuid(); wid uuid:=extensions.gen_random_uuid();
  receipt uuid:=extensions.gen_random_uuid(); payout uuid:=extensions.gen_random_uuid(); second uuid;
  d jsonb; state text; originator uuid:=extensions.gen_random_uuid(); k uuid:=extensions.gen_random_uuid();
  evidence jsonb; rev integer; before_budget bigint;
begin
  if public.live_payouts_enabled() or exists(select 1 from public.b2c_policy where
    dispatch_enabled or not require_four_eyes or auto_approval_limits is not null or utility_budget_minor is not null) then
    raise exception 'B2C must default deny with four-eyes and no automatic limits or funding';
  end if;
  if has_table_privilege('authenticated','public.b2c_dispatches','INSERT')
    or has_table_privilege('service_role','public.b2c_dispatches','UPDATE')
    or has_function_privilege('authenticated','public.b2c_record_event(uuid,text,text,jsonb)','EXECUTE')
    or has_function_privilege('service_role','public.b2c_apply_event(uuid,text,text,jsonb)','EXECUTE') then
    raise exception 'B2C writes must use gated entrypoints, not raw tables or private helpers'; end if;
  insert into auth.users(id,email,email_confirmed_at) values(oid,'colyske@gmail.com',now());
  perform public.bootstrap_protected_owner(oid);
  insert into auth.users(id) values(cid),(sid),(other_staff);
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.assign_platform_role(sid,'superadmin');
  perform public.assign_platform_role(other_staff,'superadmin');
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wid,cid,'Synthetic B2C couple','KES',current_date+30);
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,cid,'client') on conflict do nothing;
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
    partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
    partner2_nationality,partner2_phone,partner2_email,consent_at)
    values(wid,'Synthetic One','passport','SYN1','Kenyan','254700000001','one@example.test',
      'Synthetic Two','passport','SYN2','Kenyan','254700000002','two@example.test',now());
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'')',payout,k,originator),'disabled');
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"require_four_eyes":false}','Synthetic explicit policy request')$q$,'check constraint');
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"dispatch_enabled":false}','Synthetic staff policy attempt')$q$,'Owner access');
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform public.owner_update_b2c_policy(1,'{"dispatch_enabled":true,"activation_reference":"Synthetic explicit user approval",
    "shortcode":"123456","command_id":"BusinessPayment","contract_reference":"Synthetic independently reviewed official contract",
    "payout_fee_minor":100,"utility_budget_minor":200000,"utility_statement_reference":"Synthetic official utility balance"}','Synthetic local-only activation fixture');
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"dispatch_enabled":false}','Synthetic stale policy attempt')$q$,'Stale');
  if not exists(select 1 from public.audit_events where table_name='b2c_policy') then raise exception 'Policy must be audited'; end if;

  -- Synthetic live fixtures bypass only admission guards in this rollback transaction.
  alter table public.contributions disable trigger guard_payment_environment;
  alter table public.contributions disable trigger guard_live_payment_context;
  alter table public.contributions disable trigger guard_paystack_context;
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,
    net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,
    payment_environment,provider_name,provider_payment_reference)
    values(receipt,wid,'Synthetic verified receipt',100000,100000,0,100000,'KES','paid',true,false,0,'live','daraja','SYNTHETICRECEIPT');
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,
    net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,provider_name)
    values(wid,'Synthetic sandbox',900000,900000,0,900000,'KES','paid',true,false,0,'test','daraja'),
      (wid,'Synthetic unknown fee',900000,900000,0,900000,'KES','paid',true,true,null,'live','daraja'),
      (wid,'Synthetic standard Paystack',900000,900000,0,900000,'KES','paid',true,false,0,'live','paystack');
  if public.b2c_available_minor(wid)<>100000 then raise exception 'Test, Paystack and fee-held funds must be excluded'; end if;
  perform set_config('request.jwt.claim.sub',cid::text,true);
  payout:=public.request_payout(wid,10000,'KES','Synthetic payout',true);
  perform pg_temp.b2c_reject(format('select public.admin_set_payout_status(%L,''approved'')',payout),'Staff');
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform public.admin_set_payout_status(payout,'approved');
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'')',payout,k,originator),'Recipient');
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform pg_temp.b2c_reject(format('select public.owner_review_b2c_recipient(%L,''254700000099'',%L,''Synthetic verified statement reference'')',wid,receipt),'Statement');
  perform public.owner_review_b2c_recipient(wid,'254700000001',receipt,'Synthetic verified statement reference');
  update public.wedding_kyc set partner1_legal_name='Synthetic Changed Identity' where wedding_id=wid;
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'')',payout,k,originator),'Recipient');
  update public.wedding_kyc set partner1_legal_name='Synthetic One' where wedding_id=wid;
  perform public.owner_review_b2c_recipient(wid,'254700000001',receipt,'Synthetic renewed official statement review');
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform public.staff_confirm_b2c_account_review(wid,'Synthetic renewed official statement review');
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform pg_temp.b2c_reject(format('select public.staff_confirm_b2c_account_review(%L,''Synthetic renewed official statement review'')',wid),'different SuperAdmin');
  perform pg_temp.b2c_reject(format('update public.b2c_recipients set account_review_confirmed_by=%L where wedding_id=%L',oid,wid),'b2c_distinct_account_reviewers');
  perform public.owner_review_b2c_recipient(wid,'254700000001',receipt,'Synthetic changed documented evidence');
  if exists(select 1 from public.b2c_recipients where wedding_id=wid and
    (account_review_confirmed_by is not null or account_review_confirmed_at is not null)) then
    raise exception 'Changed account-review evidence must revoke independent confirmation';
  end if;
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform pg_temp.b2c_reject(format('select public.staff_confirm_b2c_account_review(%L,''Synthetic renewed official statement review'')',wid),'matching documented');
  perform public.staff_confirm_b2c_account_review(wid,'Synthetic changed documented evidence');
  perform set_config('request.jwt.claim.sub',oid::text,true);
  second:=public.request_payout(wid,1000,'KES','Synthetic Owner self-request',true);
  perform pg_temp.b2c_reject(format('select public.admin_set_payout_status(%L,''approved'')',second),'Another staff');
  perform public.admin_set_payout_status(second,'cancelled','Synthetic independent approval required.');
  perform set_config('request.jwt.claim.sub',sid::text,true);
  update public.b2c_policy set utility_budget_minor=100;
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'')',payout,k,originator),'Insufficient');
  update public.b2c_policy set utility_budget_minor=200000;
  before_budget:=(select utility_budget_minor from public.b2c_policy);
  d:=public.b2c_reserve(payout,k,originator,repeat('a',64),'123456','BusinessPayment');
  if not (d->>'claimed')::boolean or public.b2c_available_minor(wid)<>89900 then raise exception 'Reservation and fee must reduce wallet balance'; end if;
  if (select utility_budget_minor from public.b2c_policy)<>before_budget-10100 then raise exception 'Utility budget must reserve amount and fee'; end if;
  perform pg_temp.b2c_reject(format('update public.b2c_dispatches set msisdn=''254700000002'' where id=%L',d->>'id'),'immutable');
  perform pg_temp.b2c_reject(format('select public.staff_reconcile_b2c(%L,''Synthetic self-review statement'',''inconclusive'',null,null,null)',d->>'id'),'Independent');
  perform set_config('request.jwt.claim.sub',other_staff::text,true);
  perform pg_temp.b2c_reject(format('select public.staff_reconcile_b2c(%L,''Synthetic same-role statement'',''inconclusive'',null,null,null)',d->>'id'),'opposite role');
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform public.assign_platform_role(sid,'client');
  perform pg_temp.b2c_reject(format('select public.staff_reconcile_b2c(%L,''Synthetic former-staff statement'',''inconclusive'',null,null,null)',d->>'id'),'opposite role');
  perform public.assign_platform_role(sid,'superadmin');
  perform set_config('request.jwt.claim.sub',sid::text,true);
  if (public.b2c_reserve(payout,extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat('b',64),'123456','BusinessPayment')->>'claimed')::boolean then
    raise exception 'Repeated payout must never acquire another send claim';
  end if;
  perform pg_temp.b2c_reject(format('select public.admin_set_payout_status(%L,''sent'')',payout),'Managed');
  perform set_config('request.jwt.claim.sub',cid::text,true);
  perform pg_temp.b2c_reject(format('select public.request_payout(%L,90000,''KES'',null,true)',wid),'exceeds');
  perform set_config('request.jwt.claim.role','service_role',true);
  state:=public.b2c_record_event((d->>'id')::uuid,'accepted','acceptance',
    jsonb_build_object('originator_id',originator,'conversation_id','SYNCONVERSATION'));
  if state<>'accepted' then raise exception 'Acceptance is not settlement'; end if;
  evidence:=jsonb_build_object('callback_hash',repeat('b',64),'originator_id',originator,'conversation_id','SYNCONVERSATION');
  perform pg_temp.b2c_reject(format('select public.b2c_record_event(%L,''timeout'',''forged'',%L::jsonb)',d->>'id',evidence),'uncorrelated');
  evidence:=jsonb_build_object('callback_hash',repeat('a',64),'originator_id',originator,'conversation_id','SYNCONVERSATION');
  state:=public.b2c_record_event((d->>'id')::uuid,'timeout','timeout',evidence);
  if state<>'uncertain' or (select status from public.payout_records where id=payout)<>'approved' then
    raise exception 'Timeout must keep reserved funds without cancelling or retrying'; end if;
  perform public.b2c_record_event((d->>'id')::uuid,'timeout','timeout',evidence);
  if (select count(*) from public.b2c_events where dispatch_id=(d->>'id')::uuid and event_key='timeout')<>1 then
    raise exception 'Duplicate callbacks must be idempotent'; end if;
  state:=public.b2c_record_event((d->>'id')::uuid,'reconciliation','status-query',
    jsonb_build_object('mechanism','transaction_status','verified_contract',true,'outcome','succeeded',
      'transaction_id','SYNTRANSFER','amount_minor',10000,'msisdn','254700000001'));
  if state<>'uncertain' then raise exception 'Status query is not proof of recipient and amount'; end if;
  -- Admission revocation must never stop already-bound reconciliation.
  perform set_config('request.jwt.claim.sub',oid::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  rev:=(select revision from public.b2c_policy);
  perform public.owner_update_b2c_policy(rev,'{"dispatch_enabled":false}','Synthetic emergency kill switch');
  state:=public.staff_reconcile_b2c((d->>'id')::uuid,'Synthetic independently reviewed official statement',
    'inconclusive',null,null,null);
  if state<>'uncertain' then raise exception 'Inconclusive review must retain holds'; end if;
  state:=public.staff_reconcile_b2c((d->>'id')::uuid,'Synthetic independently reviewed official statement',
    'succeeded','SYNTRANSFER','254700000001',10000);
  if state<>'succeeded' or (select status from public.payout_records where id=payout)<>'sent' then
    raise exception 'Independent verified statement must reconcile once even after revocation'; end if;
  if not exists(select 1 from public.audit_events where record_id=d->>'id' and action like 'b2c_reconciliation:%') then
    raise exception 'Reconciliation must be audited'; end if;

  -- Optional automation requires later explicit Owner limits and a separate runtime gate.
  rev:=(select revision from public.b2c_policy);
  perform pg_temp.b2c_reject(format($q$select public.owner_update_b2c_policy(%s,
    '{"auto_approval_limits":{"per_payout_minor":10000,"daily_minor":25000,"wedding_ids":[]}}',
    'Synthetic invalid scope attempt')$q$,rev),'Explicit');
  perform public.owner_update_b2c_policy(rev,jsonb_build_object('dispatch_enabled',true,'require_four_eyes',false,
    'auto_approval_limits',jsonb_build_object('per_payout_minor',10000,'daily_minor',25000,'wedding_ids',jsonb_build_array(wid))),
    'Synthetic explicit local auto-approval policy');
  perform set_config('request.jwt.claim.sub',cid::text,true);
  second:=public.request_payout(wid,10000,'KES','Synthetic optional automation fixture',true);
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'',false)',
    second,extensions.gen_random_uuid(),extensions.gen_random_uuid()),'Four-eyes');
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'',true)',
    second,k,extensions.gen_random_uuid()),'unique constraint');
  d:=public.b2c_reserve(second,extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat('c',64),'123456','BusinessPayment',true);
  if (select confirmed_by from public.payout_records where id=second)<>oid or
    not exists(select 1 from public.audit_events where record_id=second::text and action like 'payout_auto_approved:%') then
    raise exception 'Scoped auto-approval must bind audited Owner policy authority'; end if;
  perform set_config('request.jwt.claim.sub',cid::text,true);
  payout:=public.request_payout(wid,6000,'KES','Synthetic daily limit fixture',true);
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform pg_temp.b2c_reject(format('select public.b2c_reserve(%L,%L,%L,repeat(''d'',64),''123456'',''BusinessPayment'',true)',
    payout,extensions.gen_random_uuid(),extensions.gen_random_uuid()),'scope or limits');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.b2c_record_event((d->>'id')::uuid,'accepted','second-accept',
    jsonb_build_object('originator_id',d->>'originator_id','conversation_id','SYNSECOND'));
  evidence:=jsonb_build_object('callback_hash',repeat('c',64),'originator_id',d->>'originator_id',
    'conversation_id','SYNSECOND','verified_contract',true,'outcome','succeeded','transaction_id','SYNSECONDTRANSFER',
    'amount_minor',10000,'msisdn','254700000001');
  state:=public.b2c_record_event((d->>'id')::uuid,'result','second-result',evidence);
  if state<>'succeeded' then raise exception 'Authentic matched result should settle'; end if;
  perform public.b2c_record_event((d->>'id')::uuid,'result','second-result',evidence);
  if (select count(*) from public.b2c_events where dispatch_id=(d->>'id')::uuid and event_key='second-result')<>1 then
    raise exception 'Success duplicate must not settle twice'; end if;
  if (select count(*) from public.b2c_policy_history)<3 then raise exception 'Policy history must preserve exact old/new settings'; end if;
  -- A failed transfer releases principal only; its unknown outbound fee stays held.
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',sid::text,true);
  perform public.admin_set_payout_status(payout,'approved');
  d:=public.b2c_reserve(payout,extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat('e',64),'123456','BusinessPayment');
  before_budget:=public.b2c_available_minor(wid);
  perform set_config('request.jwt.claim.sub',oid::text,true);
  state:=public.staff_reconcile_b2c((d->>'id')::uuid,'Synthetic official failed principal statement',
    'failed','SYNFAILED','254700000001',6000);
  if state<>'failed' or public.b2c_available_minor(wid)<>before_budget+6000 then
    raise exception 'Failed principal must not release unverified provider fee'; end if;
end $$;
rollback;
