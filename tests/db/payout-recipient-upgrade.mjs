import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const migration = read("../../supabase/migrations/202611200001_payout_recipient_confirmation.sql");
const fixture = read("./manual-payout-readiness.sql").replace(/rollback;\s*$/, () => `
do $$ declare w uuid:=(select id from mr_ids where key='wedding'); p uuid; kind text;
begin
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"min_payout_minor":1000,"max_payout_minor":10000}');
  foreach kind in array array['legacy_proven','legacy_changed','legacy_claimed_unknown'] loop
    insert into public.simple_payout_requests(request_key,wedding_id,requested_by,amount_minor,currency,partner_slot,kyc_hash)
      values(extensions.gen_random_uuid(),w,(select id from mr_ids where key='client'),1000,'KES',1,
        case when kind='legacy_proven' then public.simple_payout_kyc_hash(w) else repeat('0',64) end) returning id into p;
    insert into public.simple_payout_events(payout_id,action_key,state,actor_id)
      values(p,extensions.gen_random_uuid(),'requested',(select id from mr_ids where key='client'));
    if kind='legacy_claimed_unknown' then
      insert into public.simple_payout_claims values(p,extensions.gen_random_uuid(),(select id from mr_ids where key='owner'),
        (select id from mr_ids where key='owner'),true,0,'daraja',clock_timestamp());
      insert into public.simple_payout_events(payout_id,action_key,state,actor_id)
        values(p,extensions.gen_random_uuid(),'processing',(select id from mr_ids where key='owner'));
    end if;
    insert into mr_ids values(kind,p);
  end loop;
end $$;
commit;`);
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
  { encoding: "utf8", input: fixture + `
create temporary table recipient_before(kind text,payload jsonb);
create temporary table recipient_functions as select oid,pg_get_functiondef(oid) definition,proacl::text grants from pg_proc
  where pronamespace='public'::regnamespace and proname in ('live_payouts_enabled','manual_payouts_enabled','record_verified_payment','simple_payout_balance_raw');
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into recipient_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
begin; ${migration} rollback;
do $$ begin if to_regclass('public.simple_payout_recipients') is not null then raise exception 'Recipient DDL rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values('202611200001','payout_recipient_confirmation',array[]::text[]);
commit;
do $$ declare t text; changed boolean; begin for t in select distinct kind from recipient_before loop
  execute format('select exists((select payload from recipient_before where kind=%L except select to_jsonb(x) from public.%I x)
    union all (select to_jsonb(x) from public.%I x except select payload from recipient_before where kind=%L))',t,t,t,t) into changed;
  if changed then raise exception 'Historical % changed',t; end if;
end loop;
if exists(select 1 from recipient_functions b join pg_proc p on p.oid=b.oid where b.definition is distinct from pg_get_functiondef(p.oid)
  or b.grants is distinct from p.proacl::text) or exists(select 1 from public.simple_payout_recipients) then
  raise exception 'Upgrade rewrote history, gates/accounting or guessed legacy identity'; end if; end $$;
begin;
select pg_temp.actor('owner');
do $$ declare p uuid:=(select id from mr_ids where key='legacy_proven'); detail jsonb; unknown uuid:=(select id from mr_ids where key='legacy_claimed_unknown');
begin
  detail:=public.simple_payout_recipient(p);
  if detail->>'expected_name'<>'Fixture One' or detail->>'phone'<>'254700000001'
    or detail->>'source'<>'unchanged_legacy_kyc' then raise exception 'Exact unchanged hash failed original proof'; end if;
  perform public.simple_payout_action(p,extensions.gen_random_uuid(),'reviewed',null,null,null,false,true,true);
  if not exists(select 1 from public.simple_payout_recipients where payout_id=p and source='unchanged_legacy_kyc') then
    raise exception 'Original checked legacy recipient not frozen'; end if;
  update public.wedding_kyc set partner1_phone='254722222222' where wedding_id=(select id from mr_ids where key='wedding');
  if public.simple_payout_recipient(p) is distinct from detail then raise exception 'Checked legacy destination changed'; end if;
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''processing'',null,0,null,true,true,true)',
    (select id from mr_ids where key='legacy_changed')),'Original recipient cannot be established');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''paid'',null,null,''UNKNOWN-DESTINATION'',false,true,true)',unknown),
    'Original recipient cannot be established');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''cancelled'',null,null,null,false,false,true)',unknown),
    'Processing has already been claimed');
  perform public.simple_payout_action(unknown,extensions.gen_random_uuid(),'hold','outcome_uncertain',null,null,false,false,true);
  if public.simple_payout_recipient(unknown) is not null or public.simple_payout_state(unknown)<>'hold'
    or not exists(select 1 from public.simple_payout_claims where payout_id=unknown)
    or exists(select 1 from public.simple_payout_receipts where payout_id=unknown) then raise exception 'Unknown legacy transfer guessed/released'; end if;
end $$;
rollback;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Populated recipient migration COMMIT/rollback preserves all historical rows/gates/accounting; unchanged legacy proof freezes, unknown legacy sends/Paid block and retain claims on Hold.");
