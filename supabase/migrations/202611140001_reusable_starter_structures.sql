-- Unpriced editing scaffolds are owner-only, never usable offers or publication evidence.
create table public.wedding_starter_structures (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  setup jsonb not null check(jsonb_typeof(setup)='object')
);
alter table public.wedding_starter_structures enable row level security;
revoke all on public.wedding_starter_structures from public,anon,authenticated;
grant select on public.wedding_starter_structures to authenticated;
grant all on public.wedding_starter_structures to service_role;
create policy starter_structure_owner_read on public.wedding_starter_structures for select to authenticated
  using(exists(select 1 from public.weddings w where w.id=wedding_id and w.client_owner_id=auth.uid()));

create function public.starter_structure(p_setup jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'tiers',coalesce((select jsonb_agg(jsonb_build_object('name',v->>'name','perks',v->>'perks','minimumMinor',null) order by n)
      from jsonb_array_elements(p_setup->'tiers') with ordinality a(v,n)),'[]'::jsonb),
    'registry',coalesce((select jsonb_agg(jsonb_build_object('name',v->>'name','category',v->>'category',
      'description',v->>'description','targetMinor',null) order by n)
      from jsonb_array_elements(p_setup->'registry') with ordinality a(v,n)),'[]'::jsonb),
    'vip',case when jsonb_typeof(p_setup->'vip')='object' then jsonb_build_object(
      'title',p_setup->'vip'->>'title','description',p_setup->'vip'->>'description','seats',p_setup->'vip'->'seats','priceMinor',null) else 'null'::jsonb end,
    'featured',case when jsonb_typeof(p_setup->'featured')='object' then jsonb_build_object(
      'slots',p_setup->'featured'->'slots','minimumMinor',null,'incrementMinor',null) else 'null'::jsonb end,
    'campaigns',coalesce((select jsonb_agg(jsonb_build_object(
      'name',v->>'name','purpose',v->>'purpose','enabled',v->'enabled','goalMinor',null,
      'milestones',coalesce((select jsonb_agg(jsonb_build_object('name',m->>'name','description',m->>'description',
        'targetMinor',null) order by mn) from jsonb_array_elements(v->'milestones') with ordinality b(m,mn)),'[]'::jsonb)) order by n)
      from jsonb_array_elements(p_setup->'campaigns') with ordinality a(v,n)),'[]'::jsonb))
$$;
revoke all on function public.starter_structure(jsonb) from public,anon,authenticated;

create function public.capture_starter_structure() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  insert into public.wedding_starter_structures(wedding_id,setup)
    values(new.wedding_id,public.starter_structure(new.setup));
  return new;
end $$;
revoke all on function public.capture_starter_structure() from public,anon,authenticated;
create trigger starter_structure_capture after insert on public.wedding_starter_pending
  for each row execute function public.capture_starter_structure();

create function public.save_wedding_starter_structure(p_wedding_id uuid,p_setup jsonb) returns void
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  perform 1 from public.weddings where id=p_wedding_id and client_owner_id=auth.uid()
    and published_at is null for update;
  if not found or auth.uid() is null then raise exception 'Private owner draft required.'; end if;
  insert into public.wedding_starter_structures(wedding_id,setup)
    select wedding_id,public.starter_structure(setup) from public.wedding_starter_pending where wedding_id=p_wedding_id
    on conflict(wedding_id) do nothing;
  if octet_length(p_setup::text)>60000 or jsonb_typeof(p_setup) is distinct from 'object' or
      public.starter_structure(p_setup) is distinct from p_setup then
    raise exception 'Only amount-free draft structures can be saved.';
  end if;
  update public.wedding_starter_structures set setup=p_setup where wedding_id=p_wedding_id;
  if not found then raise exception 'Reload the guide before saving unfinished template offerings.'; end if;
end $$;
revoke all on function public.save_wedding_starter_structure(uuid,jsonb) from public,anon;
grant execute on function public.save_wedding_starter_structure(uuid,jsonb) to authenticated;

-- A currency change permanently discards pending source amounts, including nested goals.
create function public.clear_pending_starter_currency() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare saved jsonb; active jsonb;
begin
  if new.currency is distinct from old.currency and (
      exists(select 1 from public.wedding_starter_structures where wedding_id=old.id) or
      exists(select 1 from public.wedding_starter_pending where wedding_id=old.id) or
      exists(select 1 from public.wedding_starter_reviews where wedding_id=old.id)) then
    if old.published_at is not null or old.first_published_at is not null or
        exists(select 1 from public.contributions where wedding_id=old.id) then
      raise exception 'DRAFT_CONFLICT: A wedding with publication or financial history cannot clear template amounts into a different currency.';
    end if;
    select setup into saved from public.wedding_starter_structures where wedding_id=old.id;
    if saved is null then
      select public.starter_structure(setup) into saved from public.wedding_starter_pending where wedding_id=old.id;
    end if;
    saved := coalesce(saved,'{"tiers":[],"registry":[],"vip":null,"featured":null,"campaigns":[]}'::jsonb);
    active := jsonb_build_object(
      'tiers',coalesce((select jsonb_agg(jsonb_build_object('name',name,'perks',perks) order by sort_order)
        from public.sponsor_tiers where wedding_id=old.id),'[]'::jsonb) || (saved->'tiers'),
      'registry',coalesce((select jsonb_agg(jsonb_build_object('name',name,'category',coalesce(category,''),
        'description',coalesce(description,'')) order by sort_order) from public.registry_items where wedding_id=old.id),'[]'::jsonb) || (saved->'registry'),
      'vip',coalesce((select jsonb_build_object('title',title,'description',coalesce(description,''),'seats',seats_total)
        from public.vip_offers where wedding_id=old.id limit 1),saved->'vip'),
      'featured',coalesce((select jsonb_build_object('slots',slot_count) from public.sponsor_featured_campaigns
        where wedding_id=old.id),saved->'featured'),
      'campaigns',coalesce((select jsonb_agg(jsonb_build_object('name',s.name,'purpose',s.purpose,'enabled',s.enabled,
        'milestones',coalesce((select jsonb_agg(jsonb_build_object('name',m.name,'description',coalesce(m.description,'')) order by m.sort_order)
          from public.fundraising_milestones m where m.stream_id=s.id),'[]'::jsonb)) order by s.sort_order)
        from public.fundraising_streams s where s.wedding_id=old.id),'[]'::jsonb) || (saved->'campaigns'));
    insert into public.wedding_starter_structures(wedding_id,setup) values(old.id,public.starter_structure(active))
      on conflict(wedding_id) do update set setup=excluded.setup;
    delete from public.sponsor_tiers where wedding_id=old.id;
    delete from public.registry_items where wedding_id=old.id;
    delete from public.vip_offers where wedding_id=old.id;
    delete from public.sponsor_featured_campaigns where wedding_id=old.id;
    delete from public.fundraising_milestones where wedding_id=old.id;
    delete from public.fundraising_streams where wedding_id=old.id;
    delete from public.wedding_starter_pending where wedding_id=old.id;
    new.rsvp_fee_minor := 0;
    new.extra_guest_fee_minor := 0;
    new.premium_diet_fee_minor := 0;
    new.amount_presets := null;
    new.starter_review_note := 'Source amounts were cleared, not converted. Your unpriced offering and goal structures remain editable in the guide.';
  end if;
  return new;
end $$;
revoke all on function public.clear_pending_starter_currency() from public,anon,authenticated;
create trigger clear_pending_starter_currency before update of currency on public.weddings
  for each row execute function public.clear_pending_starter_currency();

create or replace function public.create_deferred_wedding_starter(p_request_key uuid,p_input jsonb) returns jsonb
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
  if config->>'currency' is distinct from p_input->>'currency' then
    delete from public.wedding_starter_pending where wedding_id=wid;
  end if;
  update public.weddings set
    starter_review_note=case when config->>'currency'=p_input->>'currency'
      then 'Your style and unpriced structures are saved. Review source amounts in the currency step before applying them.'
      else 'Source amounts were cleared, not converted. Your unpriced offering and goal structures remain editable in the guide.' end,
    revenue_features=config->'features', attire_notes=config->'content'->>'attire',
    travel_info=config->'content'->>'travel', faq=config->'content'->'faq',
    premium_diet_options=array(select jsonb_array_elements_text(config->'rsvp'->'premiumDietOptions')),
    rsvp_fee_minor=0,extra_guest_fee_minor=0,premium_diet_fee_minor=0,enabled_payment_methods='{}'::text[]
  where id=wid and client_owner_id=auth.uid() and published_at is null;
  update public.wedding_create_requests set starter_applied=true where client_owner_id=auth.uid() and request_key=p_request_key;
  delete from public.wedding_starter_sources where owner_id=auth.uid() and request_key=p_request_key;
  return result;
end $$;

alter function public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb)
  rename to review_deferred_wedding_starter_amounts;
revoke all on function public.review_deferred_wedding_starter_amounts(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.review_deferred_wedding_starter(p_owner uuid,p_wedding_id uuid,p_request_key uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare result jsonb; replay boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  perform 1 from public.weddings where id=p_wedding_id and client_owner_id=p_owner for update;
  if not found then raise exception 'Starter wedding not found.'; end if;
  replay := exists(select 1 from public.wedding_starter_reviews where wedding_id=p_wedding_id);
  if not replay then
    insert into public.wedding_starter_structures(wedding_id,setup)
      select wedding_id,public.starter_structure(setup) from public.wedding_starter_pending where wedding_id=p_wedding_id
      on conflict(wedding_id) do nothing;
  end if;
  result := public.review_deferred_wedding_starter_amounts(p_owner,p_wedding_id,p_request_key,p_input);
  if not replay and p_input->>'decision'='apply' then
    update public.wedding_starter_structures set setup='{"tiers":[],"registry":[],"vip":null,"featured":null,"campaigns":[]}'::jsonb
      where wedding_id=p_wedding_id;
  end if;
  return result;
end $$;
revoke all on function public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb) to service_role;
