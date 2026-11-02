import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Isolated CI database only. The workflow resets it before and after this test.
const container = "supabase_db_weddingsite";
const migrations = new URL("../../supabase/migrations/", import.meta.url);
const filename = "202611060003_guided_publication_minimum.sql";
const failedRelease = "e28ca522275bbdcfde33c7ebfd0a222769fd1436";
function sql(input) {
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "--set", "ON_ERROR_STOP=1"], { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function succeeds(input) {
  const result = sql(input);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
function applyMigration(name, source) {
  const version = name.split("_")[0];
  return `begin;\n${source}\ninsert into supabase_migrations.schema_migrations(version,name,statements)
    values ('${version}','${name.slice(version.length + 1, -4)}',array[]::text[]);\ncommit;\n`;
}

// These historical published rows predate the venue-completeness triggers in 050001.
succeeds(`
begin;
insert into auth.users(id,email,email_confirmed_at)
  values ('61000000-0000-4000-8000-000000000091','publication-upgrade@example.test',now());
insert into public.weddings(id,client_owner_id,slug,couple_names,wedding_date,public_location,published_at)
values
  ('62000000-0000-4000-8000-000000000091','61000000-0000-4000-8000-000000000091',
    'legacy-no-venues','Legacy no venues',current_date+30,'Sample city',now()),
  ('62000000-0000-4000-8000-000000000092','61000000-0000-4000-8000-000000000091',
    'legacy-partial-venue','Legacy partial venue',current_date+30,'Sample city',now()),
  ('62000000-0000-4000-8000-000000000093','61000000-0000-4000-8000-000000000091',
    'legacy-complete-venue','Legacy complete venue',current_date+30,'Sample city',now());
insert into public.venues(wedding_id,name,event_date,event_time,address) values
  ('62000000-0000-4000-8000-000000000092','Partial venue',null,null,''),
  ('62000000-0000-4000-8000-000000000093','Complete venue',current_date+30,'12:00','Sample address');
commit;
`);
for (const name of ["202611050001_guided_wedding_drafts.sql", "202611060001_amount_ranked_sponsors.sql",
  "202611060002_revenue_feature_controls.sql"]) {
  succeeds(applyMigration(name, readFileSync(new URL(name, migrations), "utf8")));
}
succeeds(`
begin;
insert into public.weddings(id,client_owner_id,slug,couple_names)
  values ('62000000-0000-4000-8000-000000000094','61000000-0000-4000-8000-000000000091',
    'legacy-incomplete-draft','Legacy incomplete draft');
commit;
create table public.guided_upgrade_weddings_before as select to_jsonb(w) as payload from public.weddings w;
create table public.guided_upgrade_venues_before as select to_jsonb(v) as payload from public.venues v;
`);
const broken = execFileSync("git", ["show", `${failedRelease}:supabase/migrations/${filename}`], { encoding: "utf8" });
const failed = sql(applyMigration(filename, broken));
assert.notEqual(failed.status, 0, "the failed release must reproduce the populated-upgrade failure");
assert.match(failed.stderr, /PUBLISH_INCOMPLETE:.*venues-section/);
succeeds(`
do $$ begin
  if exists(select 1 from supabase_migrations.schema_migrations where version='202611060003')
      or to_regclass('public.wedding_collection_capabilities') is not null
      or exists(select 1 from information_schema.columns where table_schema='public' and table_name='weddings'
        and column_name in ('cover_image_url','guest_instructions','publication_minimum_enforced'))
      or to_regprocedure('public.wedding_missing_legacy_content(public.weddings)') is not null
      or to_regprocedure('public.get_public_wedding_site_before_guided_minimum(text)') is not null then
    raise exception 'Failed migration did not completely roll back schema and migration history';
  end if;
  if exists(select 1 from public.guided_upgrade_weddings_before b join public.weddings w
      on w.id=(b.payload->>'id')::uuid where to_jsonb(w) is distinct from b.payload) then
    raise exception 'Failed migration changed existing wedding data';
  end if;
end $$;
`);
console.log("Reproduced failed-release commit error and verified complete transaction rollback.");

succeeds(applyMigration(filename, readFileSync(new URL(filename, migrations), "utf8")));
succeeds(`
begin;
do $$
declare legacy public.weddings; draft public.weddings; missing text[]; blocked boolean;
begin
  if (select count(*) from supabase_migrations.schema_migrations where version='202611060003') <> 1 then
    raise exception 'Successful committed upgrade must record exactly one migration';
  end if;
  if exists(select 1 from public.guided_upgrade_weddings_before b join public.weddings w
      on w.id=(b.payload->>'id')::uuid
      where to_jsonb(w)-array['cover_image_url','guest_instructions','publication_minimum_enforced']
        is distinct from b.payload) or exists (
    select 1 from public.guided_upgrade_venues_before b join public.venues v
      on v.id=(b.payload->>'id')::uuid where to_jsonb(v) is distinct from b.payload
  ) then raise exception 'Upgrade changed existing answers, timestamps, venues or publication state'; end if;
  if exists(select 1 from public.weddings
      where publication_minimum_enforced or cover_image_url is not null or guest_instructions is not null) then
    raise exception 'Existing rows must inherit legacy marker without fabricated answers';
  end if;
  for legacy in select * from public.weddings where published_at is not null loop
    if public.get_public_wedding_site(legacy.slug)->>'id' is distinct from legacy.id::text then
      raise exception 'Every legacy wedding must remain publicly readable';
    end if;
    missing := public.wedding_missing_publication_content(legacy);
    if not ('welcome-story'=any(missing) and 'cover-image-url'=any(missing)
        and 'guest-instructions'=any(missing) and 'fundraising-route'=any(missing)) then
      raise exception 'Legacy marker relaxed future publication minimum';
    end if;
  end loop;
  blocked := false;
  begin
    update public.weddings set welcome_story='Updated legacy story'
      where id='62000000-0000-4000-8000-000000000091';
    set constraints saved_wedding_content immediate;
  exception when raise_exception then blocked := sqlerrm like 'PUBLISH_INCOMPLETE:%';
  end;
  if not blocked then raise exception 'Legacy incomplete content edit bypassed existing saved-content checks'; end if;
  set constraints saved_wedding_content deferred;
  update public.weddings set published_at=null where id='62000000-0000-4000-8000-000000000093';
  blocked := false;
  begin
    update public.weddings set published_at=now() where id='62000000-0000-4000-8000-000000000093';
  exception when raise_exception then blocked := sqlerrm like 'PUBLISH_INCOMPLETE:%';
  end;
  if not blocked then raise exception 'Legacy republishing bypassed the new minimum'; end if;
  insert into public.weddings(client_owner_id,slug,couple_names)
    values ('61000000-0000-4000-8000-000000000091','new-upgrade-draft','New draft couple')
    returning * into draft;
  if not draft.publication_minimum_enforced then raise exception 'New drafts must enforce the minimum'; end if;
  blocked := false;
  begin
    update public.weddings set publication_minimum_enforced=false where id=draft.id;
  exception when raise_exception then blocked := sqlerrm like 'Publication minimum enforcement cannot%';
  end;
  if not blocked then raise exception 'Direct marker downgrade was accepted'; end if;
  blocked := false;
  begin
    insert into public.weddings(client_owner_id,slug,couple_names,publication_minimum_enforced)
      values ('61000000-0000-4000-8000-000000000091','null-marker-draft','Null marker draft',null);
  exception when raise_exception then blocked := sqlerrm like 'New weddings must enforce%';
  end;
  if not blocked then raise exception 'Explicit null marker was accepted'; end if;
  select * into draft from public.weddings where id='62000000-0000-4000-8000-000000000094';
  update public.weddings set wedding_date=current_date+30,welcome_story='We look forward to celebrating.',
    cover_image_url='https://example.test/celebration.jpg',guest_instructions='Please RSVP before the celebration.'
    where id=draft.id;
  insert into public.venues(wedding_id,name,event_date,event_time,address)
    values (draft.id,'New venue',current_date+30,'12:00','Sample address');
  insert into public.wedding_collection_capabilities(wedding_id,provider,currency,market)
    values (draft.id,'stripe',draft.currency,'US');
  update public.weddings set published_at=now() where id=draft.id;
  if not (select publication_minimum_enforced from public.weddings where id=draft.id) then
    raise exception 'Existing draft did not acquire strict marker on first publication';
  end if;
end $$;
set constraints all immediate;
rollback;
`);
console.log("Committed corrected migration and verified historical shapes, draft defaults, publication guards and immutable markers.");
