-- Unpaid personalization does not depend on collection availability.
alter table public.weddings
  drop constraint weddings_couple_names_check;
alter table public.weddings add constraint weddings_couple_names_check
  check (length(couple_names) <= 120 and (published_at is null or length(btrim(couple_names)) > 0));

-- Wedding rows are readable by helpers; pending source money is owner-only.
create table public.wedding_starter_pending (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  setup jsonb not null
);
alter table public.wedding_starter_pending enable row level security;
revoke all on public.wedding_starter_pending from public,anon,authenticated;
grant select on public.wedding_starter_pending to authenticated;
grant all on public.wedding_starter_pending to service_role;
create policy starter_pending_owner_read on public.wedding_starter_pending for select to authenticated
  using (exists(select 1 from public.weddings w where w.id=wedding_id and w.client_owner_id=auth.uid()));

create or replace function public.create_wedding_with_venues(
  p_slug text, p_couple_names text, p_wedding_date date, p_location text,
  p_currency text, p_capacity integer, p_palette text[], p_venues jsonb
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare wid uuid; v jsonb; pos integer := 0;
begin
  if p_couple_names is null or length(p_couple_names) > 120 then raise exception 'Check the couple names.'; end if;
  if jsonb_typeof(coalesce(p_venues, '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(p_venues, '[]'::jsonb)) > 30 then
    raise exception 'Use up to 30 events.';
  end if;
  wid := public.create_wedding(p_slug,btrim(p_couple_names),p_wedding_date,
    nullif(btrim(p_location),''),p_currency,p_capacity,p_palette);
  for v in select value from jsonb_array_elements(coalesce(p_venues,'[]'::jsonb)) loop
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

create table public.wedding_starter_sources (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  input_hash text not null,
  checked_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,request_key)
);
alter table public.wedding_starter_sources enable row level security;
revoke all on public.wedding_starter_sources from public,anon,authenticated;
grant all on public.wedding_starter_sources to service_role;

create function public.stage_wedding_starter_source(p_owner uuid,p_request_key uuid,p_input jsonb) returns void
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  if p_owner is null or p_request_key is null or jsonb_typeof(p_input->'starterSetup') is distinct from 'object' then
    raise exception 'Invalid starter source.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || p_request_key::text,0));
  if exists(select 1 from public.wedding_create_requests where client_owner_id=p_owner and request_key=p_request_key) then return; end if;
  insert into public.wedding_starter_sources(owner_id,request_key,input_hash)
  values(p_owner,p_request_key,md5((p_input-'slug')::text))
  on conflict(owner_id,request_key) do update set input_hash=excluded.input_hash,checked_at=clock_timestamp();
end $$;
revoke all on function public.stage_wedding_starter_source(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.stage_wedding_starter_source(uuid,uuid,jsonb) to service_role;

create function public.create_deferred_wedding_starter(p_request_key uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare result jsonb; wid uuid; config jsonb := p_input->'starterSetup';
begin
  if auth.uid() is null or not coalesce(public.current_platform_role() in ('client','owner'),false) then
    raise exception 'A signed-in Client account is required.';
  end if;
  if p_request_key is null then raise exception 'A stable create request key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_request_key::text,0));
  if exists(select 1 from public.wedding_create_requests where client_owner_id=auth.uid() and request_key=p_request_key) then
    result := public.create_wedding_draft(p_request_key,p_input);
    if not exists(select 1 from public.wedding_create_requests where client_owner_id=auth.uid()
        and request_key=p_request_key and starter_applied) then raise exception 'CREATE_CONFLICT: Not an applied starter.'; end if;
    return result;
  end if;
  if not exists(select 1 from public.wedding_starter_sources where owner_id=auth.uid() and request_key=p_request_key
      and input_hash=md5((p_input-'slug')::text) and checked_at > clock_timestamp()-interval '2 minutes') then
    raise exception 'STARTER_SOURCE_REQUIRED: Recheck the public starter source.';
  end if;
  result := public.create_wedding_draft(p_request_key,p_input);
  wid := (result->>'weddingId')::uuid;
  insert into public.wedding_starter_pending(wedding_id,setup)
    values(wid,jsonb_set(config,'{reviewed}','false'::jsonb));
  update public.weddings set
    starter_review_note='Your style is saved. Package prices, RSVP fees and goals are pending review in their original currency; none have been applied. Personalize your wedding now and review these later in the currency step.',
    revenue_features=config->'features', attire_notes=config->'content'->>'attire',
    travel_info=config->'content'->>'travel', faq=config->'content'->'faq',
    premium_diet_options=array(select jsonb_array_elements_text(config->'rsvp'->'premiumDietOptions')),
    rsvp_fee_minor=0,extra_guest_fee_minor=0,premium_diet_fee_minor=0,enabled_payment_methods='{}'::text[]
  where id=wid and client_owner_id=auth.uid() and published_at is null;
  update public.wedding_create_requests set starter_applied=true where client_owner_id=auth.uid() and request_key=p_request_key;
  delete from public.wedding_starter_sources where owner_id=auth.uid() and request_key=p_request_key;
  return result;
end $$;
revoke all on function public.create_deferred_wedding_starter(uuid,jsonb) from public,anon;
grant execute on function public.create_deferred_wedding_starter(uuid,jsonb) to authenticated;

create table public.wedding_starter_reviews (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  request_key uuid not null,
  input_hash text not null,
  result jsonb not null
);
alter table public.wedding_starter_reviews enable row level security;
revoke all on public.wedding_starter_reviews from public,anon,authenticated;
grant all on public.wedding_starter_reviews to service_role;

create function public.review_deferred_wedding_starter(p_owner uuid,p_wedding_id uuid,p_request_key uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  w public.weddings; prior public.wedding_starter_reviews; config jsonb; item jsonb; milestone jsonb;
  stream_id uuid; pos integer; mpos integer; result jsonb; decision text := p_input->>'decision';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id=p_wedding_id and client_owner_id=p_owner for update;
  if not found then raise exception 'Starter wedding not found.'; end if;
  select * into prior from public.wedding_starter_reviews where wedding_id=w.id;
  if found then
    if prior.request_key is distinct from p_request_key or prior.input_hash is distinct from md5(p_input::text) then
      raise exception 'CREATE_CONFLICT: This starter was already reviewed. Reload the saved wedding.';
    end if;
    return prior.result;
  end if;
  select setup into config from public.wedding_starter_pending where wedding_id=w.id;
  if p_request_key is null or config is null or w.published_at is not null or
      p_input->'reviewed' is distinct from 'true'::jsonb or decision is null or decision not in ('apply','omit') or
      w.currency is distinct from p_input->>'currency' then raise exception 'CREATE_CONFLICT: Review the current private starter and currency.'; end if;
  if decision='apply' then
    if config->>'currency' is distinct from w.currency then raise exception 'Source prices cannot be relabelled into another currency.'; end if;
    -- Never overwrite personalized offers or fees entered while review was pending.
    if w.rsvp_fee_minor <> 0 or w.extra_guest_fee_minor <> 0 or w.premium_diet_fee_minor <> 0 or
        exists(select 1 from public.sponsor_tiers where wedding_id=w.id) or
        exists(select 1 from public.registry_items where wedding_id=w.id) or
        exists(select 1 from public.fundraising_streams where wedding_id=w.id) or
        exists(select 1 from public.vip_offers where wedding_id=w.id) or
        exists(select 1 from public.sponsor_featured_campaigns where wedding_id=w.id) then
      raise exception 'CREATE_CONFLICT: You already personalized prices or goals. Keep those settings and omit source prices.';
    end if;
    update public.weddings set
      rsvp_fee_minor=public.starter_minor(config->'rsvp'->'feeMinor',0,100000000),
      extra_guest_fee_minor=public.starter_minor(config->'rsvp'->'extraGuestFeeMinor',0,100000000),
      premium_diet_fee_minor=public.starter_minor(config->'rsvp'->'premiumDietFeeMinor',0,100000000)
    where id=w.id;
    pos := 0;
    for item in select value from jsonb_array_elements(config->'tiers') loop
      insert into public.sponsor_tiers(wedding_id,name,min_amount_minor,perks,sort_order)
      values(w.id,item->>'name',public.starter_minor(item->'minimumMinor',1,100000000000),item->>'perks',pos);
      pos := pos+1;
    end loop;
    pos := 0;
    for item in select value from jsonb_array_elements(config->'registry') loop
      insert into public.registry_items(wedding_id,name,category,description,target_amount_minor,sort_order)
      values(w.id,item->>'name',nullif(item->>'category',''),item->>'description',
        public.starter_minor(item->'targetMinor',100,100000000000),pos);
      pos := pos+1;
    end loop;
    item := config->'vip';
    if item <> 'null'::jsonb then
      insert into public.vip_offers(wedding_id,title,description,seats_total,price_minor)
      values(w.id,item->>'title',item->>'description',public.starter_minor(item->'seats',1,500)::integer,
        public.starter_minor(item->'priceMinor',1,100000000000));
    end if;
    item := config->'featured';
    if item <> 'null'::jsonb then
      insert into public.sponsor_featured_campaigns(wedding_id,enabled,starts_at,closes_at,slot_count,minimum_bid_minor,bid_increment_minor,updated_by)
      values(w.id,false,null,null,public.starter_minor(item->'slots',1,20)::integer,
        public.starter_minor(item->'minimumMinor',1,100000000000),
        public.starter_minor(item->'incrementMinor',1,100000000000),p_owner);
    end if;
    pos := 0;
    for item in select value from jsonb_array_elements(config->'campaigns') loop
      insert into public.fundraising_streams(wedding_id,name,purpose,goal_minor,currency,enabled,sort_order)
      values(w.id,item->>'name',item->>'purpose',public.starter_minor(item->'goalMinor',1,100000000000),
        w.currency,(item->>'enabled')::boolean,pos) returning id into stream_id;
      mpos := 0;
      for milestone in select value from jsonb_array_elements(item->'milestones') loop
        insert into public.fundraising_milestones(stream_id,wedding_id,name,description,target_minor,sort_order)
        values(stream_id,w.id,milestone->>'name',milestone->>'description',
          public.starter_minor(milestone->'targetMinor',1,(item->>'goalMinor')::bigint),mpos);
        mpos := mpos+1;
      end loop;
      pos := pos+1;
    end loop;
  end if;
  delete from public.wedding_starter_pending where wedding_id=w.id;
  update public.weddings set starter_review_note=case when decision='apply'
    then 'Source prices and goals were explicitly reviewed and applied in their original currency. Personalize your offerings before publishing; no activity or payment readiness was inherited.'
    else 'Source prices and goals were explicitly omitted, not converted. Your personalized content and any settings you entered were preserved; add your own prices and goals in the guide.' end
  where id=w.id;
  result := jsonb_build_object('ok',true,'decision',decision);
  insert into public.wedding_starter_reviews(wedding_id,request_key,input_hash,result)
    values(w.id,p_request_key,md5(p_input::text),result);
  return result;
end $$;
revoke all on function public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb) to service_role;

create function public.guard_pending_wedding_starter() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.published_at is not null and exists(
      select 1 from public.wedding_starter_pending where wedding_id=new.id) then
    raise exception 'PUBLISH_INCOMPLETE: Review or omit pending starter prices in the currency step.';
  end if;
  return new;
end $$;
create trigger pending_wedding_starter_publication before insert or update on public.weddings
  for each row execute function public.guard_pending_wedding_starter();
revoke all on function public.guard_pending_wedding_starter() from public,anon,authenticated;
