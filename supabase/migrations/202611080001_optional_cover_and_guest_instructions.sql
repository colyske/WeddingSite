-- Cover photos and pre-RSVP guest instructions are optional for publication.
-- Only the shared minimum helper changes; no rows are updated, so no deferred
-- publication triggers are queued while this migration runs.
create or replace function public.wedding_missing_content(w public.weddings) returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare missing text[] := '{}';
begin
  if nullif(btrim(w.couple_names), '') is null then missing := array_append(missing, 'couple-names'); end if;
  if w.slug is null or w.slug !~ '^[a-z0-9-]{3,80}$' then missing := array_append(missing, 'wedding-slug'); end if;
  if w.wedding_date is null then missing := array_append(missing, 'wedding-date'); end if;
  if not exists (select 1 from public.venues v where v.wedding_id = w.id and v.kind <> 'pre')
      or exists (select 1 from public.venues v where v.wedding_id = w.id and
        (nullif(btrim(v.name), '') is null or v.event_date is null or v.event_time is null
          or nullif(btrim(v.address), '') is null)) then
    missing := array_append(missing, 'venues-section');
  end if;
  if nullif(btrim(w.welcome_story), '') is null then missing := array_append(missing, 'welcome-story'); end if;
  return missing;
end $$;
revoke all on function public.wedding_missing_content(public.weddings) from public, anon, authenticated;
