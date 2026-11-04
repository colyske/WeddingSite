import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611170001_simple_operator_payouts.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
create temporary table sp_before(kind text,payload jsonb);
create temporary table sp_gates as select oid,pg_get_functiondef(oid) definition from pg_proc
  where pronamespace='public'::regnamespace and proname in ('live_payouts_enabled','manual_payouts_enabled','b2c_policy_require');
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into sp_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
begin; ${migration} rollback;
do $$ begin if to_regclass('public.simple_payout_requests') is not null then raise exception 'Rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values('202611170001','simple_operator_payouts',array[]::text[]);
commit;
do $$ declare t text; changed boolean; begin
  for t in select distinct kind from sp_before loop
    execute format('select exists((select payload from sp_before where kind=%L except select to_jsonb(x) from public.%I x)
      union all (select to_jsonb(x) from public.%I x except select payload from sp_before where kind=%L))',t,t,t,t) into changed;
    if changed then raise exception 'Historical % changed',t; end if;
  end loop;
  if exists(select 1 from sp_gates where definition is distinct from pg_get_functiondef(oid))
    or exists(select 1 from public.simple_payout_requests) or public.live_payouts_enabled() or public.manual_payouts_enabled() then
    raise exception 'Gate/history/record preservation failed'; end if;
end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Simple operator upgrade full COMMIT/rollback preserves all predecessor records, roles, claims and gate functions; no live records or activation.");
