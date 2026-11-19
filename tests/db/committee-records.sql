-- Isolated local database only; fixtures are rolled back.
begin;
insert into auth.users(id, email, email_confirmed_at) values
  ('91000000-0000-4000-8000-000000000001', 'committee-owner@example.test', now()),
  ('91000000-0000-4000-8000-000000000002', 'committee-other@example.test', now()),
  ('91000000-0000-4000-8000-000000000003', 'committee-helper@example.test', now()),
  ('91000000-0000-4000-8000-000000000004', 'committee-usher@example.test', now());
insert into public.profiles(id, display_name)
  select id, email from auth.users where id::text like '91000000-%' on conflict (id) do nothing;
insert into public.weddings(id, client_owner_id, couple_names, welcome_story) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'Committee One', 'Original story'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000002', 'Committee Two', 'Other story');
insert into public.wedding_team_members(wedding_id, user_id, role, granted_by, expires_at) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'coordinator', '91000000-0000-4000-8000-000000000001', now() + interval '1 day'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000004', 'usher', '91000000-0000-4000-8000-000000000001', null);

do $$
begin
  if has_table_privilege('authenticated', 'public.committee_records', 'select,insert,update,delete')
     or has_function_privilege('anon', 'public.get_committee_records(uuid)', 'execute')
     or has_function_privilege('anon', 'public.create_committee_record(uuid,date,text,text,text,text,date,text,text)', 'execute')
     or has_function_privilege('anon', 'public.set_committee_task(uuid,uuid,boolean)', 'execute')
     or has_function_privilege('anon', 'public.review_committee_suggestion(uuid,uuid,text)', 'execute') then
    raise exception 'Direct or anonymous committee access must be denied';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  wid uuid := '92000000-0000-4000-8000-000000000001';
  other uuid := '92000000-0000-4000-8000-000000000002';
  record_id uuid;
  blocked boolean;
begin
  perform set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
  record_id := public.create_committee_record(wid, current_date, 'Planning', 'Private budget note',
    'Decision', 'Owner', current_date + 1, 'budget', 'Guest wording');
  if public.get_committee_records(wid)->0->>'review_status' <> 'pending' then
    raise exception 'Suggestion must start pending';
  end if;
  blocked := false;
  begin perform public.review_committee_suggestion(wid, record_id, 'approved');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Coordinator cannot approve'; end if;
  blocked := false;
  begin perform public.get_committee_records(other);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Coordinator cannot access another wedding'; end if;
  blocked := false;
  begin perform public.create_committee_record(other, current_date, 'Planning', 'Private', '', '', null, 'task', '');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Coordinator cannot create for another wedding'; end if;
  blocked := false;
  begin perform public.set_committee_task(other, record_id, true);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Coordinator cannot update another wedding'; end if;
  perform public.set_committee_task(wid, record_id, true);
  if (public.get_committee_records(wid)->0->>'task_done')::boolean is not true then
    raise exception 'Task update did not persist';
  end if;
  perform set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000004', true);
  blocked := false;
  begin perform public.get_committee_records(wid);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Usher cannot read committee records'; end if;
  perform set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
  blocked := false;
  begin perform public.review_committee_suggestion(wid, record_id, 'approved');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Another couple cannot approve'; end if;
  perform set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
  perform public.review_committee_suggestion(wid, record_id, 'approved');
  if public.get_committee_records(wid)->0->>'review_status' <> 'approved' then
    raise exception 'Owner review did not persist';
  end if;
  blocked := false;
  begin perform public.review_committee_suggestion(wid, record_id, 'returned');
  exception when invalid_parameter_value then blocked := true; end;
  if not blocked then raise exception 'Reviewed suggestion cannot be reviewed again'; end if;
end $$;
reset role;
do $$
begin
  if (select welcome_story from public.weddings where id = '92000000-0000-4000-8000-000000000001') <> 'Original story' then
    raise exception 'Review must not change public wedding data';
  end if;
  update public.wedding_team_members set expires_at = now() - interval '1 minute'
    where wedding_id = '92000000-0000-4000-8000-000000000001' and user_id = '91000000-0000-4000-8000-000000000003';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
do $$
declare blocked boolean := false;
begin
  begin perform public.get_committee_records('92000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Expired coordinator must lose access'; end if;
end $$;
reset role;
update public.wedding_team_members set expires_at = null, revoked_at = now()
  where wedding_id = '92000000-0000-4000-8000-000000000001' and user_id = '91000000-0000-4000-8000-000000000003';
set local role authenticated;
do $$
declare blocked boolean := false;
begin
  begin perform public.get_committee_records('92000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Revoked coordinator must lose access'; end if;
end $$;
rollback;
