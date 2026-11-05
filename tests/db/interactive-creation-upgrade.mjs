import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const migration = readFileSync(new URL("../../supabase/migrations/202611210001_interactive_wedding_creation.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
  encoding: "utf8", input: `
create temporary table interactive_before(kind text,payload jsonb);
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into interactive_before select %L,to_jsonb(x) from public.%I x',t,t);
end loop; end $$;
begin; ${migration} rollback;
do $$ begin if exists(select 1 from information_schema.columns where table_schema='public' and table_name='weddings'
  and column_name='interactive_creation') then raise exception 'Interactive DDL did not roll back'; end if; end $$;
begin; ${migration}
insert into supabase_migrations.schema_migrations(version,name,statements)
  values('202611210001','interactive_wedding_creation',array[]::text[]);
commit;
do $$ declare t text; changed boolean; projection text; begin
for t in select distinct kind from interactive_before loop
  projection := case when t='weddings' then 'to_jsonb(x)-''interactive_creation''' else 'to_jsonb(x)' end;
  execute format('select exists((select payload from interactive_before where kind=%L except select %s from public.%I x)
    union all (select %s from public.%I x except select payload from interactive_before where kind=%L))',
    t,projection,t,projection,t,t) into changed;
  if changed then raise exception 'Historical % changed',t; end if;
end loop;
if exists(select 1 from public.weddings where interactive_creation) then
  raise exception 'Upgrade opted existing weddings into new behavior';
end if;
end $$;
`
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Interactive creation populated upgrade/DDL rollback preserves existing weddings, financial and policy rows.");
