-- Authored for isolated local/CI verification only. Not executed by the feature author.
begin;
create temporary table starter_fixture(owner_id uuid,key uuid,payload jsonb,result jsonb);
grant select,update on starter_fixture to authenticated, service_role;
do $$
declare uid uuid := extensions.gen_random_uuid();
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text || '@example.test',now());
  insert into starter_fixture values(uid,extensions.gen_random_uuid(),
    jsonb_build_object('slug','local-starter-draft','coupleNames','Our own names','weddingDate',null,'location',null,
      'currency','KES','maxCapacity',150,'palette',jsonb_build_array('#244b3a'),'paletteNames',jsonb_build_array('Forest'),
      'timeZone','Africa/Nairobi','venues',jsonb_build_array(
        jsonb_build_object('name','Pre-wedding activity','kind','pre','sortOrder',0),
        jsonb_build_object('name','Wedding-day event','kind','main','sortOrder',1)),
      'referral',null,'starterSetup','{
        "currency":"KES","reviewed":true,
        "features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true},
        "rsvp":{"feeMinor":0,"extraGuestFeeMinor":0,"premiumDietFeeMinor":0,"premiumDietOptions":["Our menu"]},
        "tiers":[{"name":"Our package","minimumMinor":250000,"perks":"Our offering"}],
        "registry":[{"name":"Our gift goal","category":"Home","description":"Our own plans","targetMinor":15000000}],
        "vip":{"title":"Our lounge","description":"Our arrangement","seats":12,"priceMinor":250000},
        "amountPresets":null,
        "campaigns":[{"name":"Our goal","purpose":"Our own celebration","goalMinor":15000000,"enabled":true,
          "milestones":[{"name":"First milestone","description":"Our milestone","targetMinor":5000000}]}]
      }'::jsonb),null);
end $$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select owner_id::text from starter_fixture),true);
do $$
declare f starter_fixture; blocked boolean := false;
begin
  select * into f from starter_fixture;
  begin perform public.create_wedding_from_starter(f.key,f.payload);
  exception when raise_exception then blocked := sqlerrm like 'STARTER_CAPABILITY_REQUIRED:%'; end;
  if not blocked then raise exception 'Direct authenticated RPC bypassed current-currency proof'; end if;
  if has_table_privilege('authenticated','public.wedding_starter_capability_proofs','insert') or
      has_function_privilege('authenticated','public.stage_wedding_starter_capability(uuid,uuid,jsonb)','execute') then
    raise exception 'Clients can forge starter readiness';
  end if;
  if exists(select 1 from public.weddings where client_owner_id=f.owner_id) then raise exception 'Failed proof left a draft'; end if;
end $$;
reset role;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.stage_wedding_starter_capability(owner_id,key,payload) from starter_fixture;
reset role;
update public.wedding_starter_capability_proofs set checked_at=now()-interval '3 minutes';
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare f starter_fixture; blocked boolean := false;
begin
  select * into f from starter_fixture;
  begin perform public.create_wedding_from_starter(f.key,f.payload);
  exception when raise_exception then blocked := sqlerrm like 'STARTER_CAPABILITY_REQUIRED:%'; end;
  if not blocked then raise exception 'Expired capability proof was accepted'; end if;
end $$;
reset role;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.stage_wedding_starter_capability(owner_id,key,
  jsonb_set(payload,'{starterSetup,campaigns,0,milestones,0,targetMinor}','15000001'::jsonb)) from starter_fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare f starter_fixture; blocked boolean := false;
begin
  select * into f from starter_fixture;
  begin perform public.create_wedding_from_starter(f.key,
    jsonb_set(f.payload,'{starterSetup,campaigns,0,milestones,0,targetMinor}','15000001'::jsonb));
  exception when raise_exception then blocked := sqlerrm like 'Starter amount is outside allowed limits.%'; end;
  if not blocked then raise exception 'Invalid late milestone was accepted'; end if;
  if exists(select 1 from public.weddings where client_owner_id=f.owner_id) or
      exists(select 1 from public.wedding_create_requests where client_owner_id=f.owner_id and request_key=f.key) then
    raise exception 'Late starter failure left a partial draft or request';
  end if;
end $$;
reset role;
do $$
begin
  if not exists(select 1 from public.wedding_starter_capability_proofs p join starter_fixture f
      on p.client_owner_id=f.owner_id and p.request_key=f.key) then
    raise exception 'Failed transaction consumed its proof';
  end if;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.stage_wedding_starter_capability(owner_id,key,payload) from starter_fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare f starter_fixture; created jsonb; replay jsonb; wid uuid; blocked boolean;
begin
  select * into f from starter_fixture;
  blocked := false;
  begin perform public.create_wedding_from_starter(f.key,jsonb_set(f.payload,'{starterSetup,rsvp,feeMinor}','100'::jsonb));
  exception when raise_exception then blocked := sqlerrm like 'STARTER_CAPABILITY_REQUIRED:%'; end;
  if not blocked then raise exception 'Proof did not bind the entire input'; end if;
  created := public.create_wedding_from_starter(f.key,f.payload);
  wid := (created->>'weddingId')::uuid;
  update starter_fixture set result=created;
  if (select count(*) from public.sponsor_tiers where wedding_id=wid) <> 1 or
      (select count(*) from public.fundraising_streams where wedding_id=wid) <> 1 or
      (select count(*) from public.fundraising_milestones where wedding_id=wid) <> 1 or
      (select count(*) from public.registry_items where wedding_id=wid) <> 1 or
      (select seats_sold from public.vip_offers where wedding_id=wid) <> 0 then
    raise exception 'Starter configuration was not saved exactly once with zero sold seats';
  end if;
  if exists(select 1 from public.weddings where id=wid and
      (published_at is not null or wedding_date is not null or public_location is not null)) or
      exists(select 1 from public.venues where wedding_id=wid and (event_date is not null or event_time is not null or address is not null)) or
      exists(select 1 from public.contributions where wedding_id=wid) or
      exists(select 1 from public.sponsors where wedding_id=wid) or
      exists(select 1 from public.guest_rsvps where wedding_id=wid) then raise exception 'Starter copied facts or activity'; end if;
  if (select array_agg(kind order by sort_order) from public.venues where wedding_id=wid) <> array['pre','main'] then
    raise exception 'Pre-wedding and wedding-day event order/type lost';
  end if;
  update public.sponsor_tiers set name='Later personalized package' where wedding_id=wid;
  replay := public.create_wedding_from_starter(f.key,f.payload);
  if replay <> created or (select name from public.sponsor_tiers where wedding_id=wid) <> 'Later personalized package' then
    raise exception 'Replay duplicated or overwrote later edits';
  end if;
  blocked := false;
  begin perform public.create_wedding_from_starter(f.key,jsonb_set(f.payload,'{starterSetup,rsvp,feeMinor}','100'::jsonb));
  exception when raise_exception then blocked := sqlerrm like 'CREATE_CONFLICT:%'; end;
  if not blocked then raise exception 'Changed starter input bypassed idempotency hash'; end if;
end $$;
reset role;
do $$
declare f starter_fixture;
begin
  select * into f from starter_fixture;
  if exists(select 1 from public.wedding_starter_capability_proofs where client_owner_id=f.owner_id and request_key=f.key) then
    raise exception 'Capability proof was not consumed';
  end if;
end $$;
rollback;
