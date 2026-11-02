-- Isolated local/CI database only. Fixtures and all writes roll back.
begin;
create temporary table draft_actors(kind text, id uuid);
grant select on draft_actors to authenticated;
create function public.guided_test_seed_collection_capability(p_wedding_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare selected_provider text;
begin
  select providers.provider into selected_provider
  from public.platform_policies p
  cross join unnest(p.enabled_payment_providers) as providers(provider)
  where providers.provider in ('stripe','paystack','daraja')
  limit 1;
  if selected_provider is null then raise exception 'No enabled provider for local readiness fixture'; end if;
  insert into public.wedding_collection_capabilities(wedding_id,provider,currency,market)
    values(p_wedding_id,selected_provider,'USD','US');
end $$;
grant execute on function public.guided_test_seed_collection_capability(uuid) to authenticated;
do $$
declare k text; uid uuid;
begin
  foreach k in array array['client','stranger','admin'] loop
    uid := extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text || '@example.test',now());
    if k='admin' then update public.profiles set platform_role='admin' where id=uid; end if;
    insert into draft_actors values(k,uid);
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='client'),true);
do $$
declare key uuid := extensions.gen_random_uuid(); result jsonb; replay jsonb; w public.weddings; vid uuid; q jsonb;
  payload jsonb := jsonb_build_object('slug','local-guided-draft','coupleNames','Local draft couple',
    'weddingDate',null,'location',null,'currency','USD','maxCapacity',150,
    'palette',jsonb_build_array('#244b3a'),'paletteNames',jsonb_build_array('Forest Green'),
    'timeZone','Africa/Nairobi','venues','[]'::jsonb,'referral',null);
  blocked boolean; missing text[]; case_id uuid; before_publish jsonb; consent jsonb; disclosure jsonb;
begin
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='stranger'),true);
  consent := public.referral_set_consent(true,'client-referrals-v1');
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='client'),true);
  perform public.referral_capture(consent->>'code');
  blocked := false;
  begin perform public.create_wedding_draft(key,payload);
  exception when raise_exception then blocked := sqlerrm like 'REFERRAL_CONFLICT:%'; end;
  if not blocked then raise exception 'Draft creation without a referral body bypassed a pending intent'; end if;
  disclosure := public.referral_disclosure();
  payload := payload || jsonb_build_object('referral',jsonb_build_object(
    'intentId',disclosure->>'intent_id','decision','accept',
    'revision',disclosure->>'revision','termsVersion',disclosure->>'terms_version'));
  result := public.create_wedding_draft(key,payload);
  replay := public.create_wedding_draft(key,payload);
  if result <> replay then raise exception 'An identical create retry must return the same wedding'; end if;
  if public.referral_disclosure()->>'intent_id' is not null then raise exception 'Created draft did not consume referral intent'; end if;
  select * into w from public.weddings where id=(result->>'weddingId')::uuid;
  if w.wedding_date is not null or w.public_location is not null or w.published_at is not null
      or exists(select 1 from public.venues where wedding_id=w.id) then raise exception 'No fabricated draft answers'; end if;
  if (select count(*) from public.weddings where client_owner_id=auth.uid()) <> 1 then raise exception 'Create duplicated wedding'; end if;
  blocked := false;
  begin perform public.create_wedding_draft(key,payload || '{"coupleNames":"Changed answer"}'::jsonb);
  exception when raise_exception then blocked := sqlerrm like 'CREATE_CONFLICT:%'; end;
  if not blocked then raise exception 'Ambiguous retry must not silently lose changed answers'; end if;
  q := public.publication_quote(w.id);
  if q->>'code' <> 'pending_date' or q->'fee_minor' <> 'null'::jsonb or q->>'pending_date' <> 'true' then
    raise exception 'Unknown date must not receive a final fee quote: %',q;
  end if;
  missing := public.wedding_publication_readiness(w.id);
  if not ('wedding-date'=any(missing) and 'venues-section'=any(missing)
      and 'welcome-story'=any(missing) and 'cover-image-url'=any(missing)
      and 'guest-instructions'=any(missing) and 'fundraising-route'=any(missing))
      or 'location'=any(missing) then
    raise exception 'Actionable required content must be returned';
  end if;
  blocked := false;
  begin perform public.publish_wedding_with_fee(w.id,true); exception when raise_exception then blocked:=true; end;
  if not blocked then raise exception 'Direct Client RPC published incomplete draft'; end if;
  perform public.save_wedding_content(w.id,'{"welcome_story":"Plans are taking shape."}'::jsonb);
  if (select wedding_date from public.weddings where id=w.id) is not null then raise exception 'Omitted date changed'; end if;
  perform public.save_wedding_content(w.id,'{}'::jsonb,'[{"name":"","address":"Garden Road"}]'::jsonb);
  select id into vid from public.venues where wedding_id=w.id;
  perform public.save_wedding_content(w.id,'{}'::jsonb,jsonb_build_array(jsonb_build_object('id',vid,'name','Garden')));
  if (select address from public.venues where id=vid) <> 'Garden Road' then raise exception 'Omitted event field lost'; end if;
  perform public.save_wedding_content(w.id,jsonb_build_object('wedding_date',current_date+30,'public_location','Nairobi'));
  if (select count(*) from public.venues where wedding_id=w.id) <> 1 then raise exception 'Omitted venue list lost'; end if;
  perform public.save_wedding_content(w.id,'{"wedding_date":null,"public_location":null}'::jsonb,'[]'::jsonb);
  if (select wedding_date from public.weddings where id=w.id) is not null or
    (select public_location from public.weddings where id=w.id) is not null or
    exists(select 1 from public.venues where wedding_id=w.id) then raise exception 'Explicit draft clears failed'; end if;
  perform public.save_wedding_content(w.id,jsonb_build_object('wedding_date',current_date+30,'public_location','Nairobi'),
    jsonb_build_array(jsonb_build_object('name','Garden','eventDate',current_date+30,'eventTime','12:00',
      'address','Garden Road','kind','main')));
  -- A staff waiver cannot bypass missing required setup answers.
  perform public.save_wedding_content(w.id,'{"public_location":null}'::jsonb);
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='admin'),true);
  blocked := false;
  begin perform public.publish_wedding_with_fee(w.id,true);
  exception when raise_exception then blocked:=sqlerrm like 'PUBLISH_INCOMPLETE:%'; end;
  if not blocked then raise exception 'Staff publication bypass'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='client'),true);
  perform public.save_wedding_content(w.id,jsonb_build_object(
    'welcome_story','We are excited to celebrate with you.',
    'cover_image_url','https://example.test/celebration.jpg',
    'guest_instructions','Please RSVP by June 1.',
    'revenue_features',jsonb_build_object('giving',true,'sponsors',true,
      'featured_sponsors',true,'song_requests',true,'vip_seating',true)));
  insert into public.registry_items(wedding_id,name,target_amount_minor)
    values(w.id,'Celebration fund',10000);
  perform public.guided_test_seed_collection_capability(w.id);
  missing := public.wedding_publication_readiness(w.id);
  if cardinality(missing) > 0 then raise exception 'Complete approved minimum should be ready without a general location: %',missing; end if;
  perform public.publish_wedding_with_fee(w.id,true);
  -- Assert the new invariants without requiring KYC.
  if not (select published_at is not null from public.weddings where id=w.id) then raise exception 'Complete wedding should publish'; end if;
  set constraints saved_wedding_content immediate;
  update public.weddings set welcome_story='We are looking forward to celebrating with you.' where id=w.id;
  set constraints saved_venue_content immediate;
  update public.venues set address='Updated garden road' where wedding_id=w.id;
  set constraints saved_wedding_content, saved_venue_content deferred;
  select to_jsonb(x) into before_publish from public.weddings x where x.id=w.id;
  blocked := false;
  begin perform public.save_wedding_content(w.id,'{"wedding_date":null}'::jsonb);
  exception when check_violation then blocked:=true; end;
  if not blocked then raise exception 'Published date can be cleared'; end if;
  blocked := false;
  begin perform public.save_wedding_content(w.id,'{}'::jsonb,'[]'::jsonb);
  exception when raise_exception then blocked:=sqlerrm like 'PUBLISH_INCOMPLETE:%'; end;
  if not blocked then raise exception 'Published venues can be cleared'; end if;
  if (select to_jsonb(x) from public.weddings x where x.id=w.id) <> before_publish then raise exception 'Failed save modified published data'; end if;
  blocked := false;
  begin
    delete from public.venues where wedding_id=w.id;
    set constraints saved_venue_content immediate;
  exception when raise_exception then blocked:=sqlerrm like 'PUBLISH_INCOMPLETE:%'; end;
  if not blocked then raise exception 'Direct venue deletion bypass'; end if;
  set constraints saved_venue_content deferred;
  -- Moderation approval must use the same content invariant.
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='admin'),true);
  perform public.admin_wedding_action(w.id,'unpublish','inaccurate_details','The venue address needs correction.','Correct the venue address.');
  select id into case_id from public.moderation_cases where wedding_id=w.id;
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='client'),true);
  perform public.save_wedding_content(w.id,'{"cover_image_url":null}'::jsonb);
  perform public.submit_moderation_correction(case_id,'I reviewed the venue details.',1);
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='admin'),true);
  blocked := false;
  begin perform public.admin_review_moderation_case(case_id,'republish',null,2);
  exception when raise_exception then blocked:=sqlerrm like 'PUBLISH_INCOMPLETE:%'; end;
  if not blocked then raise exception 'Moderation approval bypass'; end if;
  if (select status from public.moderation_cases where id=case_id) <> 'submitted' then raise exception 'Blocked moderation lost pending correction'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='stranger'),true);
  blocked := false;
  begin perform public.save_wedding_content(w.id,'{"welcome_story":"Wrong owner"}'::jsonb);
  exception when raise_exception then blocked:=true; end;
  if not blocked then raise exception 'Stranger saved draft'; end if;
  blocked := false;
  begin perform public.wedding_publication_readiness(w.id);
  exception when raise_exception then blocked:=true; end;
  if not blocked then raise exception 'Stranger read draft readiness'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from draft_actors where kind='admin'),true);
  blocked := false;
  begin perform public.create_wedding_draft(extensions.gen_random_uuid(),payload);
  exception when raise_exception then blocked:=true; end;
  if not blocked then raise exception 'Admin creation role guard lost'; end if;
end $$;
rollback;
