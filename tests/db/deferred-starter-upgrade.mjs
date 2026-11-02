import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
function sql(input) {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
    "-d", "postgres", "--set", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
sql(`
create table public.deferred_upgrade_before as select id,to_jsonb(w) payload from public.weddings w;
create table public.deferred_readiness_before as select oid,pg_get_functiondef(oid) definition from pg_proc
  where pronamespace='public'::regnamespace and proname in
    ('wedding_missing_content','wedding_missing_publication_content','guard_wedding_publication_content');
begin;
${readFileSync(new URL("../../supabase/migrations/202611100002_deferred_wedding_starters.sql", import.meta.url), "utf8")}
insert into supabase_migrations.schema_migrations(version,name,statements)
  values('202611100002','deferred_wedding_starters',array[]::text[]);
commit;
do $$ begin
  if exists(select 1 from public.deferred_upgrade_before b full join public.weddings w on w.id=b.id
      where to_jsonb(w) is distinct from b.payload) or
      exists(select 1 from public.deferred_readiness_before b where pg_get_functiondef(b.oid) is distinct from b.definition) then
    raise exception 'Deferred migration changed existing wedding data or publication readiness contracts';
  end if;
  if exists(select 1 from public.wedding_starter_sources) or exists(select 1 from public.wedding_starter_reviews)
      or exists(select 1 from public.wedding_starter_pending) then
    raise exception 'Deferred migration fabricated source/review records';
  end if;
end $$;
`);
console.log("Deferred starter upgrade committed; historical weddings and readiness functions unchanged.");
