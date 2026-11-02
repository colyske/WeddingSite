-- Isolated local/CI only, at schema version 202611060002.
-- Place the migration alongside this file before running psql --file.
begin;

insert into auth.users(id, email, email_confirmed_at)
values ('61000000-0000-4000-8000-000000000091', 'publication-upgrade@example.test', now());
insert into public.weddings(id, client_owner_id, slug, couple_names, wedding_date, public_location)
values
  ('62000000-0000-4000-8000-000000000091', '61000000-0000-4000-8000-000000000091',
    'legacy-published-upgrade', 'Legacy published couple', current_date + 30, 'Sample city'),
  ('62000000-0000-4000-8000-000000000092', '61000000-0000-4000-8000-000000000091',
    'legacy-draft-upgrade', 'Legacy draft couple', null, null);
insert into public.venues(wedding_id, name, event_date, event_time, address)
values ('62000000-0000-4000-8000-000000000091', 'Legacy venue', current_date + 30, '12:00', 'Sample address');
update public.weddings set published_at = now()
where id = '62000000-0000-4000-8000-000000000091';
set constraints all immediate;
set constraints all deferred;

create temporary table upgrade_weddings_before as select to_jsonb(w) as payload from public.weddings w;

\ir 202611060003_guided_publication_minimum.sql

set constraints all immediate;
set constraints all deferred;
do $$
declare legacy public.weddings; draft public.weddings; missing text[]; blocked boolean := false;
begin
  select * into legacy from public.weddings where id = '62000000-0000-4000-8000-000000000091';
  select * into draft from public.weddings where id = '62000000-0000-4000-8000-000000000092';
  if legacy.published_at is null or legacy.publication_minimum_enforced
      or legacy.cover_image_url is not null or legacy.guest_instructions is not null then
    raise exception 'Upgrade must preserve published legacy weddings without fabricated new answers';
  end if;
  if draft.published_at is not null or not draft.publication_minimum_enforced then
    raise exception 'Existing drafts must retain the new publication minimum';
  end if;
  if exists (
    select 1 from upgrade_weddings_before b
    join public.weddings w on w.id = (b.payload->>'id')::uuid
    where to_jsonb(w) - array['cover_image_url','guest_instructions','publication_minimum_enforced','updated_at']
      is distinct from b.payload - 'updated_at'
  ) then raise exception 'Upgrade changed existing wedding answers or publication state'; end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.weddings'::regclass
      and tgname = 'saved_wedding_content' and tgdeferrable and tginitdeferred
  ) then raise exception 'Upgrade must preserve deferred wedding content validation'; end if;
  if public.get_public_wedding_site(legacy.slug)->>'id' is distinct from legacy.id::text then
    raise exception 'Existing published wedding must remain publicly readable';
  end if;
  missing := public.wedding_missing_publication_content(legacy);
  if not ('welcome-story' = any(missing) and 'cover-image-url' = any(missing)
      and 'guest-instructions' = any(missing) and 'fundraising-route' = any(missing)) then
    raise exception 'Legacy exemption must not relax the minimum for future publication';
  end if;
  update public.weddings set published_at = null where id = legacy.id;
  begin
    update public.weddings set published_at = now() where id = legacy.id;
  exception when raise_exception then blocked := sqlerrm like 'PUBLISH_INCOMPLETE:%';
  end;
  if not blocked then raise exception 'Legacy wedding republished without the new minimum'; end if;
  insert into public.weddings(client_owner_id, slug, couple_names)
    values ('61000000-0000-4000-8000-000000000091', 'new-upgrade-draft', 'New draft couple')
    returning * into draft;
  if not draft.publication_minimum_enforced then
    raise exception 'New drafts must enforce the new publication minimum';
  end if;
end $$;
set constraints all immediate;
rollback;
