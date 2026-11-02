-- Isolated synthetic shared-ledger fixtures only. No provider, no retained rows.
begin;
create function pg_temp.b2c_reject(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Wrong rejection [%]: %',expected,sqlerrm; end if;
    return;
  end;
  raise exception 'Expected rejection: %',statement;
end $$;
create function pg_temp.b2c_evidence(kind text,submitter uuid,checker uuid) returns uuid language plpgsql as $$
declare result uuid; previous text:=current_setting('request.jwt.claim.sub',true);
begin
  perform set_config('request.jwt.claim.sub',submitter::text,true);
  result:=(public.b2c_intake('evidence',jsonb_build_object('kind',kind,'reference',extensions.gen_random_uuid(),
    'sha256',encode(extensions.digest(extensions.gen_random_uuid()::text,'sha256'),'hex')))->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',checker::text,true);
  perform public.b2c_intake('check',jsonb_build_object('evidence',result));
  perform set_config('request.jwt.claim.sub',previous,true);
  return result;
end $$;
create function pg_temp.b2c_reconcile(dispatch uuid,receipt uuid,evidence uuid,account uuid,statement uuid,line uuid,fee bigint,at_time timestamptz)
returns text language sql as $$
  select public.b2c_reconcile(dispatch,receipt,evidence,'daraja',account,statement,line,'SYNRECEIPT',
    10000,fee,'KES','254700000001',at_time,at_time)
$$;
do $$
declare owner_id uuid:=extensions.gen_random_uuid(); staff_id uuid:=extensions.gen_random_uuid();
  client_id uuid:=extensions.gen_random_uuid(); wid uuid:=extensions.gen_random_uuid();
  contribution uuid:=extensions.gen_random_uuid(); recipient uuid; custody uuid; evidence uuid;
  funding uuid; contract uuid; payout uuid; key uuid:=extensions.gen_random_uuid(); result jsonb;
  dispatch uuid; second uuid; third uuid; receipt_evidence uuid; paid_evidence uuid; receipt_at timestamptz;
  account uuid:=extensions.gen_random_uuid(); statement uuid:=extensions.gen_random_uuid(); line uuid:=extensions.gen_random_uuid();
  next_batch uuid; next_contribution uuid; next_at timestamptz;
  outcome text; wrong_account uuid; wrong_custody uuid; wrong_statement uuid; wrong_batch uuid;
begin
  if exists(select 1 from public.b2c_policy where enabled or not require_four_eyes or per_payout_minor is not null
    or daily_minor is not null or payout_fee_minor is not null or cardinality(custody_ids)>0 or cardinality(recipient_ids)>0) then
    raise exception 'B2C defaults must be OFF, two-person, without limits or recipients';
  end if;
  if has_table_privilege('service_role','public.manual_payout_claims','INSERT')
    or has_table_privilege('authenticated','public.b2c_destinations','INSERT')
    or has_function_privilege('service_role','public.b2c_policy_require(uuid,uuid,bigint,bigint)','EXECUTE') then
    raise exception 'No raw service or recipient/policy bypass permitted';
  end if;
  insert into auth.users(id,email,email_confirmed_at) values(owner_id,'colyske@gmail.com',now());
  perform public.bootstrap_protected_owner(owner_id);
  insert into auth.users(id) values(staff_id);
  insert into auth.users(id,phone,phone_confirmed_at) values(client_id,'254700000001',now());
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.assign_platform_role(staff_id,'superadmin');
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wid,client_id,'Synthetic automated payout','KES',current_date+30);
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,client_id,'client') on conflict do nothing;
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
    partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
    partner2_nationality,partner2_phone,partner2_email,consent_at)
    values(wid,'Synthetic One','passport','SYN1','Kenyan','254700000001','one@example.test',
      'Synthetic Two','passport','SYN2','Kenyan','254700000002','two@example.test',now());
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10000)',key,wid,extensions.gen_random_uuid(),extensions.gen_random_uuid()),'Couple account');
  evidence:=pg_temp.b2c_evidence('recipient',owner_id,staff_id);
  recipient:=(public.b2c_intake('recipient',jsonb_build_object('wedding',wid,'evidence',evidence,
    'msisdn','254700000001','partner',1))->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10000)',
    key,wid,extensions.gen_random_uuid(),recipient),'Dispatch OFF');
  update auth.users set phone_confirmed_at=null where id=client_id;
  perform pg_temp.b2c_reject(format('select public.b2c_bind_destination(%L)',recipient),'Verified current phone');
  update auth.users set phone_confirmed_at=now() where id=client_id;
  update auth.users set phone='254700000002' where id=client_id;
  perform pg_temp.b2c_reject(format('select public.b2c_bind_destination(%L)',recipient),'Verified current phone');
  update auth.users set phone='254700000001' where id=client_id;
  perform public.b2c_bind_destination(recipient);
  perform public.b2c_bind_destination(recipient);
  perform public.b2c_phone_start(wid,'254700000001');
  perform pg_temp.b2c_reject(format('select public.b2c_phone_start(%L,''254700000001'')',wid),'rate limit');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  funding:=pg_temp.b2c_evidence('policy',owner_id,staff_id);
  contract:=pg_temp.b2c_evidence('policy',owner_id,staff_id);
  evidence:=pg_temp.b2c_evidence('account',owner_id,staff_id);
  perform public.b2c_intake('account',jsonb_build_object('account',account,'registry',extensions.gen_random_uuid(),'evidence',evidence));
  evidence:=pg_temp.b2c_evidence('custody',owner_id,staff_id);
  custody:=(public.b2c_intake('custody',jsonb_build_object('account',account,
    'availableMinor',100000,'heldMinor',0,'statementAt',now(),'evidence',evidence,
    'fundingEvidence',funding,'shortcode','123456','disbursableCollectedFunds',true))->>'id')::uuid;
  -- Synthetic receipt admission bypasses collection guards only in this rollback.
  alter table public.contributions disable trigger guard_payment_environment;
  alter table public.contributions disable trigger guard_live_payment_context;
  alter table public.contributions disable trigger guard_paystack_context;
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,
    net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,
    payment_environment,provider_name,paid_at)
    values(contribution,wid,'Synthetic settled collection',100000,100000,0,100000,'KES','paid',true,false,0,'live','daraja',now()-interval '1 day');
  evidence:=pg_temp.b2c_evidence('settlement',owner_id,staff_id);
  update public.contributions set payment_environment='test' where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''settlement'',%L::jsonb)',
    jsonb_build_object('contribution',contribution,'custody',custody,'settledMinor',100000,
      'line',extensions.gen_random_uuid(),'evidence',evidence,'at',now()-interval '1 hour')),'Only provider-verified');
  update public.contributions set payment_environment='live',provider_fee_pending=true where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''settlement'',%L::jsonb)',
    jsonb_build_object('contribution',contribution,'custody',custody,'settledMinor',100000,
      'line',extensions.gen_random_uuid(),'evidence',evidence,'at',now()-interval '1 hour')),'Only provider-verified');
  update public.contributions set provider_fee_pending=false,provider_name='paystack' where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''settlement'',%L::jsonb)',
    jsonb_build_object('contribution',contribution,'custody',custody,'settledMinor',100000,
      'line',extensions.gen_random_uuid(),'evidence',evidence,'at',now()-interval '1 hour')),'Only provider-verified');
  update public.contributions set provider_name='daraja' where id=contribution;
  update public.contributions set provider_name='paystack',settlement_route='paystack_direct' where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''settlement'',%L::jsonb)',
    jsonb_build_object('contribution',contribution,'custody',custody,'settledMinor',100000,
      'line',extensions.gen_random_uuid(),'evidence',evidence,'at',now()-interval '1 hour')),'Only provider-verified');
  update public.contributions set provider_name='daraja',settlement_route='platform_wallet' where id=contribution;
  perform public.b2c_intake('settlement',jsonb_build_object('contribution',contribution,'custody',custody,
    'settledMinor',100000,'line',extensions.gen_random_uuid(),'evidence',evidence,'at',now()-interval '1 hour'));
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"enabled":true}','Synthetic staff attempt')$q$,'Owner');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"require_four_eyes":false}','Synthetic missing limits')$q$,'check constraint');
  perform public.owner_update_b2c_policy(1,jsonb_build_object('enabled',true,'custody_ids',jsonb_build_array(custody),
    'recipient_ids',jsonb_build_array(recipient),'per_payout_minor',50000,'daily_minor',60000,'payout_fee_minor',100,
    'statement_max_age_minutes',60,'shortcode','123456','command_id','BusinessPayment',
    'contract_reference',contract,'funding_reference',funding),'Synthetic local-only reviewed policy');
  perform pg_temp.b2c_reject($q$select public.owner_update_b2c_policy(1,'{"enabled":false}','Synthetic stale revision')$q$,'revision');
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  update public.contributions set funds_available_at=now()+interval '1 day' where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10000)',key,wid,custody,recipient),'Insufficient');
  update public.contributions set funds_available_at=null,provider_fee_pending=true where id=contribution;
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10000)',key,wid,custody,recipient),'Insufficient');
  update public.contributions set provider_fee_pending=false where id=contribution;
  payout:=public.b2c_request(key,wid,custody,recipient,10000);
  if public.b2c_request(key,wid,custody,recipient,10000)<>payout then raise exception 'Request key must be idempotent'; end if;
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10100)',key,wid,custody,recipient),'Idempotency');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.b2c_reject(format('select public.b2c_claim(%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'',true)',payout,key),'Four-eyes');
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.staff_approve_b2c(payout);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.staff_approve_b2c(payout);
  perform set_config('request.jwt.claim.role','service_role',true);
  update auth.users set phone='254700000002' where id=client_id;
  perform pg_temp.b2c_reject(format('select public.b2c_claim(%L,%L,repeat(''a'',64),''123456'',''BusinessPayment'',false)',payout,key),'Destination control');
  update auth.users set phone='254700000001' where id=client_id;
  result:=public.b2c_claim(payout,key,repeat('a',64),'123456','BusinessPayment',false);
  dispatch:=(result->>'id')::uuid;
  if not (result->>'claimed')::boolean or public.manual_payout_state(payout)<>'executing' then raise exception 'Must durably claim before send'; end if;
  if (public.b2c_claim(payout,extensions.gen_random_uuid(),repeat('b',64),'123456','BusinessPayment',false)->>'claimed')::boolean then
    raise exception 'Claim must never repeat';
  end if;
  if public.b2c_callback_context(dispatch,repeat('b',64)) is not null then raise exception 'Forged capability must fail'; end if;
  perform public.b2c_event(dispatch,repeat('a',64),'accepted',repeat('c',64),'{"conversation_id":"CONV-1","originator_id":"ORIGIN-1"}');
  if public.manual_payout_state(payout)<>'executing' then raise exception 'Acceptance must not settle'; end if;
  perform pg_temp.b2c_reject(format('select public.b2c_event(%L,repeat(''a'',64),''result'',repeat(''d'',64),''{"conversation_id":"OTHER","originator_id":"ORIGIN-1"}'')',dispatch),'uncorrelated');
  perform public.b2c_event(dispatch,repeat('a',64),'timeout',repeat('d',64),'{"reason":"synthetic"}');
  perform public.b2c_event(dispatch,repeat('a',64),'timeout',repeat('d',64),'{"reason":"synthetic"}');
  if public.manual_payout_state(payout)<>'uncertain' or (select count(*) from public.b2c_callback_events where dispatch_id=dispatch and kind='timeout')<>1 then
    raise exception 'Timeout must retain reservation idempotently';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.b2c_reject(format('select public.b2c_cancel(%L)',payout),'cannot be cancelled');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.b2c_event(dispatch,repeat('a',64),'result',repeat('e',64),
    '{"conversation_id":"CONV-1","originator_id":"ORIGIN-1","result_code":"0","transaction_id":"SYNRECEIPT"}');
  if public.manual_payout_state(payout)<>'uncertain' then raise exception 'Even successful callback must not bypass independent final reconciliation'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,90000)',extensions.gen_random_uuid(),wid,custody,recipient),'outside explicit');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_update_b2c_policy(2,'{"enabled":false}','Synthetic kill switch after claim');
  receipt_evidence:=pg_temp.b2c_evidence('receipt',owner_id,staff_id);
  paid_evidence:=pg_temp.b2c_evidence('reconciliation',owner_id,staff_id);
  receipt_at:=clock_timestamp();
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,paid_evidence,account,statement,line,receipt_at),'Independent final');
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  -- No fabricated statement/line may certify paid; the complete transaction,
  -- including its proposed reported receipt, must roll back on missing evidence.
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,paid_evidence,account,statement,line,receipt_at),'Registered statement batch');
  if public.manual_payout_state(payout)<>'uncertain'
    or exists(select 1 from public.manual_payout_receipts where payout_id=payout) then
    raise exception 'Missing observed debit must roll back every paid/report write'; end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  evidence:=pg_temp.b2c_evidence('statement',owner_id,staff_id);
  next_batch:=(public.b2c_intake('statement',jsonb_build_object('custody',custody,
    'previous',(public.manual_payout_custody_snapshot(custody)->>'batch_id')::uuid,
    'statement',statement,'at',clock_timestamp(),'opening',100000,'credit',0,'debit',10100,
    'closing',89900,'held',0,'evidence',evidence))->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,paid_evidence,account,statement,line,receipt_at),'Exact registered statement debit');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.b2c_intake('statement-debit',jsonb_build_object('batch',next_batch,'line',line,
    'reference','SYNRECEIPT','actual',10000,'fee',100,'currency','KES','at',receipt_at,'evidence',evidence));
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''statement-debit'',%L::jsonb)',
    jsonb_build_object('batch',next_batch,'line',line,'reference','SYNRECEIPT','actual',10000,'fee',100,
      'currency','KES','at',receipt_at,'evidence',evidence)),'must be unique');
  perform pg_temp.b2c_reject(format('select public.b2c_intake(''statement-debit'',%L::jsonb)',
    jsonb_build_object('batch',next_batch,'line',extensions.gen_random_uuid(),'reference','SYNOVER','actual',1,'fee',0,
      'currency','KES','at',receipt_at,'evidence',evidence)),'Statement debit capacity exceeded');
  begin
    wrong_account:=extensions.gen_random_uuid();
    wrong_statement:=extensions.gen_random_uuid();
    evidence:=pg_temp.b2c_evidence('account',owner_id,staff_id);
    perform public.b2c_intake('account',jsonb_build_object('account',wrong_account,
      'registry',extensions.gen_random_uuid(),'evidence',evidence));
    evidence:=pg_temp.b2c_evidence('custody',owner_id,staff_id);
    wrong_custody:=(public.b2c_intake('custody',jsonb_build_object('account',wrong_account,
      'availableMinor',100000,'heldMinor',0,'statementAt',now(),'evidence',evidence,
      'fundingEvidence',funding,'shortcode','123456','disbursableCollectedFunds',true))->>'id')::uuid;
    evidence:=pg_temp.b2c_evidence('statement',owner_id,staff_id);
    wrong_batch:=(public.b2c_intake('statement',jsonb_build_object('custody',wrong_custody,
      'previous',(public.manual_payout_custody_snapshot(wrong_custody)->>'batch_id')::uuid,
      'statement',wrong_statement,'at',clock_timestamp(),'opening',100000,'credit',0,'debit',10100,
      'closing',89900,'held',0,'evidence',evidence))->>'id')::uuid;
    perform public.b2c_intake('statement-debit',jsonb_build_object('batch',wrong_batch,'line',line,
      'reference','SYNRECEIPT','actual',10000,'fee',100,'currency','KES','at',receipt_at,'evidence',evidence));
    perform set_config('request.jwt.claim.sub',staff_id::text,true);
    perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
      dispatch,receipt_evidence,paid_evidence,account,wrong_statement,line,receipt_at),'Registered statement batch');
    raise exception using errcode='P9999',message='Rollback unrelated account fixture';
  exception when sqlstate 'P9999' then null;
  end;
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,paid_evidence,account,statement,extensions.gen_random_uuid(),receipt_at),'Exact registered statement debit');
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,paid_evidence,account,statement,line,receipt_at+interval '1 microsecond'),'Exact registered statement debit');
  if public.manual_payout_state(payout)<>'uncertain'
    or exists(select 1 from public.manual_payout_receipts where payout_id=payout)
    or exists(select 1 from public.manual_payout_reconciliations where payout_id=payout)
    or exists(select 1 from public.manual_payout_statement_debits where payout_id=payout) then
    raise exception 'Rejected registered-debit finalization must be atomic, without reported or paid fragments'; end if;
  begin
    outcome:=pg_temp.b2c_reconcile(dispatch,receipt_evidence,paid_evidence,account,statement,line,0,receipt_at);
    if outcome is distinct from 'account_held'
      or not exists(select 1 from public.manual_payout_account_holds where payout_id=payout) then
      raise exception 'Mismatched automatic statement evidence must commit an account hold'; end if;
    raise exception using errcode='P9999',message='Rollback synthetic mismatch regression';
  exception when sqlstate 'P9999' then null;
  end;
  perform pg_temp.b2c_reject(format('select pg_temp.b2c_reconcile(%L,%L,%L,%L,%L,%L,100,%L)',
    dispatch,receipt_evidence,receipt_evidence,account,statement,line,receipt_at),'Independently checked');
  perform pg_temp.b2c_reconcile(dispatch,receipt_evidence,paid_evidence,account,statement,line,100,receipt_at);
  perform pg_temp.b2c_reconcile(dispatch,receipt_evidence,paid_evidence,account,statement,line,100,receipt_at);
  if not exists(select 1 from public.manual_payout_reconciliations where payout_id=payout and statement_reference=statement
    and line_reference=line and not owner_solo) then raise exception 'Separate immutable exact statement debit required'; end if;
  if not exists(select 1 from public.manual_payout_statement_debits d
    join public.manual_payout_reconciliations r on r.payout_id=d.payout_id
    join public.manual_payout_statement_debit_entries e on e.id=r.statement_entry_id
    where d.payout_id=payout and d.batch_id=next_batch and d.line_reference=line
      and e.batch_id=next_batch and e.line_reference=line) then
    raise exception 'Paid must already have consumed the exact registered statement debit atomically'; end if;
  if public.manual_payout_state(payout)<>'paid' then raise exception 'Independent exact evidence must settle even after admission stop'; end if;
  -- Automated approval is explicit Owner policy, not manual Owner-solo permission.
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_update_b2c_policy(3,'{"enabled":true,"require_four_eyes":false}','Synthetic explicit auto approval');
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  second:=public.b2c_request(extensions.gen_random_uuid(),wid,custody,recipient,20000);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.b2c_reject(format('select public.b2c_claim(%L,%L,repeat(''b'',64),''123456'',''BusinessPayment'',false)',second,extensions.gen_random_uuid()),'Four-eyes');
  result:=public.b2c_claim(second,extensions.gen_random_uuid(),repeat('b',64),'123456','BusinessPayment',true);
  if not (result->>'claimed')::boolean or not exists(select 1 from public.audit_events where record_id=second::text and action like 'auto_approved_policy_%') then
    raise exception 'Automatic approval must audit exact policy authority';
  end if;
  if (select count(*) from public.b2c_policy_history)<>3 then raise exception 'Policy revision history missing'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  third:=public.b2c_request(extensions.gen_random_uuid(),wid,custody,recipient,10000);
  perform set_config('request.jwt.claim.role','service_role',true);
  result:=public.b2c_claim(third,extensions.gen_random_uuid(),repeat('c',64),'123456','BusinessPayment',true);
  dispatch:=(result->>'id')::uuid;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  evidence:=pg_temp.b2c_evidence('no_transfer',owner_id,staff_id);
  perform pg_temp.b2c_reject(format('select public.b2c_resolve(%L,%L,false,null)',dispatch,evidence),'zero-charge');
  perform public.b2c_resolve(dispatch,evidence,false,0);
  perform pg_temp.b2c_reject(format('select public.b2c_resolve(%L,%L,true,0)',dispatch,evidence),'different independent');
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  perform public.b2c_resolve(dispatch,evidence,true,0);
  perform set_config('request.jwt.claim.role','service_role',true);
  if (public.b2c_claim(third,extensions.gen_random_uuid(),repeat('d',64),'123456','BusinessPayment',true)->>'claimed')::boolean
    then raise exception 'No-transfer decision must never resend an existing claim'; end if;
  if current_setting('b2c.test_concurrency',true) is distinct from 'on' then
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',owner_id::text,true);
    next_contribution:=extensions.gen_random_uuid();
    next_at:=clock_timestamp();
    insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,
      net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,
      payment_environment,provider_name,paid_at)
      values(next_contribution,wid,'Synthetic subsequent collected funds',50000,50000,0,50000,'KES',
        'paid',true,false,0,'live','daraja',next_at);
    evidence:=pg_temp.b2c_evidence('statement',owner_id,staff_id);
    next_batch:=(public.b2c_intake('statement',jsonb_build_object('custody',custody,
      'previous',(public.manual_payout_custody_snapshot(custody)->>'batch_id')::uuid,
      'statement',extensions.gen_random_uuid(),'at',clock_timestamp(),'opening',89900,'credit',50000,'debit',0,
      'closing',139900,'held',0,'evidence',evidence))->>'id')::uuid;
    evidence:=pg_temp.b2c_evidence('settlement',owner_id,staff_id);
    perform public.b2c_intake('settlement',jsonb_build_object('contribution',next_contribution,'custody',custody,
      'settledMinor',50000,'line',extensions.gen_random_uuid(),'evidence',evidence,'batch',next_batch,'at',next_at));
    if (public.manual_payout_custody_snapshot(custody)->>'available_minor')::bigint<>139900 then
      raise exception 'Subsequent statement snapshot not used';
    end if;
    perform set_config('request.jwt.claim.sub',client_id::text,true);
    third:=public.b2c_request(extensions.gen_random_uuid(),wid,custody,recipient,50000);
    perform public.b2c_cancel(third);
    perform public.b2c_cancel(third);
    if public.manual_payout_state(third)<>'cancelled' then raise exception 'Only unclaimed cancellation may release'; end if;
    perform set_config('request.jwt.claim.role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    if public.b2c_event(dispatch,repeat('c',64),'uncertain',repeat('f',64),
      '{"reason":"late_provider_observation_after_no_transfer"}')<>'account_held' then
      raise exception 'Late terminal evidence must commit shared incident hold';
    end if;
    perform public.b2c_event(dispatch,repeat('c',64),'uncertain',repeat('f',64),
      '{"reason":"late_provider_observation_after_no_transfer"}');
    if (select count(*) from public.manual_payout_account_holds where custody_id=custody)<>1 then
      raise exception 'Duplicate callback must not duplicate shared incident hold';
    end if;
    perform set_config('request.jwt.claim.role','authenticated',true);
    perform set_config('request.jwt.claim.sub',client_id::text,true);
    perform pg_temp.b2c_reject(format('select public.b2c_request(%L,%L,%L,%L,10000)',
      extensions.gen_random_uuid(),wid,custody,recipient),'Held custody account');
    perform set_config('request.jwt.claim.sub',owner_id::text,true);
    perform pg_temp.b2c_reject(format('select public.manual_payout_eligible(%L,%L,%L,''KES'',10000,null,true)',
      wid,custody,recipient),'Held custody account');
  end if;
  if current_setting('b2c.test_concurrency',true)='on' then
    insert into public.b2c_ci_context(data) values(jsonb_build_object('owner',owner_id,'staff',staff_id,
      'client',client_id,'wedding',wid,'custody',custody,'account',account,'recipient',recipient,'existing',second));
  end if;
  alter table public.contributions enable trigger guard_payment_environment;
  alter table public.contributions enable trigger guard_live_payment_context;
  alter table public.contributions enable trigger guard_paystack_context;
end $$;
set local role authenticated;
select pg_temp.b2c_reject(
  'select public.b2c_claim(extensions.gen_random_uuid(),extensions.gen_random_uuid(),repeat(''a'',64),''123456'',''BusinessPayment'',true)',
  'permission denied');
select pg_temp.b2c_reject('select * from public.b2c_destinations','permission denied');
select pg_temp.b2c_reject('select public.manual_payout_register_account_internal(extensions.gen_random_uuid(),''daraja'',extensions.gen_random_uuid(),extensions.gen_random_uuid(),false)','permission denied');
reset role;
set local role service_role;
select pg_temp.b2c_reject('select public.owner_update_b2c_policy(1,''{}'',''Synthetic service bypass'')','permission denied');
select pg_temp.b2c_reject('select public.b2c_intake(''evidence'',''{}'')','permission denied');
select pg_temp.b2c_reject('select * from public.manual_payout_claims','permission denied');
reset role;
set local role anon;
select pg_temp.b2c_reject('select public.b2c_status()','permission denied');
reset role;
rollback;
