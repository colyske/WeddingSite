begin;
create temporary table interactive_fixture(owner_id uuid,key uuid,payload jsonb,result jsonb);
grant select,update on interactive_fixture to authenticated,service_role;
do $$
declare uid uuid := extensions.gen_random_uuid(); c text; source_currency text; goal bigint; milestone bigint;
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text||'@example.test',now());
  for c,source_currency,goal,milestone in values
    ('KES','KES',140000000::bigint,80000000::bigint),
    ('EUR','KES',140000000::bigint,80000000::bigint),
    ('KES','KES',23000000::bigint,12000000::bigint),
    ('EUR','EUR',12300::bigint,9000::bigint),
    ('KES','EUR',12300::bigint,9000::bigint)
  loop
    insert into interactive_fixture values(uid,extensions.gen_random_uuid(),jsonb_build_object(
      'slug','interactive-test-'||substr(extensions.gen_random_uuid()::text,1,8),'coupleNames','','currency',c,'maxCapacity',150,
      'palette',jsonb_build_array('#244b3a'),'paletteNames','[]'::jsonb,'timeZone','Africa/Nairobi',
      'venues','[]'::jsonb,'starterDeferred',true,'referral',null,
      'starterSetup',jsonb_set(jsonb_set(jsonb_set('{
        "currency":"KES","reviewed":true,"features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true},
        "rsvp":{"feeMinor":0,"extraGuestFeeMinor":0,"premiumDietFeeMinor":0,"premiumDietOptions":[]},
        "content":{"attire":"","travel":"","faq":[]},"tiers":[],"registry":[],"vip":null,"featured":null,
        "campaigns":[{"name":"Your celebration","purpose":"Your plans","goalMinor":1,"enabled":true,"milestones":[{"name":"Your milestone","description":"","targetMinor":1}]}]
      }'::jsonb,'{currency}',to_jsonb(source_currency)),'{campaigns,0,goalMinor}',to_jsonb(goal)),
        '{campaigns,0,milestones,0,targetMinor}',to_jsonb(milestone))),null);
  end loop;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.stage_wedding_starter_source(owner_id,key,payload) from interactive_fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select owner_id::text from interactive_fixture limit 1),true);
update interactive_fixture set result=public.create_interactive_wedding(key,payload);
do $$
declare f interactive_fixture;
begin
  for f in select * from interactive_fixture loop
    if public.create_interactive_wedding(f.key,f.payload) is distinct from f.result then
      raise exception 'Interactive create replay was not idempotent';
    end if;
  end loop;
end $$;
reset role;
do $$
declare f interactive_fixture; w public.weddings; blocked boolean; invalid jsonb;
begin
  for f in select * from interactive_fixture loop
    select * into w from public.weddings where id=(f.result->>'weddingId')::uuid;
    if not w.interactive_creation or w.published_at is not null or w.rsvp_fee_minor<>0 or
        w.revenue_features is distinct from '{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}'::jsonb then
      raise exception 'Interactive draft inherited readiness or lost permanent surfaces';
    end if;
    if w.currency=f.payload#>>'{starterSetup,currency}' and (
      (select count(*) from public.fundraising_streams where wedding_id=w.id and currency=w.currency
        and goal_minor=(f.payload#>>'{starterSetup,campaigns,0,goalMinor}')::bigint and enabled)<>1 or
      (select count(*) from public.fundraising_milestones where wedding_id=w.id
        and target_minor=(f.payload#>>'{starterSetup,campaigns,0,milestones,0,targetMinor}')::bigint)<>1) then
      raise exception 'Matching-currency goal or milestone missing or duplicated on replay';
    end if;
    if w.currency='KES' and f.payload#>>'{starterSetup,currency}'='EUR' and
      ((select count(*) from public.fundraising_streams where wedding_id=w.id and goal_minor=50000000)<>1 or
       exists(select 1 from public.fundraising_milestones where wedding_id=w.id)) then
      raise exception 'KES fallback copied foreign milestone amounts';
    end if;
    if w.currency='EUR' and f.payload#>>'{starterSetup,currency}'='KES' and (exists(select 1 from public.fundraising_streams where wedding_id=w.id)
      or not exists(select 1 from public.wedding_starter_structures where wedding_id=w.id
        and setup#>'{campaigns,0,goalMinor}'='null'::jsonb
        and setup#>'{campaigns,0,milestones,0,targetMinor}'='null'::jsonb)) then
      raise exception 'Foreign currency copied KES money or lost incomplete goal';
    end if;
    update public.weddings set revenue_features='{"giving":false,"song_requests":false}' where id=w.id;
    if exists(select 1 from public.weddings where id=w.id and revenue_features->'giving'<>'true'::jsonb) then
      raise exception 'Mandatory revenue could be disabled';
    end if;
    blocked := false;
    begin update public.weddings set interactive_creation=false where id=w.id;
    exception when raise_exception then blocked := sqlerrm like 'The creation experience%'; end;
    if not blocked then raise exception 'Immutable creation mode could be cleared'; end if;
    if w.currency='EUR' and f.payload#>>'{starterSetup,currency}'='KES' then
      blocked := false;
      begin update public.weddings set published_at=now(),creation_content_reviewed=true where id=w.id;
      exception when raise_exception then blocked := sqlerrm like 'Keep at least one visible fund%'; end;
      if not blocked then raise exception 'Unpriced fund bypassed publication invariant'; end if;
    end if;
    if exists(select 1 from public.contributions where wedding_id=w.id) or
      exists(select 1 from public.guest_rsvps where wedding_id=w.id) then
      raise exception 'Creation invented guest activity';
    end if;
  end loop;
  if has_function_privilege('anon','public.create_interactive_wedding(uuid,jsonb)','execute') or
    has_function_privilege('authenticated','public.interactive_fund_preset(text,jsonb)','execute') then
    raise exception 'Interactive creation grants are too broad';
  end if;
  if public.interactive_fund_preset('EUR','{"currency":"EUR","campaigns":[{"goalMinor":12300}]}')<>12300 or
    public.interactive_fund_preset('EUR','{"currency":"KES","campaigns":[{"goalMinor":12300}]}') is not null or
    public.interactive_fund_preset('KES','{"currency":"KES","campaigns":[{"goalMinor":140000000}]}')<>140000000 or
    public.interactive_fund_preset('KES','{"currency":"EUR","campaigns":[{"goalMinor":12300}]}')<>50000000 or
    public.interactive_fund_preset('KES','{"currency":"KES","campaigns":[{"goalMinor":null}]}')<>50000000 or
    public.interactive_fund_preset('EUR','{"currency":"EUR","campaigns":[]}') is not null or
    public.interactive_fund_preset('EUR','{"currency":"KES","campaigns":[{"goalMinor":-1}]}') is not null then
    raise exception 'Same-currency preset contract failed';
  end if;
  for invalid in select value from jsonb_array_elements('[-1,1.5,"123",{},true]') loop
    blocked := false;
    begin perform public.interactive_fund_preset('KES',jsonb_build_object('currency','KES',
      'campaigns',jsonb_build_array(jsonb_build_object('goalMinor',invalid))));
    exception when raise_exception then blocked := sqlerrm like 'Starter amounts must be integer minor units%'; end;
    if not blocked then raise exception 'Invalid starter goal did not reject as non-integer: %',invalid; end if;
  end loop;
  for invalid in select value from jsonb_array_elements('[0,100000000001]') loop
    blocked := false;
    begin perform public.interactive_fund_preset('KES',jsonb_build_object('currency','KES',
      'campaigns',jsonb_build_array(jsonb_build_object('goalMinor',invalid))));
    exception when raise_exception then blocked := sqlerrm like 'Starter amount is outside allowed limits%'; end;
    if not blocked then raise exception 'Invalid starter goal did not reject as out of bounds: %',invalid; end if;
  end loop;
end $$;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare wid uuid := (select (result->>'weddingId')::uuid from interactive_fixture where payload->>'currency'='EUR' and payload#>>'{starterSetup,currency}'='KES');
  blocked boolean := false;
begin
  begin perform public.save_interactive_fundraising_campaigns(wid,
    '[{"name":"Stale KES goal","goal_minor":50000000,"enabled":true,"milestones":[]}]','KES');
  exception when raise_exception then blocked := sqlerrm like 'Your wedding currency changed%'; end;
  if not blocked then raise exception 'Stale currency goal was relabelled'; end if;
  perform public.save_interactive_fundraising_campaigns(wid,
    '[{"name":"Explicit EUR goal","goal_minor":120000,"enabled":true,"milestones":[]}]','EUR');
end $$;
reset role;
do $$
declare wid uuid := (select (result->>'weddingId')::uuid from interactive_fixture where payload->>'currency'='EUR' and payload#>>'{starterSetup,currency}'='KES');
begin
  if not exists(select 1 from public.fundraising_streams where wedding_id=wid and currency='EUR' and goal_minor=120000) then
    raise exception 'Explicit same-currency goal was not saved';
  end if;
end $$;
rollback;
