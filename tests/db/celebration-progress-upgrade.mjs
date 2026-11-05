import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const migration = read("../../supabase/migrations/202611220001_celebration_progress.sql");
const [setup, assertions] = read("./celebration-progress.sql").split("-- Assertions (also run after a populated predecessor upgrade).");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
  encoding: "utf8",
  input: `${setup} commit;
    create temporary table cake_before(kind text, payload jsonb);
    create temporary table cake_functions as select oid, pg_get_functiondef(oid) definition, proacl::text grants
      from pg_proc where pronamespace='public'::regnamespace and prokind='f';
    do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
      execute format('insert into cake_before select %L,to_jsonb(x) from public.%I x',t,t);
    end loop; end $$;
    begin; ${migration} rollback;
    do $$ begin
      if to_regprocedure('public.get_public_celebration_progress(text)') is not null then
        raise exception 'Cake DDL rollback failed'; end if;
    end $$;
    begin; ${migration}
    insert into supabase_migrations.schema_migrations(version,name,statements)
      values('202611220001','celebration_progress',array[]::text[]);
    commit;
    do $$ declare t text; changed boolean; begin for t in select distinct kind from cake_before loop
      execute format('select exists((select payload from cake_before where kind=%L except select to_jsonb(x) from public.%I x)
        union all (select to_jsonb(x) from public.%I x except select payload from cake_before where kind=%L))',t,t,t,t) into changed;
      if changed then raise exception 'Historical % changed',t; end if;
    end loop;
    if exists(select 1 from cake_functions b join pg_proc p on p.oid=b.oid
      where b.definition is distinct from pg_get_functiondef(p.oid) or b.grants is distinct from p.proacl::text) then
      raise exception 'Existing function/accounting/financial contracts changed'; end if;
    end $$;
    begin; ${migration} ${assertions}`
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Populated cake aggregate upgrade/DDL rollback preserves all historical rows, grants and financial contracts; exactly-once/source/refund/currency/zero/over-goal assertions passed.");
