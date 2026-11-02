-- Additive starter-only RPC. Existing create/editor entry points stay unchanged.
-- Authoring only: apply through the approved migration process, never ad hoc in Production.
alter table public.wedding_create_requests add column starter_applied boolean not null default false;
-- Disabled starter campaigns have no invented event/auction dates.
alter table public.sponsor_featured_campaigns alter column starts_at drop not null;
alter table public.sponsor_featured_campaigns alter column closes_at drop not null;
alter table public.sponsor_featured_campaigns add constraint enabled_featured_campaign_dates
  check (not enabled or (starts_at is not null and closes_at is not null and closes_at > starts_at));
create table public.wedding_starter_capability_proofs (
  client_owner_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  currency text not null,
  input_hash text not null,
  checked_at timestamptz not null default clock_timestamp(),
  primary key (client_owner_id,request_key)
);
alter table public.wedding_starter_capability_proofs enable row level security;
revoke all on public.wedding_starter_capability_proofs from public, anon, authenticated;
grant all on public.wedding_starter_capability_proofs to service_role;

create function public.stage_wedding_starter_capability(p_owner uuid, p_request_key uuid, p_input jsonb) returns void
language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  if p_owner is null or p_request_key is null or jsonb_typeof(p_input) is distinct from 'object' or
      not public.paystack_accounting_currency_supported(p_input->>'currency') then
    raise exception 'Invalid starter capability proof.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || p_request_key::text,0));
  if exists(select 1 from public.wedding_create_requests where client_owner_id=p_owner and request_key=p_request_key) then return; end if;
  insert into public.wedding_starter_capability_proofs(client_owner_id,request_key,currency,input_hash)
  values(p_owner,p_request_key,p_input->>'currency',md5((p_input - 'slug')::text))
  on conflict(client_owner_id,request_key) do update set currency=excluded.currency,
    input_hash=excluded.input_hash, checked_at=clock_timestamp();
end $$;
revoke all on function public.stage_wedding_starter_capability(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.stage_wedding_starter_capability(uuid,uuid,jsonb) to service_role;

create function public.starter_minor(p_value jsonb, p_min bigint, p_max bigint) returns bigint
language plpgsql immutable set search_path = ''
as $$
declare n numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' or p_value::text !~ '^[0-9]+$' then
    raise exception 'Starter amounts must be integer minor units.';
  end if;
  n := p_value::text::numeric;
  if n < p_min or n > p_max then raise exception 'Starter amount is outside allowed limits.'; end if;
  return n::bigint;
end $$;
revoke all on function public.starter_minor(jsonb,bigint,bigint) from public, anon, authenticated;

create function public.create_wedding_from_starter(p_request_key uuid, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  result jsonb; wid uuid; prior boolean; config jsonb := p_input->'starterSetup'; r jsonb; content jsonb; question jsonb;
  tier jsonb; campaign jsonb; milestone jsonb; gift jsonb; offer jsonb; stream_id uuid;
  pos integer := 0; milestone_pos integer; goal bigint;
  fee bigint; extra_fee bigint; meal_fee bigint;
begin
  if auth.uid() is null or not coalesce(public.current_platform_role() in ('client','owner'),false) then
    raise exception 'A signed-in Client account is required to create a wedding workspace.';
  end if;
  if p_request_key is null or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'A create request key and starter answers are required.';
  end if;
  if jsonb_typeof(config) is distinct from 'object' or
      not (config ?& array['currency','reviewed','features','rsvp','tiers','campaigns','registry','vip','featured','content']) or
      config - array['currency','reviewed','features','rsvp','tiers','campaigns','registry','vip','featured','content'] <> '{}'::jsonb or
      config->>'currency' is distinct from p_input->>'currency' or
      config->'reviewed' is distinct from 'true'::jsonb or
      not public.paystack_accounting_currency_supported(config->>'currency') then
    raise exception 'Choose and review starter amounts in a supported accounting currency.';
  end if;
  if jsonb_typeof(config->'features') is distinct from 'object' or
      not (config->'features' ?& array['giving','sponsors','featured_sponsors','song_requests','vip_seating']) or
      config->'features' - array['giving','sponsors','featured_sponsors','song_requests','vip_seating'] <> '{}'::jsonb or
      exists(select 1 from jsonb_each(config->'features') f where jsonb_typeof(f.value) <> 'boolean') then
    raise exception 'Review all starter guest features.';
  end if;
  r := config->'rsvp';
  if jsonb_typeof(r) is distinct from 'object' or
      not (r ?& array['feeMinor','extraGuestFeeMinor','premiumDietFeeMinor','premiumDietOptions']) or
      r - array['feeMinor','extraGuestFeeMinor','premiumDietFeeMinor','premiumDietOptions'] <> '{}'::jsonb or
      jsonb_typeof(r->'premiumDietOptions') is distinct from 'array' or
      jsonb_array_length(r->'premiumDietOptions') > 10 then raise exception 'Check starter RSVP options.'; end if;
  if exists(select 1 from jsonb_array_elements(r->'premiumDietOptions') o where
      jsonb_typeof(o.value) <> 'string' or length(btrim(o.value #>> '{}')) not between 1 and 40) then
    raise exception 'Check premium meal labels.';
  end if;
  fee := public.starter_minor(r->'feeMinor',0,100000000);
  extra_fee := public.starter_minor(r->'extraGuestFeeMinor',0,100000000);
  meal_fee := public.starter_minor(r->'premiumDietFeeMinor',0,100000000);
  content := config->'content';
  if jsonb_typeof(content) is distinct from 'object' or
      not (content ?& array['attire','travel','faq']) or content - array['attire','travel','faq'] <> '{}'::jsonb or
      jsonb_typeof(content->'attire') is distinct from 'string' or length(content->>'attire') > 300 or
      jsonb_typeof(content->'travel') is distinct from 'string' or length(content->>'travel') > 2000 or
      jsonb_typeof(content->'faq') is distinct from 'array' or jsonb_array_length(content->'faq') > 12 then
    raise exception 'Check starter guest guidance.';
  end if;
  for question in select value from jsonb_array_elements(content->'faq') loop
    if jsonb_typeof(question) is distinct from 'object' or
        not (question ?& array['q','a']) or question - array['q','a'] <> '{}'::jsonb or
        jsonb_typeof(question->'q') is distinct from 'string' or length(btrim(question->>'q')) not between 1 and 160 or
        jsonb_typeof(question->'a') is distinct from 'string' or length(question->>'a') > 600 then
      raise exception 'Check starter guest questions.';
    end if;
  end loop;
  if jsonb_typeof(config->'tiers') is distinct from 'array' or jsonb_array_length(config->'tiers') > 6 or
      jsonb_typeof(config->'campaigns') is distinct from 'array' or jsonb_array_length(config->'campaigns') > 6 or
      jsonb_typeof(config->'registry') is distinct from 'array' or jsonb_array_length(config->'registry') > 20 then
    raise exception 'Use up to six packages and six goals.';
  end if;
  -- Same owner/request lock as create_wedding_draft, held through all setup inserts.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_request_key::text,0));
  select exists(select 1 from public.wedding_create_requests
    where client_owner_id=auth.uid() and request_key=p_request_key) into prior;
  if prior then
    result := public.create_wedding_draft(p_request_key,p_input);
    if not exists(select 1 from public.wedding_create_requests where client_owner_id=auth.uid()
        and request_key=p_request_key and starter_applied) then
      raise exception 'CREATE_CONFLICT: This request created an ordinary draft, not an applied starter. Open that draft before continuing.';
    end if;
    return result;
  end if;
  if not exists(select 1 from public.wedding_starter_capability_proofs where
      client_owner_id=auth.uid() and request_key=p_request_key and currency=config->>'currency'
      and input_hash=md5((p_input - 'slug')::text) and checked_at > clock_timestamp() - interval '2 minutes') then
    raise exception 'STARTER_CAPABILITY_REQUIRED: Check current collection support before creating this starter.';
  end if;
  result := public.create_wedding_draft(p_request_key,p_input);
  delete from public.wedding_starter_capability_proofs where client_owner_id=auth.uid() and request_key=p_request_key;
  wid := (result->>'weddingId')::uuid;
  update public.weddings set revenue_features=config->'features', rsvp_fee_minor=fee,
    extra_guest_fee_minor=extra_fee, premium_diet_fee_minor=meal_fee,
    premium_diet_options=array(select jsonb_array_elements_text(r->'premiumDietOptions')),
    attire_notes=content->>'attire', travel_info=content->>'travel', faq=content->'faq',
    enabled_payment_methods='{}'::text[]
  where id=wid and client_owner_id=auth.uid() and published_at is null;
  if not found then raise exception 'New private starter draft not found.'; end if;
  offer := config->'featured';
  if offer <> 'null'::jsonb then
    if jsonb_typeof(offer) is distinct from 'object' or
        not (offer ?& array['slots','minimumMinor','incrementMinor']) or
        offer - array['slots','minimumMinor','incrementMinor'] <> '{}'::jsonb then
      raise exception 'Check featured sponsor structure.';
    end if;
    insert into public.sponsor_featured_campaigns(wedding_id,enabled,starts_at,closes_at,slot_count,
      minimum_bid_minor,bid_increment_minor,updated_by)
    values(wid,false,null,null,public.starter_minor(offer->'slots',1,20)::integer,
      public.starter_minor(offer->'minimumMinor',1,100000000000),
      public.starter_minor(offer->'incrementMinor',1,100000000000),auth.uid());
  end if;
  offer := config->'vip';
  if offer <> 'null'::jsonb then
    if jsonb_typeof(offer) is distinct from 'object' or
        not (offer ?& array['title','description','seats','priceMinor']) or
        offer - array['title','description','seats','priceMinor'] <> '{}'::jsonb or
        jsonb_typeof(offer->'title') is distinct from 'string' or length(btrim(offer->>'title')) not between 1 and 80 or
        jsonb_typeof(offer->'description') is distinct from 'string' or length(offer->>'description') > 240 then
      raise exception 'Check VIP offering.';
    end if;
    insert into public.vip_offers(wedding_id,title,description,seats_total,price_minor)
    values(wid,btrim(offer->>'title'),offer->>'description',public.starter_minor(offer->'seats',1,500)::integer,
      public.starter_minor(offer->'priceMinor',1,100000000000));
  end if;
  for gift in select value from jsonb_array_elements(config->'registry') loop
    if jsonb_typeof(gift) is distinct from 'object' or
        not (gift ?& array['name','category','description','targetMinor']) or
        gift - array['name','category','description','targetMinor'] <> '{}'::jsonb or
        jsonb_typeof(gift->'name') is distinct from 'string' or length(btrim(gift->>'name')) not between 1 and 100 or
        jsonb_typeof(gift->'category') is distinct from 'string' or length(gift->>'category') > 50 or
        jsonb_typeof(gift->'description') is distinct from 'string' or length(gift->>'description') > 240 then
      raise exception 'Check registry goal.';
    end if;
    insert into public.registry_items(wedding_id,name,category,description,target_amount_minor,sort_order)
    values(wid,btrim(gift->>'name'),nullif(gift->>'category',''),gift->>'description',
      public.starter_minor(gift->'targetMinor',100,100000000000),pos);
    pos := pos + 1;
  end loop;
  pos := 0;
  for tier in select value from jsonb_array_elements(config->'tiers') loop
    if jsonb_typeof(tier) is distinct from 'object' or
        not (tier ?& array['name','minimumMinor','perks']) or tier - array['name','minimumMinor','perks'] <> '{}'::jsonb or
        jsonb_typeof(tier->'name') is distinct from 'string' or length(btrim(tier->>'name')) not between 1 and 60 or
        jsonb_typeof(tier->'perks') is distinct from 'string' or length(btrim(tier->>'perks')) not between 1 and 240 then
      raise exception 'Check sponsor package names and offerings.';
    end if;
    insert into public.sponsor_tiers(wedding_id,name,min_amount_minor,perks,sort_order)
    values(wid,btrim(tier->>'name'),public.starter_minor(tier->'minimumMinor',1,100000000000),btrim(tier->>'perks'),pos);
    pos := pos + 1;
  end loop;
  pos := 0;
  for campaign in select value from jsonb_array_elements(config->'campaigns') loop
    if jsonb_typeof(campaign) is distinct from 'object' or
        not (campaign ?& array['name','purpose','goalMinor','enabled','milestones']) or
        campaign - array['name','purpose','goalMinor','enabled','milestones'] <> '{}'::jsonb or
        jsonb_typeof(campaign->'name') is distinct from 'string' or length(btrim(campaign->>'name')) not between 1 and 100 or
        jsonb_typeof(campaign->'purpose') is distinct from 'string' or length(btrim(campaign->>'purpose')) not between 1 and 240 or
        jsonb_typeof(campaign->'enabled') is distinct from 'boolean' or
        jsonb_typeof(campaign->'milestones') is distinct from 'array' or jsonb_array_length(campaign->'milestones') > 10 then
      raise exception 'Check fundraising goals and milestones.';
    end if;
    goal := public.starter_minor(campaign->'goalMinor',1,100000000000);
    insert into public.fundraising_streams(wedding_id,name,purpose,goal_minor,currency,enabled,sort_order)
    values(wid,btrim(campaign->>'name'),btrim(campaign->>'purpose'),goal,config->>'currency',
      (campaign->>'enabled')::boolean,pos) returning id into stream_id;
    milestone_pos := 0;
    for milestone in select value from jsonb_array_elements(campaign->'milestones') loop
      if jsonb_typeof(milestone) is distinct from 'object' or
          not (milestone ?& array['name','targetMinor','description']) or
          milestone - array['name','targetMinor','description'] <> '{}'::jsonb or
          jsonb_typeof(milestone->'name') is distinct from 'string' or length(btrim(milestone->>'name')) not between 1 and 100 or
          jsonb_typeof(milestone->'description') is distinct from 'string' or length(milestone->>'description') > 240 then
        raise exception 'Check milestone labels and descriptions.';
      end if;
      insert into public.fundraising_milestones(stream_id,wedding_id,name,description,target_minor,sort_order)
      values(stream_id,wid,btrim(milestone->>'name'),milestone->>'description',
        public.starter_minor(milestone->'targetMinor',1,goal),milestone_pos);
      milestone_pos := milestone_pos + 1;
    end loop;
    pos := pos + 1;
  end loop;
  update public.wedding_create_requests set starter_applied=true
    where client_owner_id=auth.uid() and request_key=p_request_key;
  return result;
end $$;
revoke all on function public.create_wedding_from_starter(uuid,jsonb) from public, anon;
grant execute on function public.create_wedding_from_starter(uuid,jsonb) to authenticated;
