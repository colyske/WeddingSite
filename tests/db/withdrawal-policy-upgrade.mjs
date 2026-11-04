import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const migration=readFileSync(new URL("../../supabase/migrations/202611190001_couple_withdrawal_processing_fees.sql",import.meta.url),"utf8");
const result=spawnSync("docker",["exec","-i","supabase_db_weddingsite","psql","-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1"],{
  encoding:"utf8",input:`
create temporary table withdrawal_before(kind text,payload jsonb);
create temporary table withdrawal_functions as select oid,pg_get_functiondef(oid) definition,proacl::text grants from pg_proc
  where pronamespace='public'::regnamespace and proname in ('live_payouts_enabled','manual_payouts_enabled','record_verified_payment');
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into withdrawal_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
begin; ${migration} rollback;
do $$ begin if exists(select 1 from information_schema.columns where table_schema='public' and table_name='simple_payout_requests'
  and column_name='processing_fee_minor') then raise exception 'Rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values('202611190001','couple_withdrawal_processing_fees',array[]::text[]);
commit;
do $$ declare t text; changed boolean; extra text[]; begin for t in select distinct kind from withdrawal_before loop
  extra:=case when t='platform_policies' then array['withdrawal_processing_fee_minor','withdrawal_policy_revision']
    when t='simple_payout_requests' then array['processing_fee_minor','minimum_payout_minor','maximum_payout_minor','policy_revision','minimum_exception']
    else array[]::text[] end;
  execute format('select exists((select payload from withdrawal_before where kind=%L except select to_jsonb(x)-%L::text[] from public.%I x)
    union all (select to_jsonb(x)-%L::text[] from public.%I x except select payload from withdrawal_before where kind=%L))',t,extra,t,extra,t,t) into changed;
  if changed then raise exception 'Historical % changed',t; end if;
end loop;
if exists(select 1 from withdrawal_functions b join pg_proc p on p.oid=b.oid where b.definition is distinct from pg_get_functiondef(p.oid)
  or b.grants is distinct from p.proacl::text) or exists(select 1 from public.simple_payout_requests where processing_fee_minor is not null)
  or exists(select 1 from public.platform_policies where withdrawal_processing_fee_minor<>0 or withdrawal_policy_revision<>0)
  or to_regclass('public.owner_payment_fee_attestations') is not null then
  raise exception 'Upgrade repriced history, configured a charge, changed gates/confirmations or shipped obsolete attestations'; end if; end $$;
`});
if(result.error)throw result.error;
assert.equal(result.status,0,`${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Populated withdrawal-policy COMMIT/rollback preserves every historical contract/payment/policy/gate; new charge defaults zero, old snapshots stay NULL.");
