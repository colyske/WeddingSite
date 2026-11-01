-- Isolated local CI only; every fixture and side effect is rolled back.
begin;

create temporary table team_actors(kind text primary key, id uuid, email text);
create temporary table team_invites(kind text primary key, id uuid);
grant select, insert, update on team_actors, team_invites to authenticated;

insert into auth.users(id, email, email_confirmed_at) values
  ('51000000-0000-4000-8000-000000000001', 'couple-one@example.test', now()),
  ('51000000-0000-4000-8000-000000000002', 'couple-two@example.test', now()),
  ('51000000-0000-4000-8000-000000000003', 'replacement-owner@example.test', now()),
  ('51000000-0000-4000-8000-000000000011', 'checkin@example.test', now()),
  ('51000000-0000-4000-8000-000000000012', 'usher@example.test', now()),
  ('51000000-0000-4000-8000-000000000013', 'coordinator@example.test', now()),
  ('51000000-0000-4000-8000-000000000014', 'support@example.test', now()),
  ('51000000-0000-4000-8000-000000000015', 'dj@example.test', now()),
  ('51000000-0000-4000-8000-000000000016', 'expired@example.test', now()),
  ('51000000-0000-4000-8000-000000000017', 'wrong-email@example.test', now()),
  ('51000000-0000-4000-8000-000000000018', 'platform-admin@example.test', now());

insert into public.profiles(id, display_name)
  select id, email from auth.users where id::text like '51000000-%'
  on conflict (id) do nothing;
update public.profiles set platform_role = 'admin'
  where id = '51000000-0000-4000-8000-000000000018';

insert into team_actors(kind, id, email) select 'owner_one', id, email from auth.users where email='couple-one@example.test';
insert into team_actors(kind, id, email) select 'owner_two', id, email from auth.users where email='couple-two@example.test';
insert into team_actors(kind, id, email) select 'replacement_owner', id, email from auth.users where email='replacement-owner@example.test';
insert into team_actors(kind, id, email) select 'checkin', id, email from auth.users where email='checkin@example.test';
insert into team_actors(kind, id, email) select 'usher', id, email from auth.users where email='usher@example.test';
insert into team_actors(kind, id, email) select 'coordinator', id, email from auth.users where email='coordinator@example.test';
insert into team_actors(kind, id, email) select 'support', id, email from auth.users where email='support@example.test';
insert into team_actors(kind, id, email) select 'dj', id, email from auth.users where email='dj@example.test';
insert into team_actors(kind, id, email) select 'expired', id, email from auth.users where email='expired@example.test';
insert into team_actors(kind, id, email) select 'wrong_email', id, email from auth.users where email='wrong-email@example.test';
insert into team_actors(kind, id, email) select 'platform_admin', id, email from auth.users where email='platform-admin@example.test';

insert into public.weddings(id, client_owner_id, couple_names, wedding_date)
values
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'Couple One', current_date + 30),
  ('52000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'Couple Two', current_date + 30);
update public.weddings set slug=case id when '52000000-0000-4000-8000-000000000001'::uuid then 'team-couple-one' else 'team-couple-two' end,
  public_location='Local city' where id in ('52000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002');
insert into public.venues(wedding_id,name,event_date,event_time,address)
  select id,'Local event',wedding_date,'12:00','Local street' from public.weddings
    where id in ('52000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002');
update public.weddings set published_at = now(), time_zone = 'UTC' where id in (
  '52000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000002'
);

insert into public.guest_rsvps(id, wedding_id, guest_email, guest_name, attendance_status, dietary_notes, phone)
values
  ('53000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', 'guest@example.test', 'Roster Guest', 'yes', 'private dietary note', '+254700000000'),
  ('53000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', 'other@example.test', 'Other Wedding Guest', 'yes', null, '+254700000001'),
  ('53000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-000000000001', 'declined@example.test', 'Not Attending', 'no', null, null);

insert into public.guests(wedding_id, name, email, dietary_preference, table_number)
values ('52000000-0000-4000-8000-000000000001', 'Roster Guest', 'guest@example.test', 'Private food note', 'Table 4');

insert into public.dj_song_bids(wedding_id, song_title, artist_name, bid_amount_minor, currency, bidder_name, bidder_email, payment_status)
values
  ('52000000-0000-4000-8000-000000000001', 'Paid Dance', 'Artist One', 900000, 'KES', 'Private Bidder', 'bidder@example.test', 'paid'),
  ('52000000-0000-4000-8000-000000000001', 'Unpaid Request', 'Artist Two', 800000, 'KES', 'Another Bidder', 'other-bidder@example.test', 'pending');

insert into public.wedding_team_members(wedding_id, user_id, role, granted_by, expires_at)
values ('52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000016', 'usher',
  '51000000-0000-4000-8000-000000000001', now() - interval '1 minute');
insert into public.wedding_team_invites(
  wedding_id, role, invitee_email, token_hash, created_by, expires_at
) values (
  '52000000-0000-4000-8000-000000000001', 'usher', 'expired@example.test',
  repeat('9', 64), '51000000-0000-4000-8000-000000000001', now() - interval '1 minute'
);
do $$
begin
  if has_function_privilege('anon', 'public.get_guest_verification(uuid)', 'EXECUTE') then
    raise exception 'QR pass verification must not be callable by anonymous users.';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  owner_id uuid := '51000000-0000-4000-8000-000000000001';
  checkin_id uuid := '51000000-0000-4000-8000-000000000011';
  usher_id uuid := '51000000-0000-4000-8000-000000000012';
  coordinator_id uuid := '51000000-0000-4000-8000-000000000013';
  support_id uuid := '51000000-0000-4000-8000-000000000014';
  dj_id uuid := '51000000-0000-4000-8000-000000000015';
  wid uuid := '52000000-0000-4000-8000-000000000001';
  second_wid uuid := '52000000-0000-4000-8000-000000000002';
  invite_id uuid;
  workspace jsonb;
  first_checkin timestamptz;
  blocked boolean;
  actor record;
  changed integer;
begin
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'email', 'couple-one@example.test', 'role', 'authenticated')::text, true);
  insert into team_invites values
    ('checkin', public.create_wedding_team_invite(wid, 'checkin', 'checkin@example.test', repeat('1', 64), 7)),
    ('usher', public.create_wedding_team_invite(wid, 'usher', 'usher@example.test', repeat('2', 64), 7)),
    ('coordinator', public.create_wedding_team_invite(wid, 'coordinator', 'coordinator@example.test', repeat('3', 64), 7)),
    ('support', public.create_wedding_team_invite(wid, 'rsvp_support', 'support@example.test', repeat('4', 64), 7, null, true)),
    ('dj', public.create_wedding_team_invite(wid, 'dj', 'dj@example.test', repeat('5', 64), 7, now() + interval '5 days')),
    ('checkin-usher', public.create_wedding_team_invite(wid, 'usher', 'checkin@example.test', repeat('a', 64), 7));

  perform set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000002', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '51000000-0000-4000-8000-000000000002', 'email', 'couple-two@example.test', 'role', 'authenticated')::text, true);
  insert into team_invites values
    ('stale-owner', public.create_wedding_team_invite(second_wid, 'dj', 'expired@example.test', repeat('6', 64), 7));

  blocked := false;
  perform set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000018', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '51000000-0000-4000-8000-000000000018', 'email', 'platform-admin@example.test', 'role', 'authenticated')::text, true);
  begin
    perform public.create_wedding_team_invite(wid, 'dj', 'dj@example.test', repeat('7', 64), 7);
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Platform Admin must not grant wedding team access.'; end if;

  perform set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000017', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '51000000-0000-4000-8000-000000000017', 'email', 'wrong-email@example.test', 'role', 'authenticated')::text, true);
  blocked := false;
  begin perform 1 from public.get_wedding_team_invite(repeat('1', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'A forwarded invitation must not disclose invite details.'; end if;
  blocked := false;
  begin perform 1 from public.redeem_wedding_team_invite(repeat('1', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'A forwarded invitation must not grant access.'; end if;

  perform set_config('request.jwt.claim.sub', checkin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', checkin_id, 'email', 'checkin@example.test', 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.get_wedding_team_invite(repeat('1', 64)) where role = 'checkin') then
    raise exception 'The intended helper should be able to inspect their invitation.';
  end if;
  blocked := false;
  begin perform 1 from public.get_guest_verification('53000000-0000-4000-8000-000000000001');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'A pending invitation must not grant check-in access.'; end if;
  if (select wedding_id from public.redeem_wedding_team_invite(repeat('1', 64))) <> wid then
    raise exception 'The helper should be granted only the invited wedding.';
  end if;
  if not exists (select 1 from public.get_guest_verification('53000000-0000-4000-8000-000000000001') where guest_name = 'Roster Guest') then
    raise exception 'An authorized check-in helper should be able to verify a wedding pass.';
  end if;
  perform public.redeem_wedding_team_invite(repeat('a', 64));
  if not public.has_active_wedding_team_role(wid, array['checkin'])
     or not public.has_active_wedding_team_role(wid, array['usher']) then
    raise exception 'One helper account should be able to hold multiple distinct wedding roles.';
  end if;
  blocked := false;
  begin perform * from public.redeem_wedding_team_invite(repeat('1', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'An invitation must be single-use.'; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  workspace := public.get_wedding_team(wid);
  if not exists (
    select 1 from jsonb_array_elements(workspace->'members') member,
      jsonb_array_elements(member->'grants') grant_info
    where member->>'user_id' = checkin_id::text and grant_info->>'role' = 'checkin'
      and (grant_info->>'expires_at')::timestamptz = (current_date + 32)::timestamp at time zone 'UTC'
  ) then raise exception 'Default accepted grant must expire after the event plus one buffer day.'; end if;

  perform set_config('request.jwt.claim.sub', usher_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', usher_id, 'email', 'usher@example.test', 'role', 'authenticated')::text, true);
  perform public.redeem_wedding_team_invite(repeat('2', 64));
  workspace := public.get_wedding_team_workspace(wid);
  if workspace->'guests'->0->>'name' <> 'Roster Guest'
     or workspace->'guests'->0->>'table_number' <> 'Table 4'
     or workspace->'guests'->0->>'checked_in' <> 'false'
     or workspace::text like '%guest_email%' or workspace::text like '%private dietary note%' then
    raise exception 'Usher view must include only the assigned seating roster and check-in status: %', workspace;
  end if;
  if workspace->'rsvp_support' <> '[]'::jsonb or workspace->'playlist' <> '[]'::jsonb
     or workspace->>'can_check_in' <> 'false' then
    raise exception 'Usher must not receive RSVP, DJ, or check-in capabilities.';
  end if;
  blocked := false;
  begin perform 1 from public.get_guest_verification('53000000-0000-4000-8000-000000000001');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'An usher must not verify QR passes or view pass details.'; end if;
  if public.has_wedding_role(wid, array['client']::public.workspace_role[]) then
    raise exception 'A wedding helper must never be treated as a Client membership.';
  end if;

  perform set_config('request.jwt.claim.sub', coordinator_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', coordinator_id, 'email', 'coordinator@example.test', 'role', 'authenticated')::text, true);
  perform public.redeem_wedding_team_invite(repeat('3', 64));
  workspace := public.get_wedding_team_workspace(wid);
  if workspace->>'can_check_in' <> 'true' or jsonb_array_length(workspace->'guests') <> 1 then
    raise exception 'Coordinator should receive only the roster and check-in tasks.';
  end if;

  perform set_config('request.jwt.claim.sub', support_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', support_id, 'email', 'support@example.test', 'role', 'authenticated')::text, true);
  perform public.redeem_wedding_team_invite(repeat('4', 64));
  workspace := public.get_wedding_team_workspace(wid);
  if not exists (
       select 1 from jsonb_array_elements(workspace->'rsvp_support') guest
       where guest->>'guest_email' = 'guest@example.test'
         and guest->>'phone' = '+254700000000'
     )
     or workspace::text like '%dietary_notes%' or workspace::text like '%private dietary note%'
     or jsonb_array_length(workspace->'guests') <> 0 then
    raise exception 'RSVP support should see only essential contact and RSVP fields.';
  end if;

  perform set_config('request.jwt.claim.sub', dj_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', dj_id, 'email', 'dj@example.test', 'role', 'authenticated')::text, true);
  perform public.redeem_wedding_team_invite(repeat('5', 64));
  workspace := public.get_wedding_team_workspace(wid);
  if jsonb_array_length(workspace->'playlist') <> 1
     or workspace->'playlist'->0->>'song_title' <> 'Paid Dance'
     or workspace::text like '%Unpaid Request%' or workspace::text like '%bid_amount_minor%'
     or workspace::text like '%Private Bidder%' then
    raise exception 'DJ should see only the paid song list with no amounts or bidder data.';
  end if;
  changed := 0;
  begin
    update public.dj_song_bids set bid_amount_minor = 1, payment_status = 'paid'
      where wedding_id = wid;
    get diagnostics changed = row_count;
  exception when insufficient_privilege then null;
  end;
  if changed <> 0 then raise exception 'A DJ must not change bid amounts or mark requests paid.'; end if;

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  workspace := public.get_wedding_team(wid);
  if not exists (
    select 1 from jsonb_array_elements(workspace->'members') member,
      jsonb_array_elements(member->'grants') grant_info
    where member->>'user_id' = support_id::text and grant_info->>'role' = 'rsvp_support'
      and grant_info->'expires_at' = 'null'::jsonb
  ) then raise exception 'Explicit no-expiry grants must retain the chosen null expiry.'; end if;
  if not exists (
    select 1 from jsonb_array_elements(workspace->'members') member,
      jsonb_array_elements(member->'grants') grant_info
    where member->>'user_id' = dj_id::text and grant_info->>'role' = 'dj'
      and (grant_info->>'expires_at')::timestamptz = now() + interval '5 days'
  ) then raise exception 'Custom invite grant expiry must survive acceptance.'; end if;

  for actor in select * from team_actors where kind in ('checkin', 'usher', 'dj', 'support') loop
    perform set_config('request.jwt.claim.sub', actor.id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor.id, 'email', actor.email, 'role', 'authenticated')::text, true);
    if public.has_wedding_role(wid, array['client', 'admin']::public.workspace_role[]) then
      raise exception 'Active % must not receive financial workspace roles.', actor.kind;
    end if;
    perform set_config('request.jwt.claim.sub', owner_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'email', 'couple-one@example.test', 'role', 'authenticated')::text, true);
    perform public.set_wedding_team_member_expiry(wid, actor.id, now() - interval '1 minute');
    perform set_config('request.jwt.claim.sub', actor.id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor.id, 'email', actor.email, 'role', 'authenticated')::text, true);
    if public.has_active_wedding_team_role(wid, array['checkin', 'usher', 'dj', 'rsvp_support'])
       or public.has_wedding_role(wid, array['client', 'admin']::public.workspace_role[]) then
      raise exception 'Expired % must have neither helper nor financial workspace capabilities.', actor.kind;
    end if;
    blocked := false;
    begin perform public.get_wedding_team_workspace(wid);
    exception when others then blocked := true; end;
    if not blocked then raise exception 'Expired % must not read helper data.', actor.kind; end if;
    blocked := false;
    begin perform 1 from public.get_guest_verification('53000000-0000-4000-8000-000000000001');
    exception when others then blocked := true; end;
    if not blocked then raise exception 'Expired % must not verify QR passes.', actor.kind; end if;
    blocked := false;
    begin perform public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000001');
    exception when others then blocked := true; end;
    if not blocked then raise exception 'Expired % must not check in guests.', actor.kind; end if;
    blocked := false;
    begin perform public.set_wedding_team_member_expiry(wid, actor.id, null, true);
    exception when others then blocked := true; end;
    if not blocked then raise exception 'A helper must not extend their own grant.'; end if;
    perform set_config('request.jwt.claim.sub', owner_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'email', 'couple-one@example.test', 'role', 'authenticated')::text, true);
    perform public.set_wedding_team_member_expiry(wid, actor.id, now() + interval '2 days');
    perform set_config('request.jwt.claim.sub', actor.id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor.id, 'email', actor.email, 'role', 'authenticated')::text, true);
    perform public.get_wedding_team_workspace(wid);
  end loop;

  perform set_config('request.jwt.claim.sub', checkin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', checkin_id, 'email', 'checkin@example.test', 'role', 'authenticated')::text, true);
  select checked_in_at into first_checkin from public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000001');
  if first_checkin is null then raise exception 'Check-in should set a timestamp.'; end if;
  if (select checked_in_at from public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000001')) <> first_checkin then
    raise exception 'Repeated check-in must be idempotent.';
  end if;
  blocked := false;
  begin perform public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000003');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Declined guests must not be checked in.'; end if;
  blocked := false;
  begin perform public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000002');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'A check-in helper must not check in a guest from another wedding.'; end if;

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'email', 'couple-one@example.test', 'role', 'authenticated')::text, true);
  perform public.create_wedding_team_invite(wid, 'checkin', 'checkin@example.test', repeat('8', 64), 7);
  perform public.revoke_wedding_team_member(wid, checkin_id);

  perform set_config('request.jwt.claim.sub', checkin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', checkin_id, 'email', 'checkin@example.test', 'role', 'authenticated')::text, true);
  if public.has_active_wedding_team_role(wid, array['checkin', 'coordinator']) then
    raise exception 'Revoked check-in access must take effect immediately.';
  end if;
  blocked := false;
  begin perform public.mark_guest_rsvp_checked_in('53000000-0000-4000-8000-000000000001');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'A revoked helper must not check in a pass.'; end if;
  blocked := false;
  begin perform public.redeem_wedding_team_invite(repeat('8', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Revoking a helper must also invalidate pending invitations to that account.'; end if;

  perform set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000016', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '51000000-0000-4000-8000-000000000016', 'email', 'expired@example.test', 'role', 'authenticated')::text, true);
  if public.has_active_wedding_team_role(wid, array['usher']) then
    raise exception 'Expired team memberships must not retain capabilities.';
  end if;
  blocked := false;
  begin perform public.get_wedding_team_workspace(wid);
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Expired helper must not read the team workspace.'; end if;
  blocked := false;
  begin perform 1 from public.get_wedding_team_invite(repeat('9', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Expired invitation details must not be disclosed.'; end if;
  blocked := false;
  begin perform 1 from public.redeem_wedding_team_invite(repeat('9', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Expired invitations must not be accepted.'; end if;

  for actor in select * from team_actors where kind in ('usher', 'dj', 'support') loop
    perform set_config('request.jwt.claim.sub', owner_id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'email', 'couple-one@example.test', 'role', 'authenticated')::text, true);
    perform public.revoke_wedding_team_member(wid, actor.id);
    blocked := false;
    begin perform public.set_wedding_team_member_expiry(wid, actor.id, null, true);
    exception when others then blocked := true; end;
    if not blocked then raise exception 'An expiry edit must not restore revoked % access.', actor.kind; end if;
    perform set_config('request.jwt.claim.sub', actor.id::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', actor.id, 'email', actor.email, 'role', 'authenticated')::text, true);
    blocked := false;
    begin perform public.get_wedding_team_workspace(wid);
    exception when others then blocked := true; end;
    if not blocked then raise exception 'Revoked % must not read helper data.', actor.kind; end if;
  end loop;
end $$;

reset role;
update public.weddings
  set client_owner_id = '51000000-0000-4000-8000-000000000003'
  where id = '52000000-0000-4000-8000-000000000002';

set local role authenticated;
do $$
declare blocked boolean := false;
begin
  perform set_config('request.jwt.claim.sub', '51000000-0000-4000-8000-000000000016', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '51000000-0000-4000-8000-000000000016', 'email', 'expired@example.test', 'role', 'authenticated')::text, true);
  begin perform 1 from public.redeem_wedding_team_invite(repeat('6', 64));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'An invite must be invalid after its inviter no longer owns the wedding.'; end if;
end $$;

rollback;
