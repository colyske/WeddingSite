alter table public.weddings
  add column if not exists cover_image_url text,
  add column if not exists guest_instructions text,
  add column if not exists publication_minimum_enforced boolean not null default true;

update public.weddings set publication_minimum_enforced = false where published_at is not null;

alter table public.weddings drop constraint if exists weddings_cover_image_url_check;
alter table public.weddings add constraint weddings_cover_image_url_check check (
  cover_image_url is null or (
    length(cover_image_url) <= 2048 and cover_image_url ~ '^https://[^[:space:]<>"]+$'
  )
);
alter table public.weddings drop constraint if exists weddings_guest_instructions_check;
alter table public.weddings add constraint weddings_guest_instructions_check check (
  guest_instructions is null or length(guest_instructions) <= 1000
);

create table if not exists public.wedding_collection_capabilities (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  provider text not null check (provider in ('stripe','paystack','daraja')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  market text not null check (market ~ '^[A-Z]{2}$'),
  checked_at timestamptz not null default now(),
  primary key (wedding_id, provider, currency, market)
);
alter table public.wedding_collection_capabilities enable row level security;
revoke all on public.wedding_collection_capabilities from public, anon, authenticated;
grant select, insert, update, delete on public.wedding_collection_capabilities to service_role;

create or replace function public.replace_wedding_collection_capabilities(p_wedding_id uuid, p_routes jsonb)
returns void language plpgsql security definer set search_path = '' set row_security = off
as $$
declare route jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_wedding_id is null or
      p_routes is null or jsonb_typeof(p_routes) <> 'array' or jsonb_array_length(p_routes) > 90 then
    raise exception 'Invalid collection capability snapshot.';
  end if;
  perform 1 from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  delete from public.wedding_collection_capabilities where wedding_id = p_wedding_id;
  for route in select value from jsonb_array_elements(p_routes) loop
    if route->>'provider' not in ('stripe','paystack','daraja')
       or coalesce(route->>'currency','') !~ '^[A-Z]{3}$'
       or coalesce(route->>'market','') !~ '^[A-Z]{2}$' then
      raise exception 'Invalid collection capability route.';
    end if;
    insert into public.wedding_collection_capabilities(wedding_id, provider, currency, market)
      values (p_wedding_id, route->>'provider', route->>'currency', route->>'market')
      on conflict (wedding_id, provider, currency, market) do update set checked_at = now();
  end loop;
end $$;
revoke all on function public.replace_wedding_collection_capabilities(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_wedding_collection_capabilities(uuid,jsonb) to service_role;

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
  if w.cover_image_url is null or w.cover_image_url !~ '^https://[^[:space:]<>"]+$' then
    missing := array_append(missing, 'cover-image-url');
  end if;
  if nullif(btrim(w.guest_instructions), '') is null then missing := array_append(missing, 'guest-instructions'); end if;
  return missing;
end $$;
revoke all on function public.wedding_missing_content(public.weddings) from public, anon, authenticated;

create function public.wedding_missing_legacy_content(w public.weddings) returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare missing text[] := '{}';
begin
  if nullif(btrim(w.couple_names), '') is null then missing := array_append(missing, 'couple-names'); end if;
  if w.slug is null or w.slug !~ '^[a-z0-9-]{3,80}$' then missing := array_append(missing, 'wedding-slug'); end if;
  if w.wedding_date is null then missing := array_append(missing, 'wedding-date'); end if;
  if nullif(btrim(w.public_location), '') is null then missing := array_append(missing, 'location'); end if;
  if not exists (select 1 from public.venues v where v.wedding_id = w.id and v.kind <> 'pre')
      or exists (select 1 from public.venues v where v.wedding_id = w.id and
        (nullif(btrim(v.name), '') is null or v.event_date is null or v.event_time is null
          or nullif(btrim(v.address), '') is null)) then
    missing := array_append(missing, 'venues-section');
  end if;
  return missing;
end $$;
revoke all on function public.wedding_missing_legacy_content(public.weddings) from public, anon, authenticated;

create or replace function public.wedding_missing_publication_content(w public.weddings) returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare missing text[] := public.wedding_missing_content(w); has_fundraising_route boolean;
begin
  select exists (
    select 1
    from public.wedding_collection_capabilities c
    join public.platform_policies p on p.id
    where c.wedding_id = w.id and c.currency = w.currency
      and c.checked_at > now() - interval '2 minutes'
      and c.provider = any(p.enabled_payment_providers)
  ) and (
    (coalesce((w.revenue_features->>'giving')::boolean, false) and (
      exists (select 1 from public.registry_items r where r.wedding_id = w.id)
      or exists (select 1 from public.fundraising_streams f where f.wedding_id = w.id and f.enabled)
    ))
    or (coalesce((w.revenue_features->>'sponsors')::boolean, false)
      and exists (select 1 from public.sponsor_tiers t where t.wedding_id = w.id))
    or (coalesce((w.revenue_features->>'vip_seating')::boolean, false)
      and exists (select 1 from public.vip_offers v where v.wedding_id = w.id
        and v.price_minor > 0 and v.seats_total > v.seats_sold))
    or coalesce((w.revenue_features->>'song_requests')::boolean, false)
  ) into has_fundraising_route;
  if not has_fundraising_route then missing := array_append(missing, 'fundraising-route'); end if;
  return missing;
end $$;
revoke all on function public.wedding_missing_publication_content(public.weddings) from public, anon, authenticated;

create or replace function public.assert_wedding_publish_content(w public.weddings) returns void
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare missing text[];
begin
  missing := public.wedding_missing_publication_content(w);
  if cardinality(missing) > 0 then
    raise exception 'PUBLISH_INCOMPLETE: Complete these answers before publishing: %', array_to_string(missing, ', ');
  end if;
end $$;
revoke all on function public.assert_wedding_publish_content(public.weddings) from public, anon, authenticated;

create or replace function public.guard_wedding_publication_content() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if new.published_at is not null and
      (tg_op = 'INSERT' or old.published_at is null) then
    new.publication_minimum_enforced := true;
    perform public.assert_wedding_publish_content(new);
  end if;
  return new;
end $$;
drop trigger if exists wedding_publish_content on public.weddings;
create trigger wedding_publish_content before insert or update on public.weddings
  for each row execute function public.guard_wedding_publication_content();
revoke all on function public.guard_wedding_publication_content() from public, anon, authenticated;

create or replace function public.check_saved_wedding_content() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; wid uuid; missing text[];
begin
  if tg_table_name = 'weddings' then wid := new.id;
  elsif tg_op = 'DELETE' then wid := old.wedding_id;
  else wid := new.wedding_id; end if;
  select * into w from public.weddings where id = wid;
  if found and w.published_at is not null then
    missing := case when w.publication_minimum_enforced
      then public.wedding_missing_content(w) else public.wedding_missing_legacy_content(w) end;
    if cardinality(missing) > 0 then
      raise exception 'PUBLISH_INCOMPLETE: Complete these saved details before updating: %', array_to_string(missing, ', ');
    end if;
    if tg_table_name = 'weddings' then
      if tg_op = 'UPDATE' then
        if old.published_at is null then
          perform public.assert_wedding_publish_content(w);
        end if;
      end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.check_saved_wedding_content() from public, anon, authenticated;

create or replace function public.save_wedding_content(p_wedding_id uuid, p_patch jsonb, p_venues jsonb default null,
  p_expected_currency text default null, p_expected_presets jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; v jsonb; vid uuid; incoming uuid[] := '{}'; pos integer := 0; assignments text;
  allowed text[] := array['couple_names','slug','welcome_story','cover_image_url','guest_instructions',
    'wedding_date','time_zone','public_location','currency','revenue_features','max_guest_capacity','palette',
    'palette_names','attire_notes','rsvp_fee_minor','extra_guest_fee_minor','premium_diet_fee_minor',
    'premium_diet_options','allow_in_kind_sponsorship','background_music_url'];
  missing text[];
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if not found or auth.uid() is null or w.client_owner_id <> auth.uid() then raise exception 'Wedding not found.'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists
      (select 1 from jsonb_object_keys(p_patch) k where not k=any(allowed)) then raise exception 'Invalid wedding patch.'; end if;
  if p_expected_currency is not null and w.currency::text is distinct from p_expected_currency then
    raise exception 'DRAFT_CONFLICT: Wedding currency changed. Reload and review your wedding currency.';
  end if;
  if p_venues is not null then
    if jsonb_typeof(p_venues) <> 'array' or jsonb_array_length(p_venues)>30 then raise exception 'Use up to 30 events.'; end if;
    for v in select value from jsonb_array_elements(p_venues) loop
      vid := nullif(v->>'id','')::uuid;
      if vid is not null and not exists(select 1 from public.venues where id=vid and wedding_id=w.id) then
        raise exception 'An event belongs to a different wedding or was removed. Reload before saving.';
      end if;
      if vid=any(incoming) then raise exception 'An event appears twice.'; end if;
      if vid is null then insert into public.venues(wedding_id,name) values(w.id,'') returning id into vid; end if;
      incoming := array_append(incoming,vid);
      update public.venues set name=case when v ? 'name' then left(btrim(coalesce(v->>'name','')),100) else name end,
        event_time=case when v ? 'eventTime' then nullif(v->>'eventTime','')::time else event_time end,
        event_date=case when v ? 'eventDate' then nullif(v->>'eventDate','')::date else event_date end,
        address=case when v ? 'address' then nullif(left(btrim(v->>'address'),200),'') else address end,
        map_link=case when v ? 'mapLink' then nullif(btrim(v->>'mapLink'),'') else map_link end,
        description=case when v ? 'description' then nullif(left(v->>'description',500),'') else description end,
        is_main=case when v ? 'isMain' then coalesce((v->>'isMain')::boolean,false) else is_main end,
        kind=case when v ? 'kind' then case when v->>'kind'='pre' then 'pre' else 'main' end else kind end,
        sort_order=pos where id=vid;
      pos := pos+1;
    end loop;
    delete from public.venues where wedding_id=w.id and not id=any(incoming);
  end if;
  if p_patch ? 'currency' and p_patch->>'currency' is distinct from w.currency::text then
    update public.weddings set amount_presets = null where id = w.id;
  end if;
  select string_agg(format('%1$I=patch.%1$I',k),',') into assignments from jsonb_object_keys(p_patch) k;
  if assignments is not null then
    execute 'update public.weddings w set ' || assignments ||
      ' from jsonb_populate_record(null::public.weddings,$1) patch where w.id=$2 returning w.*'
      into w using p_patch,w.id;
  end if;
  if w.published_at is not null then
    missing := case when w.publication_minimum_enforced
      then public.wedding_missing_content(w) else public.wedding_missing_legacy_content(w) end;
    if cardinality(missing) > 0 then
      raise exception 'PUBLISH_INCOMPLETE: Complete these saved details before updating: %', array_to_string(missing, ', ');
    end if;
  end if;
  return to_jsonb(w);
end $$;
revoke all on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) from public, anon;
grant execute on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) to authenticated;

create or replace function public.wedding_publication_readiness(p_wedding_id uuid) returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare w public.weddings;
begin
  select * into w from public.weddings where id=p_wedding_id;
  if not found or auth.uid() is null or not (w.client_owner_id=auth.uid()
      or coalesce(public.current_platform_role() in ('admin','superadmin','owner'),false)) then
    raise exception 'Wedding not found.';
  end if;
  return public.wedding_missing_publication_content(w);
end $$;
revoke all on function public.wedding_publication_readiness(uuid) from public, anon;
grant execute on function public.wedding_publication_readiness(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.get_public_wedding_site_before_guided_minimum(text)') is null then
    alter function public.get_public_wedding_site(text) rename to get_public_wedding_site_before_guided_minimum;
  end if;
end $$;
revoke all on function public.get_public_wedding_site_before_guided_minimum(text) from public, anon, authenticated;
create function public.get_public_wedding_site(p_slug text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select site.payload || jsonb_build_object(
    'cover_image_url', w.cover_image_url,
    'guest_instructions', w.guest_instructions
  )
  from (select public.get_public_wedding_site_before_guided_minimum(p_slug) payload) site
  join public.weddings w on w.id = (site.payload->>'id')::uuid
$$;
revoke all on function public.get_public_wedding_site(text) from public;
grant execute on function public.get_public_wedding_site(text) to anon, authenticated;
