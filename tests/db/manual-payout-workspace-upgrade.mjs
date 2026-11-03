import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611150001_manual_payout_operator_workspace.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
  "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
create temporary table mw_rows(kind text,payload jsonb);
create temporary table mw_functions as select oid,pg_get_functiondef(oid) definition from pg_proc
  where pronamespace='public'::regnamespace and (proname like 'manual_payout%' or proname like 'b2c_%' or proname like '%payout%policy%');
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and
    (tablename like 'manual_payout_%' or tablename like 'b2c_%' or tablename in ('weddings','contributions','payout_records','expenses')) loop
    execute format('insert into mw_rows select %L,to_jsonb(x) from public.%I x',t,t);
  end loop;
end $$;
begin; ${migration} rollback;
do $$ begin if to_regclass('public.manual_payout_intents') is not null or
  to_regprocedure('public.manual_payout_workspace()') is not null then raise exception 'Workspace rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements)
  values('202611150001','manual_payout_operator_workspace',array[]::text[]);
commit;
do $$ declare t text; changed boolean; begin
  for t in select distinct kind from mw_rows loop
    execute format('select exists((select payload from mw_rows where kind=%L except select to_jsonb(x) from public.%I x)
      union all (select to_jsonb(x) from public.%I x except select payload from mw_rows where kind=%L))',t,t,t,t) into changed;
    if changed then raise exception 'Workspace upgrade changed existing %',t; end if;
  end loop;
  if exists(select 1 from mw_functions where pg_get_functiondef(oid) is distinct from definition)
    or public.manual_payouts_enabled() or public.live_payouts_enabled()
    or exists(select 1 from public.manual_payout_intents)
    or exists(select 1 from public.manual_payout_intent_reviews) then
    raise exception 'Workspace upgrade changed policies/functions or fabricated requests'; end if;
end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
console.log("Operator workspace upgrade full COMMIT/rollback preserves all populated finance/B2C records and released function definitions; gates remain OFF.");
