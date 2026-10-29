-- Isolated local CI only; every fixture and side effect is rolled back.
begin;
create temporary table moderation_actors(kind text, id uuid);
grant select on moderation_actors to authenticated;
do $$
declare k text; u uuid; wid uuid := extensions.gen_random_uuid(); cid uuid;
begin
  foreach k in array array['owner','superadmin','admin','client','stranger'] loop
    u := extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at)
      values(u,case when k='owner' then 'colyske@gmail.com' else u::text || '@example.test' end,now());
    if k='owner' then perform public.bootstrap_protected_owner(u);
    elsif k in ('admin','superadmin') then update public.profiles set platform_role=k::public.platform_role where id=u;
    end if;
    insert into moderation_actors values(k,u);
  end loop;
  select id into cid from moderation_actors where kind='client';
  insert into moderation_actors values('wedding',wid);
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date,slug,published_at,first_published_at)
    values(wid,cid,'Local moderation sample','KES',current_date+30,'local-moderation',now(),now());
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,cid,'client');
  insert into public.venues(wedding_id,name,event_date,event_time) values(wid,'Local venue',current_date+30,'12:00');
end $$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare wid uuid; cid uuid; actor record; c jsonb; blocked boolean; v_revision integer; case_id uuid;
begin
  select id into wid from moderation_actors where kind='wedding';
  select id into cid from moderation_actors where kind='client';
  for actor in select * from moderation_actors where kind in ('client','stranger','admin','superadmin','owner') loop
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    blocked := false;
    begin perform public.admin_moderation_cases();
    exception when raise_exception then blocked := true; end;
    if blocked is distinct from (actor.kind in ('client','stranger')) then raise exception 'Queue role boundary: %',actor.kind; end if;
    blocked := false;
    begin perform public.admin_wedding_action(wid,'unpublish');
    exception when raise_exception then blocked := true; end;
    if not blocked then raise exception 'Reasonless staff restriction must fail'; end if;
  end loop;
  perform set_config('request.jwt.claim.sub',(select id::text from moderation_actors where kind='admin'),true);
  perform public.admin_wedding_action(wid,'unpublish','inaccurate_details',
    'The venue address is inaccurate.','Correct the venue address and describe the change.');
  perform public.admin_wedding_action(wid,'unpublish','inaccurate_details',
    'The venue address is inaccurate.','Correct the venue address and describe the change.');
  if (select count(*) from public.moderation_cases where wedding_id=wid) <> 1 then raise exception 'Restriction retry duplicated case'; end if;
  select id into case_id from public.moderation_cases where wedding_id=wid;
  blocked := false;
  begin perform public.unpublish_wedding(wid,true); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Staff alternate reasonless RPC bypass'; end if;
  blocked := false;
  begin perform public.admin_review_moderation_case(case_id,'republish',null,1); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Cannot approve before Client correction'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from moderation_actors where kind='stranger'),true);
  if exists(select 1 from public.moderation_cases where wedding_id=wid) then raise exception 'Stranger direct RLS leak'; end if;
  blocked := false;
  begin perform public.submit_moderation_correction(case_id,'I corrected the address.',1); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Stranger cannot submit'; end if;
  perform set_config('request.jwt.claim.sub',cid::text,true);
  c := public.wedding_moderation_status(wid);
  if c->>'reason' <> 'The venue address is inaccurate.' then raise exception 'Client must see reason'; end if;
  blocked := false;
  begin update public.weddings set archived_at=null,first_published_at=null where id=wid;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Direct lifecycle UPDATE bypass'; end if;
  blocked := false;
  begin perform public.publish_wedding_with_fee(wid,true); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Client publish bypass'; end if;
  blocked := false;
  begin perform public.archive_wedding(wid,false); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Client restore bypass'; end if;
  perform public.unpublish_wedding(wid,true);
  if not (select lifecycle_admin_restricted from public.weddings where id=wid) then raise exception 'Client unpublish cleared restriction'; end if;
  blocked := false;
  begin perform public.submit_moderation_correction(case_id,'I corrected the address.',99); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Stale correction must fail'; end if;
  perform public.submit_moderation_correction(case_id,'I corrected the address.',1);
  perform public.submit_moderation_correction(case_id,'I corrected the address.',1);
  c := public.wedding_moderation_status(wid);
  if c->>'status' <> 'submitted' or (c->>'revision')::int <> 2 then raise exception 'Submission retry changed revision'; end if;
  blocked := false;
  begin perform public.admin_review_moderation_case(case_id,'lift',null,2); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Client staff-review bypass'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from moderation_actors where kind='admin'),true);
  blocked := false;
  begin perform public.publish_wedding_with_fee(wid,true); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Staff generic publish bypass'; end if;
  blocked := false;
  begin perform public.admin_review_moderation_case(case_id,'return',null,2); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Reasonless return bypass'; end if;
  perform public.admin_review_moderation_case(case_id,'return','Please also correct the map link.',2);
  perform set_config('request.jwt.claim.sub',cid::text,true);
  c := public.wedding_moderation_status(wid);
  if c->>'staff_note' <> 'Please also correct the map link.' then raise exception 'Returned guidance must be visible'; end if;
  perform public.submit_moderation_correction(case_id,'I fixed the map link too.',3);
  perform set_config('request.jwt.claim.sub',(select id::text from moderation_actors where kind='superadmin'),true);
  blocked := false;
  begin perform public.admin_review_moderation_case(case_id,'republish',null,2); exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Stale staff decision bypass'; end if;
  perform public.admin_review_moderation_case(case_id,'republish',null,4);
  perform public.admin_review_moderation_case(case_id,'republish',null,4);
  if not (select published_at is not null and not lifecycle_admin_restricted from public.weddings where id=wid) then raise exception 'Review did not republish'; end if;
  perform set_config('request.jwt.claim.sub',cid::text,true);
  c := public.wedding_moderation_status(wid);
  if jsonb_array_length(c->'history') <> 5 then raise exception 'History missing or duplicate events: %',c; end if;
  blocked := false;
  begin update public.moderation_cases set status='resolved' where id=case_id; exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Direct case UPDATE bypass'; end if;
end $$;
reset role;
do $$
declare blocked boolean;
begin
  blocked := false;
  begin delete from public.moderation_case_events;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'History deletion must fail even for service execution'; end if;
end $$;
set local role anon;
do $$
declare blocked boolean;
begin
  blocked := false;
  begin perform public.admin_moderation_cases(); exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Anonymous queue access'; end if;
  blocked := false;
  begin perform 1 from public.moderation_cases; exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Anonymous reason leak'; end if;
end $$;
rollback;
