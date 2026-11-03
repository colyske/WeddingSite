-- Synthetic isolated DB only; exercises the deployed gate, never substitutes it.
begin;
create temporary table mr_ids(key text primary key,id uuid);
grant select on mr_ids to authenticated;
create function pg_temp.actor(k text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',(select id::text from mr_ids where key=k),true);
  perform set_config('request.jwt.claim.role','authenticated',true);
end $$;
create function pg_temp.reject(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Unexpected %; expected %',sqlerrm,expected; end if;
    return;
  end;
  raise exception 'Expected denial: %',statement;
end $$;
do $$
declare k text; v_id uuid; w uuid:=extensions.gen_random_uuid(); c uuid:=extensions.gen_random_uuid();
begin
  foreach k in array array['owner','maker','checker','admin','client'] loop
    v_id:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at)
      values(v_id,case when k='owner' then 'colyske@gmail.com' else v_id::text||'@example.test' end,now());
    if k='owner' then perform public.bootstrap_protected_owner(v_id);
    elsif k<>'client' then update public.profiles set platform_role=
      (case when k='admin' then 'admin' else 'superadmin' end)::public.platform_role where profiles.id=v_id; end if;
    insert into mr_ids values(k,v_id);
  end loop;
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(w,(select mr_ids.id from mr_ids where key='client'),'Isolated manual readiness','KES',current_date+30);
  insert into mr_ids values('wedding',w),('contribution',c);
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
    partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
    partner2_nationality,partner2_phone,partner2_email,consent_at)
    values(w,'Fixture One','passport','FIXTURE1','Kenyan','254700000001','one@example.test',
      'Fixture Two','passport','FIXTURE2','Kenyan','254700000002','two@example.test',now());
end $$;
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
  platform_fee_minor,net_paid_minor,currency,payment_status,verified_provider_payment,provider_fee_pending,
  provider_fee_minor,payment_environment,provider_name,paid_at)
  values((select id from mr_ids where key='contribution'),(select id from mr_ids where key='wedding'),
    'Isolated actual settlement',    20000,20000,0,20000,'KES','paid',true,false,0,'live','daraja',now()-interval '3 days');
set constraints all immediate;
alter table public.contributions enable trigger guard_payment_environment;
alter table public.contributions enable trigger guard_live_payment_context;
create temporary table mr_automatic_before as select to_jsonb(p) value from public.b2c_policy p;
create function pg_temp.evidence(kind text,solo boolean default false) returns uuid language plpgsql as $$
declare id uuid;
begin
  perform pg_temp.actor(case when kind='policy' or solo then 'owner' else 'maker' end);
  id:=public.manual_payout_submit_evidence(kind,extensions.gen_random_uuid(),
    encode(extensions.digest(extensions.gen_random_uuid()::text,'sha256'),'hex'));
  if not solo and kind<>'policy' then perform pg_temp.actor('checker'); end if;
  perform public.manual_payout_check_evidence(id,solo or kind='policy');
  perform pg_temp.actor('owner');
  return id;
end $$;
create function pg_temp.policy(changes jsonb) returns jsonb language plpgsql as $$
begin
  return public.owner_set_manual_payout_policy(
    (select revision from public.manual_payout_operating_policies order by sequence desc limit 1),changes,true);
end $$;
select pg_temp.actor('owner');
do $$
declare readiness jsonb;
begin
  readiness:=public.manual_payout_readiness();
  if public.manual_payouts_enabled() or public.live_payouts_enabled() or (readiness->'policy'->>'enabled')::boolean then
    raise exception 'Deployment enabled admission'; end if;
  perform pg_temp.reject('select pg_temp.policy(''{"enabled":true}''::jsonb)','prerequisites');
  perform pg_temp.reject('select pg_temp.policy(''{"enabled":false,"unknown":1}''::jsonb)','Unsupported');
end $$;
set local role authenticated;
select pg_temp.actor('admin');
select pg_temp.reject('select public.manual_payout_readiness()','SuperAdmin');
select pg_temp.reject('select public.manual_payout_submit_evidence(''recipient'',extensions.gen_random_uuid(),repeat(''a'',64))','SuperAdmin');
select pg_temp.actor('maker');
select pg_temp.reject('select public.owner_set_manual_payout_policy(extensions.gen_random_uuid(),''{"enabled":false}'',true)','authorized intake');
select pg_temp.reject('select public.manual_payout_request_foundation(extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),1000,0,''KES'',false)','permission denied');
reset role;
-- All preparation is usable OFF without crediting a fabricated bank balance.
do $$
declare account uuid:=extensions.gen_random_uuid(); custody uuid; recipient uuid; config jsonb; old uuid;
begin
  perform pg_temp.actor('owner');
  perform public.manual_payout_register_account(account,'daraja',extensions.gen_random_uuid(),pg_temp.evidence('account'));
  custody:=public.manual_payout_register_custody('daraja',account,'KES',20000,now()-interval '1 hour',pg_temp.evidence('custody'),0);
  recipient:=public.manual_payout_recipient((select id from mr_ids where key='wedding'),pg_temp.evidence('recipient'),'daraja','KES');
  perform public.manual_payout_register_settlement((select id from mr_ids where key='contribution'),custody,extensions.gen_random_uuid(),
    20000,pg_temp.evidence('settlement'),null,now()-interval '2 hours');
  insert into mr_ids values('custody',custody),('recipient',recipient);
  config:=jsonb_build_object('enabled',false,'custody_id',custody,'recipient_ids',jsonb_build_array(recipient),
    'per_payout_minor',10000,'daily_minor',12000,'payout_fee_minor',100,'fee_payer','wedding','statement_max_age_minutes',120,
    'review_evidence',pg_temp.evidence('policy'),'fee_evidence',pg_temp.evidence('policy'),
    'rail_evidence',pg_temp.evidence('policy'),'secure_evidence',pg_temp.evidence('policy'));
  perform pg_temp.policy(config);
  if public.manual_payouts_enabled() or (public.manual_payout_readiness()->'blockers')<>'[]'::jsonb then
    raise exception 'Reviewed draft should be ready but still OFF'; end if;
  perform pg_temp.reject('select pg_temp.policy(''{"enabled":true,"fee_payer":null}'')','prerequisites');
  perform pg_temp.reject('select pg_temp.policy(''{"enabled":true,"per_payout_minor":999999999}'')','prerequisites');
  perform pg_temp.reject(format('select public.manual_payout_request(extensions.gen_random_uuid(),%L,%L,%L,2000,100,''KES'')',
    (select id from mr_ids where key='wedding'),custody,recipient),'MANUAL_PAYOUT_BLOCKED');
  select revision into old from public.manual_payout_operating_policies order by sequence desc limit 1;
  perform pg_temp.policy('{"enabled":true}');
  perform pg_temp.reject(format('select public.owner_set_manual_payout_policy(%L,''{"enabled":false}'',true)',old),'CONFLICT');
  if not public.manual_payouts_enabled() then raise exception 'Real activation failed'; end if;
end $$;
create function pg_temp.request(p_key uuid default extensions.gen_random_uuid(),solo boolean default false,
  p_amount bigint default 2000,p_fee bigint default 100) returns uuid language plpgsql as $$
begin
  return public.manual_payout_request(p_key,(select id from mr_ids where key='wedding'),
    (select id from mr_ids where key='custody'),(select id from mr_ids where key='recipient'),p_amount,p_fee,'KES',solo);
end $$;
-- Normal two-person workflow, revoked reviewer, stale policy/fee/hold rechecks.
do $$
declare p uuid; key uuid:=extensions.gen_random_uuid();
begin
  perform pg_temp.actor('maker'); p:=pg_temp.request(key);
  if p<>pg_temp.request(key) then raise exception 'Request replay duplicated reservation'; end if;
  perform pg_temp.reject(format('select pg_temp.request(%L,false,2001)',key),'Idempotency');
  perform pg_temp.reject('select pg_temp.request(extensions.gen_random_uuid(),true)','Only protected Owner');
  perform pg_temp.reject('select pg_temp.request(extensions.gen_random_uuid(),false,2000,0)','scope');
  perform pg_temp.reject(format('select public.manual_payout_transition(%L,''approved'')',p),'different leader');
  perform pg_temp.actor('checker'); perform public.manual_payout_transition(p,'approved');
  insert into mr_ids values('normal',p);
end $$;
savepoint revoked_checker;
update public.profiles set platform_role='client' where id=(select id from mr_ids where key='checker');
select pg_temp.actor('maker');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mr_ids where key='normal')),'MANUAL_PAYOUT_BLOCKED');
rollback to revoked_checker;
savepoint held_contribution;
update public.contributions set funds_available_at=now()+interval '1 day' where id=(select id from mr_ids where key='contribution');
select pg_temp.actor('maker');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mr_ids where key='normal')),'Insufficient');
rollback to held_contribution;
-- Deliberate policy revision invalidates unclaimed approvals even when values match.
savepoint stale_policy;
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
select pg_temp.policy('{"enabled":true}');
select pg_temp.actor('maker');
select pg_temp.reject(format('select public.manual_payout_transition(%L,''executing'',extensions.gen_random_uuid())',
  (select id from mr_ids where key='normal')),'policy is stale');
select public.manual_payout_transition((select id from mr_ids where key='normal'),'cancelled');
rollback to stale_policy;
-- Freshness is required at approval/claim; it is not settlement proof.
savepoint stale_statement;
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false,"statement_max_age_minutes":1}');
select pg_temp.reject('select pg_temp.policy(''{"enabled":true}'')','prerequisites');
rollback to stale_statement;

-- A report and exact independent statement reconciliation remain available OFF.
create function pg_temp.finish(p uuid,solo boolean) returns void language plpgsql as $$
declare e uuid; at_report timestamptz; at_debit timestamptz; b uuid; statement uuid:=extensions.gen_random_uuid();
  line uuid:=extensions.gen_random_uuid(); prior public.manual_payout_statement_batches; r public.manual_payout_requests;
  actor text:=case when solo then 'owner' else 'maker' end; checker text:=case when solo then 'owner' else 'checker' end;
begin
  select * into strict r from public.manual_payout_requests where id=p;
  perform pg_temp.actor(actor);
  at_report:=clock_timestamp();
  e:=public.manual_payout_submit_evidence('receipt',extensions.gen_random_uuid(),repeat('9',64));
  perform public.manual_payout_report(p,p::text,r.amount_minor,r.fee_minor,'KES',at_report,e);
  perform pg_temp.actor(checker); perform public.manual_payout_check_evidence(e,solo);
  e:=pg_temp.evidence('statement',solo); at_debit:=clock_timestamp();
  select * into strict prior from public.manual_payout_statement_batches where custody_id=r.custody_id order by sequence desc limit 1;
  b:=public.manual_payout_append_statement(r.custody_id,prior.id,statement,clock_timestamp(),prior.closing_minor,0,
    r.amount_minor+r.fee_minor,prior.closing_minor-r.amount_minor-r.fee_minor,0,e);
  perform public.manual_payout_register_statement_debit(b,line,p::text,r.amount_minor,r.fee_minor,'KES',at_debit,e);
  e:=pg_temp.evidence('reconciliation',solo);
  perform pg_temp.actor(actor);
  if not solo then perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,%L,%L,%L,%s,%s,''KES'',%L,%L)',
    p,(select account_reference from public.manual_payout_custody where id=r.custody_id),statement,line,p::text,r.amount_minor,r.fee_minor,at_debit,e),'Independent'); end if;
  perform pg_temp.actor(checker);
  perform pg_temp.reject(format('select public.manual_payout_reconcile(%L,''daraja'',%L,extensions.gen_random_uuid(),%L,%L,%s,%s,''KES'',%L,%L)',
    p,(select account_reference from public.manual_payout_custody where id=r.custody_id),line,p::text,r.amount_minor,r.fee_minor,at_debit,e),'Registered statement');
  perform public.manual_payout_reconcile(p,'daraja',(select account_reference from public.manual_payout_custody where id=r.custody_id),
    statement,line,p::text,r.amount_minor,r.fee_minor,'KES',at_debit,e);
  if public.manual_payout_state(p)<>'paid' or not exists(select 1 from public.manual_payout_statement_debits where payout_id=p) then
    raise exception 'Missing atomic reconciled debit'; end if;
end $$;
select pg_temp.actor('maker');
select public.manual_payout_transition((select id from mr_ids where key='normal'),'executing',extensions.gen_random_uuid());
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false}');
select pg_temp.actor('maker');
select pg_temp.reject('select pg_temp.request()','MANUAL_PAYOUT_BLOCKED');
select public.manual_payout_transition((select id from mr_ids where key='normal'),'uncertain');
select pg_temp.actor('owner');
select pg_temp.reject('select pg_temp.policy(''{"enabled":true}'')','prerequisites');
select pg_temp.actor('client');
do $$ begin
  if public.manual_payout_state((select id from mr_ids where key='normal'))<>'uncertain'
    or (public.manual_payout_balance((select id from mr_ids where key='wedding'))->>'reserved_minor')::bigint<>2100 then
    raise exception 'Uncertain reservation not retained after deactivation'; end if;
end $$;
select pg_temp.finish((select id from mr_ids where key='normal'),false);

-- Protected Owner solo retains distinct receipt/statement/reconciliation evidence.
do $$
declare p uuid;
begin
  perform pg_temp.actor('owner'); perform pg_temp.policy('{"enabled":true}');
  p:=pg_temp.request(extensions.gen_random_uuid(),true);
  perform public.manual_payout_transition(p,'approved');
  perform public.manual_payout_transition(p,'executing',extensions.gen_random_uuid());
  perform pg_temp.policy('{"enabled":false}');
  perform pg_temp.finish(p,true);
  if exists(select 1 from public.manual_payout_events where payout_id=p and not owner_solo)
    or (select count(distinct actor_id) from public.manual_payout_events where payout_id=p)<>1 then
    raise exception 'Solo actor audit lost'; end if;
  if (select count(distinct id) from public.manual_payout_evidence
      where id in (select evidence_id from public.manual_payout_receipts where payout_id=p
        union select evidence_id from public.manual_payout_reconciliations where payout_id=p))<>2 then
    raise exception 'Solo reconciliation reused receipt evidence'; end if;
end $$;
-- Admission respects the aggregate cap including paid and unresolved commitments.
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":true}');
select pg_temp.actor('maker');
-- The last statement was Owner self-checked for solo processing. A normal
-- request must not silently inherit that evidence exception.
select pg_temp.reject('select pg_temp.request()','Accepted current custody statement');
select pg_temp.actor('checker');
select public.manual_payout_check_evidence((select evidence_id from public.manual_payout_statement_batches
  where custody_id=(select id from mr_ids where key='custody') order by sequence desc limit 1));
select pg_temp.actor('maker');
select public.manual_payout_transition(pg_temp.request(),'cancelled');
select pg_temp.actor('owner');
select pg_temp.policy('{"enabled":false,"daily_minor":10000,"per_payout_minor":10000}');
select pg_temp.policy('{"enabled":true}');
select pg_temp.reject('select pg_temp.request(extensions.gen_random_uuid(),true,6000,100)','UTC-day total');
do $$ begin
  if exists((select to_jsonb(p) from public.b2c_policy p) except (select value from mr_automatic_before))
    or public.live_payouts_enabled() then raise exception 'Manual configuration changed automatic gate/policy'; end if;
  if (select enabled from public.manual_payout_policy where singleton) then raise exception 'Historical baseline modified'; end if;
end $$;
rollback;
