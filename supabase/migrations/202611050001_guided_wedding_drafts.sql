-- Couple names are the minimum draft identity. No guessed dates, locations or venues.
-- Existing published rows are not rewritten; subsequent writes and publication must be complete.
alter table public.weddings drop constraint if exists weddings_date_required;
alter table public.weddings add constraint weddings_date_required
  check (published_at is null or wedding_date is not null) not valid;
alter table public.venues drop constraint if exists venues_name_check;
alter table public.venues add constraint venues_name_check check (length(name) <= 100);

create function public.wedding_missing_content(w public.weddings) returns text[]
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
revoke all on function public.wedding_missing_content(public.weddings) from public, anon, authenticated;

create function public.assert_wedding_publish_content(w public.weddings) returns void
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare missing text[];
begin
  missing := public.wedding_missing_content(w);
  if cardinality(missing) > 0 then
    raise exception 'PUBLISH_INCOMPLETE: Complete these answers before publishing: %', array_to_string(missing, ', ');
  end if;
end $$;
revoke all on function public.assert_wedding_publish_content(public.weddings) from public, anon, authenticated;

-- Locks serialize publication and venue writes, including direct REST/RPC and staff paths.
create function public.guard_wedding_publication_content() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if new.published_at is not null and old.published_at is null then
    perform public.assert_wedding_publish_content(new);
  end if;
  return new;
end $$;
create trigger wedding_publish_content before update on public.weddings
  for each row execute function public.guard_wedding_publication_content();

create function public.lock_venue_wedding() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if tg_op = 'UPDATE' and new.wedding_id is distinct from old.wedding_id then
    raise exception 'An event cannot be moved to a different wedding.';
  end if;
  perform 1 from public.weddings where id = case when tg_op = 'DELETE' then old.wedding_id else new.wedding_id end for update;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger venue_wedding_lock before insert or update or delete on public.venues
  for each row execute function public.lock_venue_wedding();

create function public.check_saved_wedding_content() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; wid uuid;
begin
  if tg_table_name = 'weddings' then wid := new.id;
  elsif tg_op = 'DELETE' then wid := old.wedding_id;
  else wid := new.wedding_id; end if;
  select * into w from public.weddings where id = wid;
  if found and w.published_at is not null then perform public.assert_wedding_publish_content(w); end if;
  return null;
end $$;
create constraint trigger saved_wedding_content after insert or update on public.weddings
  deferrable initially deferred for each row execute function public.check_saved_wedding_content();
create constraint trigger saved_venue_content after insert or update or delete on public.venues
  deferrable initially deferred for each row execute function public.check_saved_wedding_content();
revoke all on function public.guard_wedding_publication_content(), public.lock_venue_wedding(),
  public.check_saved_wedding_content() from public, anon, authenticated;

-- Keep the core signature used by referral_create_wedding.
create or replace function public.create_wedding_with_venues(
  p_slug text, p_couple_names text, p_wedding_date date, p_location text,
  p_currency text, p_capacity integer, p_palette text[], p_venues jsonb
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare wid uuid; v jsonb; pos integer := 0;
begin
  if nullif(btrim(p_couple_names), '') is null then raise exception 'Enter the couple names to create a draft.'; end if;
  if jsonb_typeof(coalesce(p_venues, '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(p_venues, '[]'::jsonb)) > 30 then
    raise exception 'Use up to 30 events.';
  end if;
  wid := public.create_wedding(p_slug, btrim(p_couple_names), p_wedding_date,
    nullif(btrim(p_location), ''), p_currency, p_capacity, p_palette);
  for v in select value from jsonb_array_elements(coalesce(p_venues, '[]'::jsonb)) loop
    insert into public.venues(wedding_id,name,event_time,event_date,address,map_link,description,is_main,kind,sort_order)
    values(wid,left(btrim(coalesce(v->>'name','')),100),nullif(v->>'eventTime','')::time,
      nullif(v->>'eventDate','')::date,nullif(left(btrim(v->>'address'),200),''),
      nullif(btrim(v->>'mapLink'),''),nullif(left(v->>'description',500),''),
      coalesce((v->>'isMain')::boolean,false) and coalesce(v->>'kind','main') <> 'pre',
      case when v->>'kind'='pre' then 'pre' else 'main' end,pos);
    pos := pos + 1;
  end loop;
  return wid;
end $$;

create table public.wedding_create_requests (
  client_owner_id uuid not null references auth.users(id),
  request_key uuid not null,
  input_hash text not null,
  wedding_id uuid not null references public.weddings(id),
  created_at timestamptz not null default now(),
  primary key (client_owner_id, request_key)
);
alter table public.wedding_create_requests enable row level security;
revoke all on public.wedding_create_requests from anon, authenticated;

create function public.create_wedding_draft(p_request_key uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare wid uuid; prior public.wedding_create_requests; r jsonb := p_input->'referral'; w public.weddings;
begin
  if auth.uid() is null or not coalesce(public.current_platform_role() in ('client','owner'),false) then
    raise exception 'A signed-in Client account is required to create a wedding workspace.';
  end if;
  if p_request_key is null or jsonb_typeof(p_input) <> 'object' then raise exception 'A create request key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_request_key::text,0));
  select * into prior from public.wedding_create_requests where client_owner_id=auth.uid() and request_key=p_request_key;
  if found then
    if prior.input_hash <> md5((p_input - 'slug')::text) then
      raise exception 'CREATE_CONFLICT: This request already created a wedding. Reopen your saved draft before changing these answers.';
    end if;
    select * into w from public.weddings where id=prior.wedding_id;
    return jsonb_build_object('weddingId',w.id,'slug',w.slug);
  end if;
  -- Optional rollout seam: when referrals are installed ALWAYS invoke their guard,
  -- even with no referral body, so pending server intents cannot be bypassed.
  if to_regprocedure('public.referral_create_wedding(text,text,date,text,text,integer,text[],jsonb,uuid,text,uuid,text)') is not null then
    execute 'select public.referral_create_wedding($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
      into wid using p_input->>'slug',p_input->>'coupleNames',nullif(p_input->>'weddingDate','')::date,
      nullif(p_input->>'location',''),p_input->>'currency',(p_input->>'maxCapacity')::integer,
      array(select jsonb_array_elements_text(p_input->'palette')),p_input->'venues',
      (r->>'intentId')::uuid,r->>'decision',(r->>'revision')::uuid,r->>'termsVersion';
  else
    if r is not null and r <> 'null'::jsonb then raise exception 'REFERRAL_CONFLICT: Referral disclosure is unavailable. Try again after it is restored.'; end if;
    wid := public.create_wedding_with_venues(p_input->>'slug',p_input->>'coupleNames',
      nullif(p_input->>'weddingDate','')::date,nullif(p_input->>'location',''),p_input->>'currency',
      (p_input->>'maxCapacity')::integer,array(select jsonb_array_elements_text(p_input->'palette')),p_input->'venues');
  end if;
  update public.weddings set time_zone=p_input->>'timeZone',
    palette_names=array(select jsonb_array_elements_text(p_input->'paletteNames')) where id=wid returning * into w;
  insert into public.wedding_create_requests(client_owner_id,request_key,input_hash,wedding_id)
    values(auth.uid(),p_request_key,md5((p_input - 'slug')::text),wid);
  return jsonb_build_object('weddingId',w.id,'slug',w.slug);
end $$;
revoke all on function public.create_wedding_draft(uuid,jsonb) from public, anon;
grant execute on function public.create_wedding_draft(uuid,jsonb) to authenticated;

-- Core content and the repeatable venue list commit together. Omitted keys keep values;
-- explicit null date/location or [] venues clear a draft, never a published wedding.
create function public.save_wedding_content(p_wedding_id uuid, p_patch jsonb, p_venues jsonb default null,
  p_expected_currency text default null, p_expected_presets jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; v jsonb; vid uuid; incoming uuid[] := '{}'; pos integer := 0; assignments text;
  allowed text[] := array['couple_names','slug','welcome_story','wedding_date','time_zone','public_location',
    'currency','amount_presets','max_guest_capacity','palette','palette_names','attire_notes',
    'rsvp_fee_minor','extra_guest_fee_minor','premium_diet_fee_minor','premium_diet_options',
    'allow_in_kind_sponsorship','background_music_url'];
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if not found or auth.uid() is null or w.client_owner_id <> auth.uid() then raise exception 'Wedding not found.'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists
      (select 1 from jsonb_object_keys(p_patch) k where not k=any(allowed)) then raise exception 'Invalid wedding patch.'; end if;
  if p_expected_currency is not null and w.currency::text is distinct from p_expected_currency then
    raise exception 'DRAFT_CONFLICT: Wedding currency changed. Reload and review the amounts.';
  end if;
  if p_patch ? 'amount_presets' and (p_expected_currency is null or w.amount_presets is distinct from p_expected_presets) then
    raise exception 'DRAFT_CONFLICT: Review suggested amounts against the current saved wedding.';
  end if;
  if p_patch ? 'currency' and p_patch->>'currency' is distinct from w.currency::text and not p_patch ? 'amount_presets' then
    raise exception 'Currency changes require reviewed suggested amounts or an explicit reset.';
  end if;
  if p_patch ? 'couple_names' and nullif(btrim(p_patch->>'couple_names'),'') is null then raise exception 'Couple names are required.'; end if;
  if p_venues is not null then
    if jsonb_typeof(p_venues) <> 'array' or jsonb_array_length(p_venues)>30 then raise exception 'Use up to 30 events.'; end if;
    for v in select value from jsonb_array_elements(p_venues) loop
      vid := nullif(v->>'id','')::uuid;
      if vid is not null and not exists(select 1 from public.venues where id=vid and wedding_id=w.id) then
        raise exception 'An event belongs to a different wedding or was removed. Reload before saving.';
      end if;
      if vid=any(incoming) then raise exception 'An event appears twice.'; end if;
      if vid is null then
        insert into public.venues(wedding_id,name) values(w.id,'') returning id into vid;
      end if;
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
  select string_agg(format('%1$I=patch.%1$I',k),',') into assignments from jsonb_object_keys(p_patch) k;
  if assignments is not null then
    execute 'update public.weddings w set ' || assignments ||
      ' from jsonb_populate_record(null::public.weddings,$1) patch where w.id=$2 returning w.*'
      into w using p_patch,w.id;
  end if;
  if w.published_at is not null then perform public.assert_wedding_publish_content(w); end if;
  return to_jsonb(w);
end $$;
revoke all on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) from public, anon;
grant execute on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) to authenticated;

create function public.wedding_publication_readiness(p_wedding_id uuid) returns text[]
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare w public.weddings;
begin
  select * into w from public.weddings where id=p_wedding_id;
  if not found or auth.uid() is null or not (w.client_owner_id=auth.uid()
      or coalesce(public.current_platform_role() in ('admin','superadmin','owner'),false)) then
    raise exception 'Wedding not found.';
  end if;
  return public.wedding_missing_content(w);
end $$;
revoke all on function public.wedding_publication_readiness(uuid) from public, anon;
grant execute on function public.wedding_publication_readiness(uuid) to authenticated;

-- No unknown-date quote can look like a confirmed free or far-future fee.
alter function public.publication_quote_internal(uuid) rename to publication_quote_dated_internal;
revoke all on function public.publication_quote_dated_internal(uuid) from public, anon, authenticated;
create function public.publication_quote_internal(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare w public.weddings;
begin
  select * into w from public.weddings where id=p_wedding_id;
  if not found then raise exception 'Wedding not found.'; end if;
  if w.wedding_date is null then
    return jsonb_build_object('fee_minor',null,'usd_amount_minor',null,'currency',w.currency,
      'pending_date',true,'code','pending_date','reason','Set the wedding date to calculate the publication fee. No fee or payment quote is available yet.');
  end if;
  return public.publication_quote_dated_internal(p_wedding_id);
end $$;
revoke all on function public.publication_quote_internal(uuid) from public, anon, authenticated;
