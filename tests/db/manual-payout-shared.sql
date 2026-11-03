-- Appended inside the existing readiness fixture; all synthetic, rollback-only.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
do $$ declare account uuid:=extensions.gen_random_uuid(); scope uuid; contribution uuid:=extensions.gen_random_uuid(); begin
  perform public.manual_payout_register_account(account,'daraja',extensions.gen_random_uuid(),pg_temp.evidence('account'));
  scope:=public.manual_payout_register_shared_account(account,'KES',pg_temp.evidence('custody'));
  insert into mr_ids values('shared_scope',scope),('shared_contribution',contribution);
  if exists(select 1 from public.manual_payout_statement_batches where custody_id=scope) or
    not exists(select 1 from public.manual_payout_custody where id=scope and available_minor is null and statement_at is null and shared_manual)
    or public.manual_payout_custody_snapshot(scope,true) is not null then
    raise exception 'Shared account fabricated a global bank balance or statement'; end if;
  perform pg_temp.reject(format('select public.manual_payout_register_shared_account(%L,''KES'',%L)',
    (select account_reference from public.manual_payout_custody where id=(select id from mr_ids where key='custody')),
    pg_temp.evidence('custody')),'unique constraint');
  perform pg_temp.reject(format('select public.manual_payout_attribute_settlement(%L,%L,extensions.gen_random_uuid(),20000,now(),%L)',
    (select id from mr_ids where key='contribution'),scope,pg_temp.evidence('settlement')),'already allocated');
end $$;
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,
  currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,provider_name,paid_at)
  values((select id from mr_ids where key='shared_contribution'),(select id from mr_ids where key='wedding'),
    'Synthetic shared Paybill attributable payment',10000,10000,0,10000,'KES','paid',true,false,100,'live','daraja',now()-interval '3 days');
set constraints all immediate;
alter table public.contributions enable trigger guard_payment_environment;
alter table public.contributions enable trigger guard_live_payment_context;
do $$ declare scope uuid:=(select id from mr_ids where key='shared_scope'); contribution uuid:=(select id from mr_ids where key='shared_contribution');
  e uuid:=pg_temp.evidence('settlement'); begin
  perform pg_temp.reject(format('select public.manual_payout_attribute_settlement(%L,%L,extensions.gen_random_uuid(),10000,now(),%L)',
    contribution,scope,e),'fee-known net');
  perform public.manual_payout_attribute_settlement(contribution,scope,extensions.gen_random_uuid(),9900,now(),e);
  perform pg_temp.reject(format('select public.manual_payout_register_settlement(%L,%L,extensions.gen_random_uuid(),9900,%L,null,now())',
    contribution,(select id from mr_ids where key='custody'),pg_temp.evidence('settlement')),'Only provider-verified');
  -- Direct inserts cannot credit the same contribution on another rail either.
  perform pg_temp.reject(format('insert into public.manual_payout_settlements
    select %L,%L,extensions.gen_random_uuid(),9900,%L,auth.uid(),id,now() from public.manual_payout_statement_batches where custody_id=%L limit 1',
    contribution,(select id from mr_ids where key='custody'),pg_temp.evidence('settlement'),
    (select id from mr_ids where key='custody')),'already allocated');
  perform pg_temp.policy(jsonb_build_object('enabled',false,'custody_id',scope,'statement_max_age_minutes',null,'daily_minor',12000));
  if public.manual_payout_readiness()->'blockers'<>'[]'::jsonb then raise exception 'Shared policy requires a global statement: %',public.manual_payout_readiness(); end if;
  perform pg_temp.policy('{"enabled":true}');
  -- The existing two paid WeddingSite requests (4200) reduce this new account's
  -- attributable 9900 net too; changing scopes never resets wedding commitments.
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_manual_eligible(%L,%L,%L,''KES'',5800,null,false)',
    (select id from mr_ids where key='wedding'),scope,(select id from mr_ids where key='recipient')),'Insufficient attributable');
end $$;
create function pg_temp.shared_request(solo boolean default false,amount bigint default 1000) returns uuid language plpgsql as $$
begin
  return public.manual_payout_request(extensions.gen_random_uuid(),(select id from mr_ids where key='wedding'),
    (select id from mr_ids where key='shared_scope'),(select id from mr_ids where key='recipient'),amount,100,'KES',solo);
end $$;
-- Normal review and one claim; exact independent transaction evidence only.
do $$ declare p uuid; receipt uuid; debit uuid; reconciliation uuid; booked timestamptz; begin
  perform pg_temp.actor('maker'); p:=pg_temp.shared_request();
  insert into mr_ids values('shared_normal',p);
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  perform pg_temp.actor('maker'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  perform public.manual_payout_transition(p,'uncertain');
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":false}');
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''cancelled'')',p),'Invalid');
  receipt:=public.manual_payout_submit_evidence('receipt',extensions.gen_random_uuid(),repeat('c',64));
  perform public.manual_payout_report(p,p::text,1000,100,'KES',clock_timestamp(),receipt);
  perform pg_temp.actor('checker'); perform public.manual_payout_check_evidence(receipt,false);
  debit:=pg_temp.evidence('statement'); reconciliation:=pg_temp.evidence('reconciliation'); booked:=clock_timestamp();
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.manual_payout_verify_transfer(%L,%L,1000,100,''KES'',%L,%L,%L)',
    p,p::text,booked,debit,reconciliation),'Independent');
  perform pg_temp.actor('checker');
  perform pg_temp.reject(format('select public.manual_payout_verify_transfer(%L,%L,1001,100,''KES'',%L,%L,%L)',
    p,p::text,booked,debit,reconciliation),'Exact transaction');
  if public.manual_payout_state(p)<>'reported' then raise exception 'Mismatch marked paid'; end if;
  perform public.manual_payout_verify_transfer(p,p::text,1000,100,'KES',booked,debit,reconciliation);
  perform public.manual_payout_verify_transfer(p,p::text,1000,100,'KES',booked,debit,reconciliation);
  if public.manual_payout_state(p)<>'paid' or not exists(select 1 from public.manual_payout_transfer_verifications where payout_id=p)
    or exists(select 1 from public.manual_payout_statement_debits where payout_id=p) then
    raise exception 'Exact shared payout evidence not atomic, or fabricated a bank statement'; end if;
end $$;
-- Explicit Owner solo also needs real distinct checked receipt/debit/reconciliation.
do $$ declare p uuid; receipt uuid; debit uuid; reconciliation uuid; begin
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":true}');
  p:=pg_temp.shared_request(true); insert into mr_ids values('shared_solo',p);
  perform public.manual_payout_transition(p,'approved'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  receipt:=pg_temp.evidence('receipt',true);
  perform public.manual_payout_report(p,p::text,1000,100,'KES',clock_timestamp(),receipt);
  debit:=pg_temp.evidence('statement',true); reconciliation:=pg_temp.evidence('reconciliation',true);
  perform public.manual_payout_verify_transfer(p,p::text,1000,100,'KES',clock_timestamp(),debit,reconciliation);
end $$;
-- Refund/fee/hold changes are rechecked, and other-system receipts are not input.
savepoint shared_refund;
update public.contributions set provider_fee_pending=true where id=(select id from mr_ids where key='shared_contribution');
select pg_temp.actor('owner');
select pg_temp.reject('select pg_temp.shared_request(true)','Insufficient attributable');
rollback to shared_refund;
savepoint shared_hold;
update public.contributions set funds_available_at=now()+interval '1 day' where id=(select id from mr_ids where key='shared_contribution');
select pg_temp.actor('owner');
select pg_temp.reject('select pg_temp.shared_request(true)','Insufficient attributable');
rollback to shared_hold;
set local role authenticated;
select pg_temp.actor('admin');
select pg_temp.reject(format('select public.manual_payout_register_shared_account(extensions.gen_random_uuid(),''KES'',extensions.gen_random_uuid())'),'SuperAdmin');
select pg_temp.reject('select public.manual_payout_attribute_settlement(extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),999999,now(),extensions.gen_random_uuid())','SuperAdmin');
select pg_temp.actor('client');
select pg_temp.reject('select public.manual_payout_verify_transfer(extensions.gen_random_uuid(),''OTHER-SYSTEM'',1000,0,''KES'',now(),extensions.gen_random_uuid(),extensions.gen_random_uuid())','Staff access required');
reset role;
-- Duplicate receipt from another request commits a hold; no alias scope or B2C bypass.
do $$ declare p uuid; e uuid; begin
  perform pg_temp.actor('owner'); p:=pg_temp.shared_request(true);
  perform public.manual_payout_transition(p,'approved'); perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  e:=pg_temp.evidence('receipt',true);
  if public.manual_payout_report(p,(select id::text from mr_ids where key='shared_normal'),1000,100,'KES',clock_timestamp(),e) then
    raise exception 'Duplicate receipt accepted'; end if;
  if not exists(select 1 from public.manual_payout_account_holds where custody_id=(select id from mr_ids where key='shared_scope'))
    or public.manual_payout_state(p)<>'executing' then raise exception 'Duplicate did not retain exposure and hold'; end if;
  perform pg_temp.policy('{"enabled":false}');
  if public.live_payouts_enabled() or exists((select to_jsonb(automatic_policy_row) from public.b2c_policy automatic_policy_row) except (select value from mr_automatic_before)) then
    raise exception 'Shared manual changed automatic policy'; end if;
end $$;
