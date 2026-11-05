import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import "../../currencies.js";
import { publicWeddingStyle } from "../../server/wedding-style.js";
import { interactiveStarter } from "../../server/interactive-starter.js";

const style = await publicWeddingStyle("showcase-wedding");
const seed = interactiveStarter(globalThis.WSStarterSetup.normalize({ ...style.setup, reviewed: true }, "KES"));
const initializer = JSON.stringify({
  slug: "editorial-upgrade-check", coupleNames: "", currency: "KES", weddingDate: null,
  timeZone: "Africa/Nairobi", maxCapacity: 150, palette: style.palette, paletteNames: [],
  venues: seed.venues, starterSetup: seed.setup, starterDeferred: true, welcomeStory: seed.story, referral: null
}).replaceAll("'", "''");

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
  projection := case when t='weddings' then 'to_jsonb(x)-''interactive_creation''-''page_content''-''creation_content_reviewed''' else 'to_jsonb(x)' end;
  execute format('select exists((select payload from interactive_before where kind=%L except select %s from public.%I x)
    union all (select %s from public.%I x except select payload from interactive_before where kind=%L))',
    t,projection,t,projection,t,t) into changed;
  if changed then raise exception 'Historical % changed',t; end if;
end loop;
if exists(select 1 from public.weddings where interactive_creation) then
  raise exception 'Upgrade opted existing weddings into new behavior';
end if;
end $$;
begin;
do $$ declare uid uuid := extensions.gen_random_uuid(); request uuid := extensions.gen_random_uuid();
  payload jsonb := '${initializer}'::jsonb; result jsonb; w public.weddings; structure jsonb; blocked boolean := false;
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text||'@example.test',now());
  perform set_config('request.jwt.claim.sub',uid::text,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.stage_wedding_starter_source(uid,request,payload);
  perform set_config('request.jwt.claim.role','authenticated',true);
  result := public.create_interactive_wedding(request,payload);
  select * into w from public.weddings where id=(result->>'weddingId')::uuid;
  select setup into structure from public.wedding_starter_structures where wedding_id=w.id;
  if w.welcome_story is distinct from payload->>'welcomeStory' or w.couple_names<>'' or w.wedding_date is not null
    or w.creation_content_reviewed or w.travel_info is distinct from payload#>>'{starterSetup,content,travel}'
    or w.faq is distinct from payload#>'{starterSetup,content,faq}'
    or structure#>>'{registry,0,description}' is distinct from payload#>>'{starterSetup,registry,0,description}'
    or structure#>>'{tiers,0,perks}' is distinct from payload#>>'{starterSetup,tiers,0,perks}' then
    raise exception 'Initializer lost editorial content or inherited fundamentals';
  end if;
  if (select count(*) from public.venues where wedding_id=w.id)<>7 or exists(
    select 1 from public.venues where wedding_id=w.id and (event_date is not null or address not like 'Sample venue:%'))
    or (select count(*) from public.fundraising_milestones where wedding_id=w.id)<>2 then
    raise exception 'Initializer lost programme or milestone definitions';
  end if;
  perform public.save_wedding_content(w.id,'{"page_content":{"story:0":"Our saved heading","welcome:1":""}}');
  if (select page_content from public.weddings where id=w.id)<>'{"story:0":"Our saved heading","welcome:1":""}'::jsonb then
    raise exception 'Editorial save/reload lost replacements or deletions';
  end if;
  begin update public.weddings set published_at=now() where id=w.id;
  exception when raise_exception then blocked := sqlerrm like 'Replace sample venue details%'; end;
  if not blocked then raise exception 'Sample details bypassed publication review'; end if;
  if exists(select 1 from public.contributions where wedding_id=w.id)
    or exists(select 1 from public.guest_rsvps where wedding_id=w.id)
    or exists(select 1 from public.vip_offers where wedding_id=w.id) then
    raise exception 'Initializer fabricated financial, guest or seat inventory history';
  end if;
end $$;
rollback;
`
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Interactive creation populated upgrade/DDL rollback preserves existing weddings, financial and policy rows.");
