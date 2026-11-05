-- Opt-in creation version: existing weddings and their configured products are untouched.
alter table public.weddings add column interactive_creation boolean not null default false;
alter table public.weddings add column page_content jsonb not null default '{}' check(jsonb_typeof(page_content)='object' and octet_length(page_content::text)<=60000);
alter table public.weddings add column creation_content_reviewed boolean not null default false;
alter table public.weddings drop constraint weddings_welcome_story_check;
alter table public.weddings add constraint weddings_welcome_story_check check(length(welcome_story)<=2000);

create function public.interactive_fund_preset(p_currency text,p_setup jsonb) returns bigint
language plpgsql immutable set search_path = ''
as $$
begin
  if p_currency='KES' then return 50000000; end if;
  if p_setup->>'currency'=p_currency and p_setup#>>'{campaigns,0,goalMinor}' is not null then
    return public.starter_minor(p_setup#>'{campaigns,0,goalMinor}',1,100000000000);
  end if;
  return null;
end $$;
revoke all on function public.interactive_fund_preset(text,jsonb) from public,anon,authenticated;

create function public.create_interactive_wedding(p_request_key uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare result jsonb; wid uuid; existed boolean; preset bigint; fund uuid; item jsonb; pos integer := 0;
begin
  if auth.uid() is null then raise exception 'Sign in to create your wedding.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_request_key::text,0));
  existed := exists(select 1 from public.wedding_create_requests
    where client_owner_id=auth.uid() and request_key=p_request_key);
  result := public.create_deferred_wedding_starter(p_request_key,p_input);
  if existed then return result; end if;
  wid := (result->>'weddingId')::uuid;
  update public.weddings set interactive_creation=true,
    welcome_story=left(coalesce(p_input->>'welcomeStory',''),2000),
    revenue_features='{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}',
    starter_review_note='Fictional showcase content is prefilled for you to edit or delete. Replace sample venue addresses, choose your dates and review your story and all offerings before publishing. No sample activity or accounts were copied. Guest actions are disabled here.'
    where id=wid and client_owner_id=auth.uid();
  -- Keep only unpriced scaffolds; never apply source RSVP charges or package promises.
  delete from public.wedding_starter_pending where wedding_id=wid;
  preset := public.interactive_fund_preset(p_input->>'currency',p_input->'starterSetup');
  if preset is not null then
    insert into public.fundraising_streams(wedding_id,name,purpose,goal_minor,currency,enabled,sort_order)
      values(wid,coalesce(p_input#>>'{starterSetup,campaigns,0,name}','Celebration fund'),
        coalesce(p_input#>>'{starterSetup,campaigns,0,purpose}','Help us celebrate our next chapter.'),preset,p_input->>'currency',true,0)
      returning id into fund;
    if p_input#>>'{starterSetup,currency}'=p_input->>'currency' then
      for item in select value from jsonb_array_elements(coalesce(p_input#>'{starterSetup,campaigns,0,milestones}','[]')) loop
        insert into public.fundraising_milestones(wedding_id,stream_id,name,description,target_minor,sort_order)
          values(wid,fund,item->>'name',item->>'description',
            public.starter_minor(item->'targetMinor',1,preset),pos);
        pos := pos+1;
      end loop;
    end if;
    update public.wedding_starter_structures set setup=jsonb_set(setup,'{campaigns}',(setup->'campaigns')-0)
      where wedding_id=wid;
  elsif not exists(select 1 from public.wedding_starter_structures
      where wedding_id=wid and jsonb_array_length(setup->'campaigns')>0) then
    update public.wedding_starter_structures set setup=jsonb_set(setup,'{campaigns}',
      '[{"name":"Celebration fund","purpose":"Set your own goal.","enabled":true,"goalMinor":null,"milestones":[]}]')
      where wedding_id=wid;
  end if;
  return result;
end $$;
revoke all on function public.create_interactive_wedding(uuid,jsonb) from public,anon;
grant execute on function public.create_interactive_wedding(uuid,jsonb) to authenticated;

create function public.save_interactive_fundraising_campaigns(
  p_wedding_id uuid,p_payload jsonb,p_expected_currency text
) returns void language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  select * into w from public.weddings where id=p_wedding_id for update;
  if not found or not w.interactive_creation or w.currency is distinct from p_expected_currency then
    raise exception 'Your wedding currency changed. Reload and enter fund amounts again.';
  end if;
  if not exists(select 1 from jsonb_array_elements(p_payload) c
    where (c->>'enabled')::boolean and (c->>'goal_minor')::bigint>0) then
    raise exception 'Keep at least one visible celebration fund with a positive goal.';
  end if;
  perform public.save_fundraising_campaigns(p_wedding_id,p_payload);
end $$;
revoke all on function public.save_interactive_fundraising_campaigns(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.save_interactive_fundraising_campaigns(uuid,jsonb,text) to service_role;

create function public.protect_interactive_revenue() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.interactive_creation and not new.interactive_creation then
    raise exception 'The creation experience cannot be changed.';
  end if;
  if new.interactive_creation then
    new.revenue_features := '{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}'::jsonb;
    if new.published_at is not null and (not new.creation_content_reviewed or new.welcome_story like '%[Partner %'
      or exists(select 1 from public.venues where wedding_id=new.id and address like 'Sample venue:%')) then
      raise exception 'Replace sample venue details and partner placeholders, then confirm the content review before publishing.';
    end if;
    if new.published_at is not null and not exists(
      select 1 from public.fundraising_streams where wedding_id=new.id and enabled
        and currency=new.currency and goal_minor>0) then
      raise exception 'Keep at least one visible fund with a positive goal in your wedding currency before publishing.';
    end if;
  end if;
  return new;
end $$;
create trigger protect_interactive_revenue before update on public.weddings
  for each row execute function public.protect_interactive_revenue();

create function public.check_published_interactive_fund() returns trigger
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare wid uuid := coalesce(new.wedding_id,old.wedding_id);
begin
  if exists(select 1 from public.weddings w where w.id=wid and w.interactive_creation
    and w.published_at is not null and not exists(select 1 from public.fundraising_streams s
      where s.wedding_id=w.id and s.enabled and s.currency=w.currency and s.goal_minor>0)) then
    raise exception 'Keep at least one visible celebration fund with a positive goal.';
  end if;
  return null;
end $$;
revoke all on function public.check_published_interactive_fund() from public,anon,authenticated;
create constraint trigger check_published_interactive_fund
  after insert or update or delete on public.fundraising_streams
  deferrable initially deferred for each row execute function public.check_published_interactive_fund();

-- Wrap the latest projection instead of bypassing its cover/instructions additions.
alter function public.get_public_wedding_site(text) rename to get_public_wedding_site_before_interactive;
revoke all on function public.get_public_wedding_site_before_interactive(text) from public,anon,authenticated;
create function public.get_public_wedding_site(p_slug text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select site.payload || jsonb_build_object(
    'interactive_creation',w.interactive_creation,
    'page_content',w.page_content,
    'revenue_features',w.revenue_features,
    'registry',case when (w.revenue_features->>'giving')::boolean
      then coalesce(site.payload->'registry','[]'::jsonb) else '[]'::jsonb end
  )
  from (select public.get_public_wedding_site_before_interactive(p_slug) payload) site
  join public.weddings w on w.id=(site.payload->>'id')::uuid
$$;
revoke all on function public.get_public_wedding_site(text) from public;
grant execute on function public.get_public_wedding_site(text) to anon,authenticated;

alter function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) rename to save_wedding_content_before_interactive;
revoke all on function public.save_wedding_content_before_interactive(uuid,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
create function public.save_wedding_content(p_wedding_id uuid,p_patch jsonb,p_venues jsonb default null,
  p_expected_currency text default null,p_expected_presets jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; result jsonb; item record;
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if auth.uid() is null or w.client_owner_id is distinct from auth.uid() then raise exception 'Wedding not found.'; end if;
  if p_patch ? 'page_content' then
    if jsonb_typeof(p_patch->'page_content') is distinct from 'object' then raise exception 'Invalid page wording.'; end if;
    for item in select * from jsonb_each(p_patch->'page_content') loop
      if split_part(item.key,':',1)<>all(array['welcome','story','details','venues','prewedding','campaigns',
        'registry','rsvp','bids','ledger','sponsor-tiers','vip-section','sponsors','info-section','guestbook'])
        or item.key !~ '^[a-z-]+:[0-2]$' or jsonb_typeof(item.value)<>'string' or length(item.value#>>'{}')>2000 then
        raise exception 'Invalid page wording.';
      end if;
    end loop;
  end if;
  if p_patch ? 'creation_content_reviewed' and jsonb_typeof(p_patch->'creation_content_reviewed')<>'boolean' then
    raise exception 'Confirm your content review.';
  end if;
  result := public.save_wedding_content_before_interactive(p_wedding_id,
    p_patch-'page_content'-'creation_content_reviewed',p_venues,p_expected_currency,p_expected_presets);
  if p_patch ? 'page_content' or p_patch ? 'creation_content_reviewed' then
    update public.weddings set
      page_content=coalesce(p_patch->'page_content',page_content),
      creation_content_reviewed=coalesce((p_patch->>'creation_content_reviewed')::boolean,creation_content_reviewed)
      where id=p_wedding_id returning * into w;
    result := to_jsonb(w);
  end if;
  return result;
end $$;
revoke all on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) from public,anon;
grant execute on function public.save_wedding_content(uuid,jsonb,jsonb,text,jsonb) to authenticated;
