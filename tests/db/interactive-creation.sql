begin;
create temporary table interactive_fixture(owner_id uuid,key uuid,payload jsonb,result jsonb);
grant select,update on interactive_fixture to authenticated,service_role;
do $$
declare uid uuid := extensions.gen_random_uuid(); c text;
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text||'@example.test',now());
  foreach c in array array['KES','EUR'] loop
    insert into interactive_fixture values(uid,extensions.gen_random_uuid(),jsonb_build_object(
      'slug','interactive-test-'||lower(c),'coupleNames','','currency',c,'maxCapacity',150,
      'palette',jsonb_build_array('#244b3a'),'venues','[]'::jsonb,'starterDeferred',true,'referral',null,
      'starterSetup','{
        "currency":"KES","reviewed":true,"features":{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true},
        "rsvp":{"feeMinor":0,"extraGuestFeeMinor":0,"premiumDietFeeMinor":0,"premiumDietOptions":[]},
        "content":{"attire":"","travel":"","faq":[]},"tiers":[],"registry":[],"vip":null,"featured":null,
        "campaigns":[{"name":"Your celebration","purpose":"Your plans","goalMinor":50000000,"enabled":true,"milestones":[]}]
      }'::jsonb),null);
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
declare f interactive_fixture; w public.weddings; blocked boolean;
begin
  for f in select * from interactive_fixture loop
    select * into w from public.weddings where id=(f.result->>'weddingId')::uuid;
    if not w.interactive_creation or w.published_at is not null or w.rsvp_fee_minor<>0 or
        w.revenue_features is distinct from '{"giving":true,"sponsors":true,"featured_sponsors":true,"song_requests":true,"vip_seating":true}'::jsonb then
      raise exception 'Interactive draft inherited readiness or lost permanent surfaces';
    end if;
    if w.currency='KES' and (select count(*) from public.fundraising_streams
      where wedding_id=w.id and currency='KES' and goal_minor=50000000 and enabled)<>1 then
      raise exception 'KES preset missing or duplicated on replay';
    end if;
    if w.currency='EUR' and (exists(select 1 from public.fundraising_streams where wedding_id=w.id)
      or not exists(select 1 from public.wedding_starter_structures where wedding_id=w.id
        and setup#>'{campaigns,0,goalMinor}'='null'::jsonb)) then
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
    if w.currency='EUR' then
      blocked := false;
      begin update public.weddings set published_at=now() where id=w.id;
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
    public.interactive_fund_preset('EUR','{"currency":"KES","campaigns":[{"goalMinor":12300}]}') is not null then
    raise exception 'Same-currency preset contract failed';
  end if;
end $$;
rollback;
