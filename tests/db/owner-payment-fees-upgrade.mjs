import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const migration = readFileSync(new URL("../../supabase/migrations/202611190001_owner_payment_fee_attestations.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
create temporary table fee_before(kind text,payload jsonb);
create temporary table fee_functions as select oid,pg_get_functiondef(oid) definition,proacl::text grants from pg_proc
  where pronamespace='public'::regnamespace and proname in ('live_payouts_enabled','manual_payouts_enabled','record_verified_payment');
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into fee_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
begin; ${migration} rollback;
do $$ begin if to_regclass('public.owner_payment_fee_attestations') is not null then raise exception 'Rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values('202611190001','owner_payment_fee_attestations',array[]::text[]);
commit;
do $$ declare t text; changed boolean; begin for t in select distinct kind from fee_before loop
  execute format('select exists((select payload from fee_before where kind=%L except select to_jsonb(x) from public.%I x)
    union all (select to_jsonb(x) from public.%I x except select payload from fee_before where kind=%L))',t,t,t,t) into changed;
  if changed then raise exception 'Historical % changed',t; end if;
end loop;
if exists(select 1 from fee_functions b join pg_proc p on p.oid=b.oid where b.definition is distinct from pg_get_functiondef(p.oid)
  or b.grants is distinct from p.proacl::text) or exists(select 1 from public.owner_payment_fee_attestations) then
  raise exception 'History/gates/confirmations/empty attestations changed'; end if; end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Owner fee upgrade full COMMIT/rollback preserves all payment rows, policies, stored dates, confirmation overloads and gates; no attestations seeded.");
