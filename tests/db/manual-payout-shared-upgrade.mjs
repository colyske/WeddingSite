import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611160001_manual_shared_account_attribution.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: `
create temporary table ms_rows(kind text,payload jsonb);
create temporary table ms_b2c as select oid,pg_get_functiondef(oid) definition from pg_proc
  where pronamespace='public'::regnamespace and (proname like 'b2c_%' or proname in
    ('manual_payout_eligible','manual_payout_custody_snapshot','manual_payout_finalize_reconciliation_internal',
     'manual_payout_register_settlement_internal','manual_payout_register_statement_debit_internal'));
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' and
    (tablename like 'manual_payout_%' or tablename like 'b2c_%' or
     tablename in ('weddings','contributions','payout_records','expenses','platform_policies','profiles')) loop
    execute format('insert into ms_rows select %L,to_jsonb(x) from public.%I x',t,t);
  end loop;
end $$;
begin; ${migration} rollback;
do $$ begin if to_regclass('public.manual_payout_attributed_settlements') is not null or
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='manual_payout_custody'
    and column_name='shared_manual') then raise exception 'Shared mode rollback failed'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements)
  values('202611160001','manual_shared_account_attribution',array[]::text[]);
commit;
do $$ declare t text; changed boolean; expression text; begin
  for t in select distinct kind from ms_rows loop
    expression:=case when t='manual_payout_custody' then 'to_jsonb(x)-''shared_manual''' else 'to_jsonb(x)' end;
    execute format('select exists((select payload from ms_rows where kind=%L except select %s from public.%I x)
      union all (select %s from public.%I x except select payload from ms_rows where kind=%L))',t,expression,t,expression,t,t) into changed;
    if changed then raise exception 'Shared upgrade rewrote historical %',t; end if;
  end loop;
  if exists(select 1 from ms_b2c where pg_get_functiondef(oid) is distinct from definition)
    or public.manual_payouts_enabled() or public.live_payouts_enabled()
    or exists(select 1 from public.manual_payout_custody where shared_manual)
    or exists(select 1 from public.manual_payout_attributed_settlements)
    or exists(select 1 from public.manual_payout_transfer_verifications) then
    raise exception 'Upgrade enabled/converted/fabricated records or changed shared/B2C financial contracts'; end if;
end $$;
` });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-5000)}`);
console.log("Shared-account upgrade COMMIT/rollback: historic records preserved, no scope converted, no gates/roles changed; B2C/shared statement contracts identical.");
