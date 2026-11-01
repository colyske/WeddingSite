create table if not exists public.wedding_team_members (
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete restrict,
  role text not null check (role in ('checkin', 'usher', 'coordinator', 'rsvp_support', 'dj')),
  granted_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (wedding_id, user_id, role)
);

create index if not exists wedding_team_members_active_idx
  on public.wedding_team_members (wedding_id, role, expires_at)
  where revoked_at is null;

create table if not exists public.wedding_team_invites (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  role text not null check (role in ('checkin', 'usher', 'coordinator', 'rsvp_support', 'dj')),
  invitee_email text not null check (length(invitee_email) between 5 and 254),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null,
  grant_expires_at timestamptz,
  revoked_at timestamptz,
  consumed_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists wedding_team_invites_pending_idx
  on public.wedding_team_invites (wedding_id, expires_at)
  where revoked_at is null and consumed_at is null;

create table if not exists public.wedding_team_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('invite_created', 'invite_revoked', 'member_granted', 'member_revoked', 'member_expiry_updated')),
  role text not null check (role in ('checkin', 'usher', 'coordinator', 'rsvp_support', 'dj')),
  invite_id uuid references public.wedding_team_invites(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.wedding_team_members enable row level security;
alter table public.wedding_team_invites enable row level security;
alter table public.wedding_team_audit enable row level security;
revoke all on public.wedding_team_members, public.wedding_team_invites, public.wedding_team_audit
  from public, anon, authenticated;

create or replace function public.has_active_wedding_team_role(
  p_wedding_id uuid,
  p_roles text[]
) returns boolean
language sql stable security definer
set search_path = '' set row_security = off
as $$
  select auth.uid() is not null and exists (
    select 1 from public.wedding_team_members m
    where m.wedding_id = p_wedding_id
      and m.user_id = auth.uid()
      and m.role = any(coalesce(p_roles, '{}'::text[]))
      and m.revoked_at is null
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

create or replace function public.wedding_team_grant_expiry(
  p_wedding_id uuid,
  p_grant_expires_at timestamptz,
  p_no_expiry boolean
) returns timestamptz
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_date date;
  v_zone text;
begin
  select w.wedding_date, coalesce(w.time_zone, 'UTC') into v_date, v_zone
    from public.weddings w
    where w.id = p_wedding_id and w.client_owner_id = auth.uid();
  if not found then raise exception 'Only the couple can manage this wedding team.'; end if;
  if p_no_expiry is null or (p_no_expiry and p_grant_expires_at is not null) then
    raise exception 'Choose one valid helper access expiry option.';
  end if;
  if p_no_expiry then return null; end if;
  if p_grant_expires_at is not null then
    if not isfinite(p_grant_expires_at) then raise exception 'Choose a valid helper access expiry date.'; end if;
    return p_grant_expires_at;
  end if;
  if v_date is null then return now() + interval '30 days'; end if;
  return (v_date + 2)::timestamp at time zone v_zone;
end;
$$;

create or replace function public.create_wedding_team_invite(
  p_wedding_id uuid,
  p_role text,
  p_invitee_email text,
  p_token_hash text,
  p_expires_days integer default 7,
  p_grant_expires_at timestamptz default null,
  p_no_expiry boolean default false
) returns uuid
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_id uuid;
  v_email text := lower(trim(coalesce(p_invitee_email, '')));
  v_grant_expiry timestamptz;
begin
  if auth.uid() is null or not exists (
    select 1 from public.weddings w
    where w.id = p_wedding_id and w.client_owner_id = auth.uid()
  ) then
    raise exception 'Only the couple can manage this wedding team.';
  end if;
  if p_role not in ('checkin', 'usher', 'coordinator', 'rsvp_support', 'dj')
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or length(v_email) > 254
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_days not between 1 and 30 then
    raise exception 'Enter a valid helper role and email address.';
  end if;
  v_grant_expiry := public.wedding_team_grant_expiry(p_wedding_id, p_grant_expires_at, p_no_expiry);
  if v_grant_expiry <= now() then raise exception 'Helper access expiry must be in the future.'; end if;

  with revoked as (
    update public.wedding_team_invites
      set revoked_at = now()
      where wedding_id = p_wedding_id and invitee_email = v_email and role = p_role
        and revoked_at is null and consumed_at is null
      returning id, role
  )
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, invite_id)
    select p_wedding_id, auth.uid(), 'invite_revoked', role, id from revoked;

  insert into public.wedding_team_invites
    (wedding_id, role, invitee_email, token_hash, created_by, expires_at, grant_expires_at)
  values
    (p_wedding_id, p_role, v_email, p_token_hash, auth.uid(), now() + make_interval(days => p_expires_days), v_grant_expiry)
  returning id into v_id;
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, invite_id, expires_at)
  values (p_wedding_id, auth.uid(), 'invite_created', p_role, v_id, v_grant_expiry);
  return v_id;
end;
$$;

create or replace function public.get_wedding_team(p_wedding_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.weddings w
    where w.id = p_wedding_id and w.client_owner_id = auth.uid()
  ) then
    raise exception 'Only the couple can manage this wedding team.';
  end if;
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', active.user_id, 'roles', to_jsonb(active.roles),
        'display_name', active.display_name, 'created_at', active.created_at, 'grants', active.grants
      ) order by active.display_name)
      from (
        select m.user_id, p.display_name, array_agg(m.role order by m.role) as roles,
          min(m.created_at) as created_at,
          jsonb_agg(jsonb_build_object('role', m.role, 'expires_at', m.expires_at) order by m.role) as grants
        from public.wedding_team_members m
        join public.profiles p on p.id = m.user_id
        where m.wedding_id = p_wedding_id and m.revoked_at is null
        group by m.user_id, p.display_name
      ) active
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'role', i.role, 'invitee_email', i.invitee_email,
        'expires_at', i.expires_at, 'grant_expires_at', i.grant_expires_at
      ) order by i.created_at desc)
      from public.wedding_team_invites i
      where i.wedding_id = p_wedding_id and i.revoked_at is null
        and i.consumed_at is null and i.expires_at > now()
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.set_wedding_team_member_expiry(
  p_wedding_id uuid,
  p_user_id uuid,
  p_grant_expires_at timestamptz default null,
  p_no_expiry boolean default false
) returns boolean
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_expiry timestamptz;
  v_count integer;
begin
  v_expiry := public.wedding_team_grant_expiry(p_wedding_id, p_grant_expires_at, p_no_expiry);
  with updated as (
    update public.wedding_team_members m
      set expires_at = v_expiry
      where m.wedding_id = p_wedding_id and m.user_id = p_user_id and m.revoked_at is null
      returning m.role
  )
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, target_user_id, expires_at)
    select p_wedding_id, auth.uid(), 'member_expiry_updated', role, p_user_id, v_expiry from updated;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'Active team member not found.'; end if;
  return true;
end;
$$;

create or replace function public.revoke_wedding_team_invite(p_wedding_id uuid, p_invite_id uuid)
returns boolean
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_role text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.weddings w
    where w.id = p_wedding_id and w.client_owner_id = auth.uid()
  ) then
    raise exception 'Only the couple can manage this wedding team.';
  end if;
  update public.wedding_team_invites
    set revoked_at = now()
    where id = p_invite_id and wedding_id = p_wedding_id
      and revoked_at is null and consumed_at is null
    returning role into v_role;
  if v_role is null then raise exception 'Pending invitation not found.'; end if;
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, invite_id)
  values (p_wedding_id, auth.uid(), 'invite_revoked', v_role, p_invite_id);
  return true;
end;
$$;

create or replace function public.revoke_wedding_team_member(p_wedding_id uuid, p_user_id uuid)
returns boolean
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  v_email text;
  v_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.weddings w
    where w.id = p_wedding_id and w.client_owner_id = auth.uid()
  ) then
    raise exception 'Only the couple can manage this wedding team.';
  end if;
  with revoked as (
    update public.wedding_team_members
      set revoked_at = now()
      where wedding_id = p_wedding_id and user_id = p_user_id and revoked_at is null
      returning role
  )
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, target_user_id)
    select p_wedding_id, auth.uid(), 'member_revoked', role, p_user_id from revoked;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'Active team member not found.'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  with revoked as (
    update public.wedding_team_invites
      set revoked_at = now()
      where wedding_id = p_wedding_id and invitee_email = v_email
        and revoked_at is null and consumed_at is null
      returning id, role
  )
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, invite_id)
    select p_wedding_id, auth.uid(), 'invite_revoked', role, id from revoked;
  return true;
end;
$$;

create or replace function public.get_wedding_team_invite(p_token_hash text)
returns table (wedding_id uuid, couple_names text, role text, invitee_email text, expires_at timestamptz, grant_expires_at timestamptz)
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_email text;
begin
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  return query
  select w.id, w.couple_names, i.role, i.invitee_email, i.expires_at, i.grant_expires_at
  from public.wedding_team_invites i
  join public.weddings w on w.id = i.wedding_id
  where i.token_hash = p_token_hash
    and auth.uid() is not null
    and v_email = i.invitee_email
    and i.revoked_at is null and i.consumed_at is null and i.expires_at > now()
    and (i.grant_expires_at is null or i.grant_expires_at > now())
    and w.client_owner_id = i.created_by;
  if not found then raise exception 'This invitation is unavailable or does not match your signed-in email.'; end if;
end;
$$;

create or replace function public.redeem_wedding_team_invite(p_token_hash text)
returns table (wedding_id uuid, couple_names text, role text)
language plpgsql security definer
set search_path = '' set row_security = off
as $$
declare
  i public.wedding_team_invites;
  v_couple_names text;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  select * into i
    from public.wedding_team_invites
    where token_hash = p_token_hash
    for update;
  if not found or i.revoked_at is not null or i.consumed_at is not null
     or i.expires_at <= now()
     or i.grant_expires_at <= now()
     or v_email is null or v_email <> i.invitee_email then
    raise exception 'This invitation is unavailable or does not match your signed-in email.';
  end if;
  select w.couple_names into v_couple_names
    from public.weddings w
    where w.id = i.wedding_id and w.client_owner_id = i.created_by
    for share;
  if v_couple_names is null then raise exception 'The inviter no longer owns this wedding.'; end if;

  insert into public.wedding_team_members
    (wedding_id, user_id, role, granted_by, expires_at, revoked_at, created_at)
  values (i.wedding_id, auth.uid(), i.role, i.created_by, i.grant_expires_at, null, now())
  on conflict on constraint wedding_team_members_pkey do update
    set role = excluded.role, granted_by = excluded.granted_by, expires_at = excluded.expires_at,
        revoked_at = null, created_at = now();
  update public.wedding_team_invites
    set consumed_at = now(), accepted_by = auth.uid()
    where id = i.id;
  insert into public.wedding_team_audit (wedding_id, actor_id, action, role, invite_id, target_user_id, expires_at)
  values (i.wedding_id, auth.uid(), 'member_granted', i.role, i.id, auth.uid(), i.grant_expires_at);
  return query select i.wedding_id, v_couple_names, i.role;
end;
$$;

create or replace function public.get_wedding_team_workspace(p_wedding_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = '' set row_security = off
as $$
declare
  v_roles text[];
  v_can_checkin boolean;
  v_can_roster boolean;
  v_can_support boolean;
  v_can_dj boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;
  select coalesce(array_agg(m.role), '{}'::text[]) into v_roles
    from public.wedding_team_members m
    where m.wedding_id = p_wedding_id and m.user_id = auth.uid()
      and m.revoked_at is null and (m.expires_at is null or m.expires_at > now());
  if cardinality(v_roles) = 0 then raise exception 'Wedding team access denied.'; end if;

  v_can_checkin := v_roles && array['checkin', 'coordinator'];
  v_can_roster := v_roles && array['usher', 'coordinator'];
  v_can_support := v_roles @> array['rsvp_support'];
  v_can_dj := v_roles @> array['dj'];
  return jsonb_build_object(
    'roles', to_jsonb(v_roles),
    'can_check_in', v_can_checkin,
    'guests', case when v_can_roster then coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', g.name,
        'table_number', g.table_number,
        'rsvp_status', coalesce(r.attendance_status::text, g.rsvp_status),
        'checked_in', r.checked_in_at is not null
      ) order by g.table_number nulls last, g.name)
      from public.guests g
      left join public.guest_rsvps r
        on r.wedding_id = g.wedding_id and lower(r.guest_email) = lower(g.email)
      where g.wedding_id = p_wedding_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'rsvp_support', case when v_can_support then coalesce((
      select jsonb_agg(jsonb_build_object(
        'guest_name', r.guest_name,
        'guest_email', r.guest_email,
        'phone', r.phone,
        'attendance_status', r.attendance_status::text,
        'plus_one_count', r.plus_one_count
      ) order by r.guest_name)
      from public.guest_rsvps r where r.wedding_id = p_wedding_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'playlist', case when v_can_dj then coalesce((
      select jsonb_agg(jsonb_build_object(
        'song_title', b.song_title,
        'artist_name', b.artist_name,
        'rank_position', b.rank_position
      ) order by b.rank_position nulls last, b.created_at)
      from public.dj_song_bids b
      where b.wedding_id = p_wedding_id and b.payment_status = 'paid'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

create or replace function public.mark_guest_rsvp_checked_in(p_code uuid)
returns table (
  rsvp_id uuid,
  wedding_id uuid,
  slug text,
  guest_name text,
  attendance_status text,
  checked_in_at timestamptz
)
language plpgsql
security definer
set search_path = '' set row_security = off
as $$
declare
  v_wedding_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  select r.wedding_id into v_wedding_id
  from public.guest_rsvps r where r.id = p_code;
  if v_wedding_id is null or not exists (
    select 1 from public.weddings w
    where w.id = v_wedding_id
      and (w.client_owner_id = auth.uid() or public.current_platform_role() in ('owner', 'superadmin'))
  ) and not public.has_active_wedding_team_role(v_wedding_id, array['checkin', 'coordinator']) then
    raise exception 'Wedding access denied.';
  end if;
  update public.guest_rsvps r
  set checked_in_at = coalesce(r.checked_in_at, now()), updated_at = now()
  where r.id = p_code and r.attendance_status = 'yes';
  if not found then
    raise exception 'Only an attending guest can be checked in.';
  end if;
  return query
  select r.id, r.wedding_id, w.slug, r.guest_name,
         r.attendance_status::text, r.checked_in_at
  from public.guest_rsvps r
  join public.weddings w on w.id = r.wedding_id
  where r.id = p_code;
end;
$$;

create or replace function public.get_guest_verification(p_code uuid)
returns table (
  rsvp_id uuid,
  wedding_id uuid,
  slug text,
  couple_names text,
  guest_name text,
  attendance_status text,
  checked_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = '' set row_security = off
as $$
declare
  v_wedding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;
  select r.wedding_id into v_wedding_id
    from public.guest_rsvps r where r.id = p_code;
  if v_wedding_id is null or not (
    exists (
      select 1 from public.weddings w
      where w.id = v_wedding_id
        and (w.client_owner_id = auth.uid() or public.current_platform_role() in ('owner', 'superadmin'))
    )
    or public.has_active_wedding_team_role(v_wedding_id, array['checkin', 'coordinator'])
  ) then
    raise exception 'Wedding access denied.';
  end if;
  return query
    select r.id, r.wedding_id, w.slug, w.couple_names, r.guest_name,
      r.attendance_status::text, r.checked_in_at
    from public.guest_rsvps r
    join public.weddings w on w.id = r.wedding_id
    where r.id = p_code and w.published_at is not null;
end;
$$;

revoke all on function public.has_active_wedding_team_role(uuid, text[]) from public, anon;
revoke all on function public.wedding_team_grant_expiry(uuid, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.create_wedding_team_invite(uuid, text, text, text, integer, timestamptz, boolean) from public, anon;
revoke all on function public.set_wedding_team_member_expiry(uuid, uuid, timestamptz, boolean) from public, anon;
revoke all on function public.get_wedding_team(uuid) from public, anon;
revoke all on function public.revoke_wedding_team_invite(uuid, uuid) from public, anon;
revoke all on function public.revoke_wedding_team_member(uuid, uuid) from public, anon;
revoke all on function public.get_wedding_team_invite(text) from public, anon;
revoke all on function public.redeem_wedding_team_invite(text) from public, anon;
revoke all on function public.get_wedding_team_workspace(uuid) from public, anon;
revoke all on function public.get_guest_verification(uuid) from public, anon;
grant execute on function public.has_active_wedding_team_role(uuid, text[]) to authenticated;
grant execute on function public.create_wedding_team_invite(uuid, text, text, text, integer, timestamptz, boolean) to authenticated;
grant execute on function public.set_wedding_team_member_expiry(uuid, uuid, timestamptz, boolean) to authenticated;
grant execute on function public.get_wedding_team(uuid) to authenticated;
grant execute on function public.revoke_wedding_team_invite(uuid, uuid) to authenticated;
grant execute on function public.revoke_wedding_team_member(uuid, uuid) to authenticated;
grant execute on function public.get_wedding_team_invite(text) to authenticated;
grant execute on function public.redeem_wedding_team_invite(text) to authenticated;
grant execute on function public.get_wedding_team_workspace(uuid) to authenticated;
revoke all on function public.mark_guest_rsvp_checked_in(uuid) from public, anon;
grant execute on function public.mark_guest_rsvp_checked_in(uuid) to authenticated;
grant execute on function public.get_guest_verification(uuid) to authenticated;
