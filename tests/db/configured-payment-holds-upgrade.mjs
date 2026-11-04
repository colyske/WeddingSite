import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611180001_configured_payment_holds.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
create temporary table hold_before(kind text,payload jsonb);
create temporary table hold_functions as select oid,pg_get_functiondef(oid) definition,proacl::text grants from pg_proc
  where pronamespace='public'::regnamespace and (proname in ('live_payouts_enabled','manual_payouts_enabled','b2c_policy_require')
    or (proname='record_verified_payment' and pronargs<>8));
create temporary table hold_core as select oid,proacl::text grants from pg_proc
  where oid='public.record_verified_payment(text,text,uuid,bigint,text,text,bigint,timestamptz)'::regprocedure;
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into hold_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
do $$ declare definition text; crlf_pattern text; begin
  if (select encode(extensions.digest(replace(prosrc,chr(13),''),'sha256'),'hex') from pg_proc
    where oid='public.record_verified_payment(text,text,uuid,bigint,text,text,bigint,timestamptz)'::regprocedure)
    <>'e473cfbb2114df2fc5f679ccc65f5141b74f10d38301d73bc84b6e4036906290' then
    raise exception 'Populated predecessor differs from inspected deployed confirmation source'; end if;
  definition:=replace(pg_get_functiondef('public.record_verified_payment(text,text,uuid,bigint,text,text,bigint,timestamptz)'::regprocedure),chr(13),'');
  crlf_pattern:='select greatest(payout_hold_days, case when p_provider in (''paystack'', ''daraja'') then 3 else 0 end)'||chr(13)||chr(10)||
    '    into hold_days from public.platform_policies where id;';
  begin
    if position(crlf_pattern in definition)=0 then raise exception 'Unexpected verified-payment hold predecessor'; end if;
    raise exception 'Mixed-line-ending predecessor did not reproduce';
  exception when raise_exception then
    if sqlerrm<>'Unexpected verified-payment hold predecessor' or sqlstate<>'P0001' then raise; end if;
  end;
end $$;
begin; ${migration.replace(/\r?\n/g,"\r\n")} rollback;
do $$ begin if to_regprocedure('public.simple_payout_balance_details(uuid)') is not null then
  raise exception 'Rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values('202611180001','configured_payment_holds',array[]::text[]);
commit;
do $$ declare t text; changed boolean; begin
  for t in select distinct kind from hold_before loop
    execute format('select exists((select payload from hold_before where kind=%L except select to_jsonb(x) from public.%I x)
      union all (select to_jsonb(x) from public.%I x except select payload from hold_before where kind=%L))',t,t,t,t) into changed;
    if changed then raise exception 'Historical % changed',t; end if;
  end loop;
  if exists(select 1 from hold_functions b join pg_proc p on p.oid=b.oid
    where b.definition is distinct from pg_get_functiondef(p.oid) or b.grants is distinct from p.proacl::text)
    or exists(select 1 from hold_core b join pg_proc p on p.oid=b.oid where b.grants is distinct from p.proacl::text)
    or public.live_payouts_enabled() or public.manual_payouts_enabled() then
    raise exception 'Wrapper/grant/gate preservation failed'; end if;
end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Configured payment holds: populated full COMMIT/rollback preserves financial rows, stored dates, policies, overloads, grants and payout gates.");
