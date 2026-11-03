import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611130001_manual_payout_readiness.sql", import.meta.url), "utf8");
function sql(input) {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
sql(`
  create table public.manual_readiness_before(kind text,payload jsonb);
  do $$ declare t text; begin
    for t in select tablename from pg_tables where schemaname='public' and
      (tablename like 'manual_payout_%' or tablename like 'b2c_%' or
        tablename in ('weddings','contributions','payout_records','expenses','platform_policies')) loop
      execute format('insert into public.manual_readiness_before select %L,to_jsonb(x) from public.%I x',t,t);
    end loop;
  end $$;
  create table public.manual_readiness_functions as select oid,pg_get_functiondef(oid) definition
    from pg_proc where pronamespace='public'::regnamespace and
      (proname like 'b2c_%' or proname in ('live_payouts_enabled','owner_update_b2c_policy','owner_get_b2c_policy'));
  begin; ${migration} rollback;
  do $$ begin
    if to_regclass('public.manual_payout_operating_policies') is not null then raise exception 'DDL rollback failed'; end if;
  end $$;
  begin; ${migration}
  insert into supabase_migrations.schema_migrations(version,name,statements)
    values('202611130001','manual_payout_readiness',array[]::text[]);
  commit;
  do $$ declare t text; changed boolean; begin
    for t in select distinct kind from public.manual_readiness_before loop
      execute format('select exists((select payload from public.manual_readiness_before where kind=%L except select to_jsonb(x) from public.%I x)
        union all (select to_jsonb(x) from public.%I x except select payload from public.manual_readiness_before where kind=%L))',t,t,t,t)
        into changed;
      if changed then raise exception 'Existing rows changed: %',t; end if;
    end loop;
    if exists(select 1 from public.manual_readiness_functions where pg_get_functiondef(oid) is distinct from definition)
      then raise exception 'Automatic/live behavior changed'; end if;
    if public.manual_payouts_enabled() or public.live_payouts_enabled() or
      (select count(*) from public.manual_payout_operating_policies)<>1 or
      exists(select 1 from public.manual_payout_operating_policies where enabled or actor_id is not null
        or custody_id is not null or per_payout_minor is not null or daily_minor is not null
        or payout_fee_minor is not null or statement_max_age_minutes is not null)
      or exists(select 1 from public.manual_payout_policy_bindings)
      then raise exception 'Upgrade enabled admission or fabricated policy choices'; end if;
  end $$;
`);
console.log("Manual readiness upgrade COMMIT/rollback preserves populated shared/B2C/finance rows and B2C functions; admission remains OFF.");
