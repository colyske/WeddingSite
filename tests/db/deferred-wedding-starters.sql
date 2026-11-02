begin;
create temporary table deferred_fixture(owner_id uuid,key uuid,payload jsonb,result jsonb);
grant select,update on deferred_fixture to authenticated,service_role;
do $$
declare uid uuid := extensions.gen_random_uuid();
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text || '@example.test',now());
  insert into deferred_fixture values(uid,extensions.gen_random_uuid(),
    jsonb_build_object('slug','deferred-starter-test','coupleNames','','weddingDate',null,'location',null,
      'currency','KES','maxCapacity',150,'palette',jsonb_build_array('#244b3a'),'paletteNames',jsonb_build_array('Forest'),
      'timeZone','Africa/Nairobi','venues',jsonb_build_array(jsonb_build_object('name','Your ceremony','kind','main','sortOrder',0)),
      'referral',null,'starterDeferred',true,'starterSetup','{
        "currency":"KES","reviewed":true,"reviewNote":"Pending source prices.",
        "features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true},
        "rsvp":{"feeMinor":100,"extraGuestFeeMinor":200,"premiumDietFeeMinor":300,"premiumDietOptions":["Your menu"]},
        "tiers":[{"name":"Your package","minimumMinor":250000,"perks":"Your offering"}],
        "registry":[{"name":"Your goal","category":"","description":"Your plans","targetMinor":15000000}],
        "vip":{"title":"Your lounge","description":"Your arrangement","seats":12,"priceMinor":250000},
        "featured":{"slots":3,"minimumMinor":1000000,"incrementMinor":250000},
        "content":{"attire":"Personalize dress guidance.","travel":"Add your travel guidance.","faq":[{"q":"What should guests know?","a":"Personalize."}]},
        "campaigns":[{"name":"Your goal","purpose":"Your plans","goalMinor":15000000,"enabled":true,
          "milestones":[{"name":"Your milestone","description":"","targetMinor":5000000}]}]
      }'::jsonb),null);
end $$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select owner_id::text from deferred_fixture),true);
do $$
declare f deferred_fixture; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  begin perform public.create_deferred_wedding_starter(f.key,f.payload);
  exception when raise_exception then blocked := sqlerrm like 'STARTER_SOURCE_REQUIRED:%'; end;
  if not blocked then raise exception 'Direct client forged a validated source'; end if;
  if has_function_privilege('authenticated','public.stage_wedding_starter_source(uuid,uuid,jsonb)','execute') or
      has_function_privilege('authenticated','public.review_deferred_wedding_starter(uuid,uuid,uuid,jsonb)','execute') then
    raise exception 'Client can bypass source or collection review backend';
  end if;
end $$;
reset role;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.stage_wedding_starter_source(owner_id,key,payload) from deferred_fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
update deferred_fixture set result=public.create_deferred_wedding_starter(key,payload);
do $$
declare f deferred_fixture;
begin
  select * into f from deferred_fixture;
  if public.create_deferred_wedding_starter(f.key,f.payload) is distinct from f.result then
    raise exception 'Retry did not return the same private draft';
  end if;
end $$;
reset role;
do $$
declare f deferred_fixture; wid uuid;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  if not exists(select 1 from public.weddings where id=wid and couple_names='' and published_at is null
      and exists(select 1 from public.wedding_starter_pending where wedding_id=wid
        and setup->>'currency'='KES' and setup->'reviewed'='false'::jsonb)
      and rsvp_fee_minor=0 and extra_guest_fee_minor=0 and premium_diet_fee_minor=0
      and premium_diet_options=array['Your menu'] and cardinality(enabled_payment_methods)=0
      and publication_minimum_enforced and attire_notes='Personalize dress guidance.') then
    raise exception 'Unpaid draft lost source structure or inherited active money/readiness';
  end if;
  if exists(select 1 from public.sponsor_tiers where wedding_id=wid) or
      exists(select 1 from public.fundraising_streams where wedding_id=wid) or
      exists(select 1 from public.registry_items where wedding_id=wid) or
      exists(select 1 from public.vip_offers where wedding_id=wid) or
      exists(select 1 from public.sponsor_featured_campaigns where wedding_id=wid) or
      exists(select 1 from public.contributions where wedding_id=wid) or
      exists(select 1 from public.guest_rsvps where wedding_id=wid) then
    raise exception 'Deferred draft applied prices or copied activity';
  end if;
  if exists(select 1 from public.wedding_starter_sources where owner_id=f.owner_id) or
      exists(select 1 from public.wedding_starter_capability_proofs where client_owner_id=f.owner_id) then
    raise exception 'Unpaid create retained source proof or invented collection proof';
  end if;
  -- The service backend only stages normalized data; force a late failure to test atomic apply.
  update public.wedding_starter_pending set setup=jsonb_set(setup,
    '{campaigns,0,milestones,0,targetMinor}','15000001'::jsonb) where wedding_id=wid;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare f deferred_fixture; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  begin perform public.review_deferred_wedding_starter(f.owner_id,(f.result->>'weddingId')::uuid,f.key,
    '{"currency":"KES","decision":"apply","reviewed":true}'::jsonb);
  exception when raise_exception then blocked := sqlerrm like 'Starter amount is outside allowed limits.%'; end;
  if not blocked then raise exception 'Late invalid milestone was accepted'; end if;
end $$;
reset role;
do $$
declare f deferred_fixture; wid uuid;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  if exists(select 1 from public.sponsor_tiers where wedding_id=wid) or
      exists(select 1 from public.wedding_starter_reviews where wedding_id=wid) or
      not exists(select 1 from public.weddings where id=wid and rsvp_fee_minor=0) or
      not exists(select 1 from public.wedding_starter_pending where wedding_id=wid) then
    raise exception 'Failed apply left partial config or consumed pending review';
  end if;
  update public.wedding_starter_pending set setup=jsonb_set(f.payload->'starterSetup','{reviewed}','false'::jsonb)
    where wedding_id=wid;
  update public.weddings set attire_notes='Our personalized attire' where id=wid;
end $$;
set local role service_role;
do $$
declare f deferred_fixture; wid uuid; answer jsonb; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  begin perform public.review_deferred_wedding_starter(extensions.gen_random_uuid(),wid,f.key,
    '{"currency":"KES","decision":"apply","reviewed":true}'::jsonb);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Foreign owner reviewed a starter'; end if;
  answer := public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
    '{"currency":"KES","decision":"apply","reviewed":true}'::jsonb);
  if public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
      '{"currency":"KES","decision":"apply","reviewed":true}'::jsonb) is distinct from answer then
    raise exception 'Apply retry was not idempotent';
  end if;
  blocked := false;
  begin perform public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
    '{"currency":"KES","decision":"omit","reviewed":true}'::jsonb);
  exception when raise_exception then blocked := sqlerrm like 'CREATE_CONFLICT:%'; end;
  if not blocked then raise exception 'Changed review replay bypassed input hash'; end if;
end $$;
reset role;
do $$
declare f deferred_fixture; wid uuid;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  if (select count(*) from public.sponsor_tiers where wedding_id=wid) <> 1 or
      (select count(*) from public.fundraising_streams where wedding_id=wid) <> 1 or
      (select count(*) from public.fundraising_milestones where wedding_id=wid) <> 1 or
      exists(select 1 from public.wedding_starter_pending where wedding_id=wid) or
      not exists(select 1 from public.weddings where id=wid and
        currency='KES' and rsvp_fee_minor=100 and attire_notes='Our personalized attire' and published_at is null
        and cardinality(enabled_payment_methods)=0) or
      not exists(select 1 from public.sponsor_featured_campaigns where wedding_id=wid and
        not enabled and starts_at is null and closes_at is null) then
    raise exception 'Reviewed setup was duplicated, incomplete or overwrote personalized content';
  end if;
end $$;
-- A second draft exercises private pending reads, publication and explicit omission.
update deferred_fixture set key=extensions.gen_random_uuid(),
  payload=jsonb_set(payload,'{slug}','"deferred-omit-test"'::jsonb),result=null;
set local role service_role;
select public.stage_wedding_starter_source(owner_id,key,payload) from deferred_fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
update deferred_fixture set result=public.create_deferred_wedding_starter(key,payload);
do $$
declare f deferred_fixture; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  if not exists(select 1 from public.wedding_starter_pending where wedding_id=(f.result->>'weddingId')::uuid) then
    raise exception 'Owner cannot read pending source setup';
  end if;
  begin delete from public.wedding_starter_pending where wedding_id=(f.result->>'weddingId')::uuid;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Client can clear pending review without explicit service review'; end if;
end $$;
select set_config('request.jwt.claim.sub',extensions.gen_random_uuid()::text,true);
do $$ begin
  if exists(select 1 from public.wedding_starter_pending) then
    raise exception 'Another account can read pending source configuration';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub',(select owner_id::text from deferred_fixture),true);
do $$
declare f deferred_fixture; wid uuid; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  begin update public.weddings set published_at=now() where id=wid;
  exception when raise_exception then blocked := sqlerrm like 'PUBLISH_INCOMPLETE:%'; end;
  if not blocked then raise exception 'Unreviewed source setup allowed publication'; end if;
  update public.weddings set currency='USD' where id=wid;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare f deferred_fixture; wid uuid; blocked boolean := false;
begin
  select * into f from deferred_fixture;
  wid := (f.result->>'weddingId')::uuid;
  begin perform public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
    '{"currency":"USD","decision":"apply","reviewed":true}'::jsonb);
  exception when raise_exception then blocked := sqlerrm like 'Source prices cannot be relabelled%'; end;
  if not blocked or not exists(select 1 from public.wedding_starter_pending where wedding_id=wid) then
    raise exception 'Foreign-currency application consumed pending setup';
  end if;
  update public.weddings set currency='KES',rsvp_fee_minor=1234 where id=wid;
  blocked := false;
  begin perform public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
    '{"currency":"KES","decision":"apply","reviewed":true}'::jsonb);
  exception when raise_exception then blocked := sqlerrm like 'CREATE_CONFLICT:%'; end;
  if not blocked then raise exception 'Apply overwrote personalized money'; end if;
  perform public.review_deferred_wedding_starter(f.owner_id,wid,f.key,
    '{"currency":"KES","decision":"omit","reviewed":true}'::jsonb);
  if exists(select 1 from public.wedding_starter_pending where wedding_id=wid) or
      not exists(select 1 from public.weddings where id=wid and rsvp_fee_minor=1234 and currency='KES') or
      exists(select 1 from public.sponsor_tiers where wedding_id=wid) then
    raise exception 'Explicit omission discarded personalized settings or applied source money';
  end if;
end $$;
reset role;
rollback;
