import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Runs only against the isolated CI predecessor database, before its next reset.
function sql(input) {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
    "-d", "postgres", "--set", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
sql(`
begin;
insert into auth.users(id,email,email_confirmed_at)
  values('79000000-0000-4000-8000-000000000001','starter-upgrade@example.test',now());
insert into public.weddings(id,client_owner_id,slug,couple_names)
  values('79000000-0000-4000-8000-000000000002','79000000-0000-4000-8000-000000000001',
    'existing-private-starter-upgrade','Existing private draft');
commit;
create table public.starter_upgrade_weddings_before as select to_jsonb(w) as payload from public.weddings w;
create table public.starter_upgrade_venues_before as select to_jsonb(v) as payload from public.venues v;
create table public.starter_upgrade_featured_before as select to_jsonb(c) as payload from public.sponsor_featured_campaigns c;
`);
const migration = readFileSync(new URL("../../supabase/migrations/202611090001_wedding_starter_drafts.sql", import.meta.url), "utf8");
sql(`begin;\n${migration}
insert into supabase_migrations.schema_migrations(version,name,statements)
  values('202611090001','wedding_starter_drafts',array[]::text[]);
commit;
`);
sql(`
do $$ begin
  if exists(select 1 from public.starter_upgrade_weddings_before b full join public.weddings w
      on w.id=(b.payload->>'id')::uuid where to_jsonb(w) is distinct from b.payload) or
      exists(select 1 from public.starter_upgrade_venues_before b full join public.venues v
      on v.id=(b.payload->>'id')::uuid where to_jsonb(v) is distinct from b.payload) or
      exists(select 1 from public.starter_upgrade_featured_before b full join public.sponsor_featured_campaigns c
      on c.wedding_id=(b.payload->>'wedding_id')::uuid where to_jsonb(c) is distinct from b.payload) then
    raise exception 'Starter migration changed historical identities/content/financial/publication state or venues';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version='202611090001') <> 1 then
    raise exception 'Starter migration was not committed exactly once';
  end if;
  if exists(select 1 from public.wedding_starter_capability_proofs) then
    raise exception 'Migration fabricated starter readiness proofs';
  end if;
end $$;
`);
console.log("Starter migration committed on populated predecessor with all wedding/venue rows byte-for-byte unchanged.");
