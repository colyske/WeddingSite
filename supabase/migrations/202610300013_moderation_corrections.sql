-- Staff restrictions (unpublish/archive) carry a client-visible reason and required action.
-- The Client submits a correction; a regular Admin (or above) republishes, lifts the restriction,
-- or returns the case with a reason. History is append-only and never shown on public pages.

create table if not exists public.moderation_cases (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  action text not null check (action in ('unpublish', 'archive')),
  reason_code text not null check (reason_code in
    ('content_policy', 'inaccurate_details', 'payment_issue', 'legal_request', 'safety', 'other')),
  reason text not null check (length(reason) between 15 and 1000),
  required_action text not null check (length(required_action) between 10 and 1000),
  was_published boolean not null default false,
  status text not null default 'open' check (status in ('open', 'submitted', 'returned', 'resolved', 'superseded')),
  revision integer not null default 1,
  client_response text check (client_response is null or length(client_response) between 10 and 2000),
  client_responded_at timestamptz,
  staff_note text check (staff_note is null or length(staff_note) <= 1000),
  resolution text check (resolution is null or resolution in ('republished', 'lifted')),
  opened_by uuid references public.profiles(id) on delete set null,
  opened_at timestamptz not null default now(),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists moderation_cases_one_active
  on public.moderation_cases (wedding_id) where status in ('open', 'submitted', 'returned');
create index if not exists moderation_cases_queue on public.moderation_cases (status, updated_at);

create table if not exists public.moderation_case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.moderation_cases(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_kind text not null check (actor_kind in ('staff', 'client', 'system')),
  event text not null check (event in ('opened', 'superseded', 'submitted', 'returned', 'republished', 'lifted')),
  note text check (note is null or length(note) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists moderation_case_events_case on public.moderation_case_events (case_id, id);

create or replace function public.block_moderation_history_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Moderation history is append-only.';
end $$;
drop trigger if exists moderation_case_events_append_only on public.moderation_case_events;
create trigger moderation_case_events_append_only before update or delete on public.moderation_case_events
  for each row execute function public.block_moderation_history_change();
drop trigger if exists moderation_cases_no_delete on public.moderation_cases;
create trigger moderation_cases_no_delete before delete on public.moderation_cases
  for each row execute function public.block_moderation_history_change();

alter table public.moderation_cases enable row level security;
alter table public.moderation_case_events enable row level security;
revoke all on public.moderation_cases, public.moderation_case_events from public, anon, authenticated;
drop policy if exists moderation_case_read on public.moderation_cases;
create policy moderation_case_read on public.moderation_cases for select to authenticated using (
  coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false)
  or exists (select 1 from public.weddings w where w.id = moderation_cases.wedding_id and w.client_owner_id = auth.uid()));
grant select on public.moderation_cases to authenticated;

-- Lifecycle columns change only through the audited RPCs below; this closes a direct
-- PostgREST update path that could un-archive a staff-restricted wedding or reset first_published_at.
revoke update (archived_at, unpublished_at, first_published_at) on public.weddings from authenticated;

create or replace function public.moderation_staff_guard(w public.weddings) returns public.platform_role
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare r public.platform_role := public.require_staff();
begin
  if w.client_owner_id = auth.uid() then
    raise exception 'MODERATION: Another staff member must moderate a wedding you own.';
  end if;
  return r;
end $$;
revoke all on function public.moderation_staff_guard(public.weddings) from public, anon, authenticated;

drop function if exists public.admin_wedding_action(uuid, text);
create function public.admin_wedding_action(
  p_wedding_id uuid, p_action text, p_reason_code text default null,
  p_reason text default null, p_required_action text default null
) returns boolean
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  w public.weddings;
  c public.moderation_cases;
  v_case uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_required text := nullif(btrim(coalesce(p_required_action, '')), '');
  v_was_published boolean;
begin
  perform public.require_staff();
  if p_action is null or p_action not in ('archive', 'restore', 'unpublish', 'waive_fee') then raise exception 'Unknown action.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  select * into c from public.moderation_cases
    where wedding_id = p_wedding_id and status in ('open', 'submitted', 'returned') for update;

  if p_action in ('archive', 'unpublish') then
    perform public.moderation_staff_guard(w);
    if p_reason_code is null or p_reason_code not in
        ('content_policy', 'inaccurate_details', 'payment_issue', 'legal_request', 'safety', 'other') then
      raise exception 'MODERATION: Choose a reason category.';
    end if;
    if v_reason is null or length(v_reason) not between 15 and 1000 then
      raise exception 'MODERATION: Explain the reason for the Client in 15 to 1000 characters.';
    end if;
    if v_required is null or length(v_required) not between 10 and 1000 then
      raise exception 'MODERATION: Describe what the Client must correct in 10 to 1000 characters.';
    end if;
    -- A retried identical request is a no-op.
    if c.id is not null and c.action = p_action and c.reason_code = p_reason_code
        and c.reason = v_reason and c.required_action = v_required then
      return true;
    end if;
    if p_action = 'unpublish' and c.id is null and w.published_at is null then
      raise exception 'MODERATION: This wedding is not published. Archive it instead if it must be restricted.';
    end if;
    v_was_published := coalesce(c.was_published, w.published_at is not null);
    if c.id is not null then
      update public.moderation_cases set status = 'superseded', revision = revision + 1,
        resolved_by = auth.uid(), resolved_at = now(), updated_at = now() where id = c.id;
      insert into public.moderation_case_events (case_id, wedding_id, actor_id, actor_kind, event, note)
        values (c.id, p_wedding_id, auth.uid(), 'staff', 'superseded', 'Replaced by an updated staff restriction.');
    end if;
    insert into public.moderation_cases (wedding_id, action, reason_code, reason, required_action, was_published, opened_by)
      values (p_wedding_id, p_action, p_reason_code, v_reason, v_required, v_was_published, auth.uid())
      returning id into v_case;
    insert into public.moderation_case_events (case_id, wedding_id, actor_id, actor_kind, event, note)
      values (v_case, p_wedding_id, auth.uid(), 'staff', 'opened', v_reason);
    if p_action = 'archive' then
      update public.weddings set archived_at = coalesce(archived_at, now()), published_at = null,
        unpublished_at = case when published_at is not null then now() else unpublished_at end,
        lifecycle_admin_restricted = true where id = p_wedding_id;
    else
      update public.weddings set published_at = null,
        archived_at = case when c.action = 'archive' then null else archived_at end,
        unpublished_at = case when published_at is not null then now() else unpublished_at end,
        lifecycle_admin_restricted = true where id = p_wedding_id;
    end if;
  elsif p_action = 'restore' then
    if c.id is not null or w.lifecycle_admin_restricted then
      raise exception 'MODERATION: Review the open moderation case to lift a staff restriction.';
    end if;
    update public.weddings set archived_at = null where id = p_wedding_id;
  else
    insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider)
      values (w.id, 1, w.currency, 'waived', now(), 'staff-waiver')
      on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
  end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (p_wedding_id, auth.uid(), 'user', 'admin_' || p_action, 'weddings', p_wedding_id::text,
      case when p_action in ('archive', 'unpublish') then array['moderation_case'] else '{}'::text[] end);
  return true;
end $$;
revoke all on function public.admin_wedding_action(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_wedding_action(uuid, text, text, text, text) to authenticated;

create or replace function public.submit_moderation_correction(
  p_case_id uuid, p_note text, p_expected_revision integer
) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  c public.moderation_cases;
  w public.weddings;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_wedding uuid;
begin
  if auth.uid() is null then raise exception 'Sign in to respond.'; end if;
  select wedding_id into v_wedding from public.moderation_cases where id = p_case_id;
  if v_wedding is null then raise exception 'MODERATION: Case not found.'; end if;
  select * into w from public.weddings where id = v_wedding for update;
  if w.client_owner_id is distinct from auth.uid() then raise exception 'MODERATION: Case not found.'; end if;
  select * into c from public.moderation_cases where id = p_case_id for update;
  if c.status = 'submitted' and c.client_response = v_note then
    return jsonb_build_object('status', c.status, 'revision', c.revision);
  end if;
  if c.status not in ('open', 'returned') then
    raise exception 'MODERATION: This case is no longer awaiting your correction. Reload to see the latest status.';
  end if;
  if p_expected_revision is distinct from c.revision then
    raise exception 'MODERATION: This case changed since you opened it. Reload to see the latest staff note.';
  end if;
  if v_note is null or length(v_note) not between 10 and 2000 then
    raise exception 'MODERATION: Describe what you corrected in 10 to 2000 characters.';
  end if;
  update public.moderation_cases set status = 'submitted', revision = revision + 1, client_response = v_note,
    client_responded_at = now(), updated_at = now() where id = c.id returning * into c;
  insert into public.moderation_case_events (case_id, wedding_id, actor_id, actor_kind, event, note)
    values (c.id, c.wedding_id, auth.uid(), 'client', 'submitted', v_note);
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (c.wedding_id, auth.uid(), 'user', 'moderation_correction_submitted', 'moderation_cases', c.id::text, array['status']);
  return jsonb_build_object('status', c.status, 'revision', c.revision);
end $$;
revoke all on function public.submit_moderation_correction(uuid, text, integer) from public, anon;
grant execute on function public.submit_moderation_correction(uuid, text, integer) to authenticated;

create or replace function public.admin_review_moderation_case(
  p_case_id uuid, p_decision text, p_note text, p_expected_revision integer
) returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  c public.moderation_cases;
  w public.weddings;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_republish boolean;
  v_wedding uuid;
begin
  perform public.require_staff();
  if p_decision is null or p_decision not in ('republish', 'lift', 'return') then raise exception 'MODERATION: Choose a valid decision.'; end if;
  select wedding_id into v_wedding from public.moderation_cases where id = p_case_id;
  if v_wedding is null then raise exception 'MODERATION: Case not found.'; end if;
  select * into w from public.weddings where id = v_wedding for update;
  perform public.moderation_staff_guard(w);
  select * into c from public.moderation_cases where id = p_case_id for update;
  -- Retried identical decisions are no-ops.
  if (p_decision = 'return' and c.status = 'returned' and c.staff_note = v_note)
      or (p_decision in ('republish', 'lift') and c.status = 'resolved'
        and c.resolution = case p_decision when 'republish' then 'republished' else 'lifted' end
        and c.resolved_by = auth.uid() and p_expected_revision = c.revision - 1) then
    return jsonb_build_object('status', c.status, 'revision', c.revision);
  end if;
  if c.status not in ('open', 'submitted', 'returned') then
    raise exception 'MODERATION: This case is already closed.';
  end if;
  if p_expected_revision is distinct from c.revision then
    raise exception 'MODERATION: This case changed since you opened it. Reload before deciding.';
  end if;
  if p_decision = 'return' then
    if c.status <> 'submitted' then raise exception 'MODERATION: Only a submitted correction can be returned.'; end if;
    if v_note is null or length(v_note) not between 10 and 1000 then
      raise exception 'MODERATION: Tell the Client what is still required in 10 to 1000 characters.';
    end if;
    update public.moderation_cases set status = 'returned', revision = revision + 1, staff_note = v_note,
      updated_at = now() where id = c.id returning * into c;
    insert into public.moderation_case_events (case_id, wedding_id, actor_id, actor_kind, event, note)
      values (c.id, c.wedding_id, auth.uid(), 'staff', 'returned', v_note);
  else
    if v_note is not null and length(v_note) > 1000 then raise exception 'MODERATION: Keep the note under 1000 characters.'; end if;
    v_republish := p_decision = 'republish';
    if v_republish then
      if c.status <> 'submitted' then
        raise exception 'MODERATION: The Client must submit a correction before you approve and republish.';
      end if;
      -- Republishing restores a previously paid/waived publication; first-time publishing uses the fee flow.
      if not c.was_published then
        raise exception 'MODERATION: This wedding was never published. Lift the restriction so the Client can publish through the normal fee flow.';
      end if;
      if w.slug is null or w.wedding_date is null or not exists (select 1 from public.venues v
          where v.wedding_id = w.id and v.event_time is not null and v.event_date is not null) then
        raise exception 'MODERATION: The wedding is missing its address, date or an event time. Return the case or lift the restriction instead.';
      end if;
    end if;
    update public.moderation_cases set status = 'resolved', revision = revision + 1, staff_note = coalesce(v_note, staff_note),
      resolution = case when v_republish then 'republished' else 'lifted' end,
      resolved_by = auth.uid(), resolved_at = now(), updated_at = now() where id = c.id returning * into c;
    insert into public.moderation_case_events (case_id, wedding_id, actor_id, actor_kind, event, note)
      values (c.id, c.wedding_id, auth.uid(), 'staff', case when v_republish then 'republished' else 'lifted' end, v_note);
    update public.weddings set lifecycle_admin_restricted = false, archived_at = null,
      published_at = case when v_republish then now() else published_at end,
      unpublished_at = case when v_republish then null else unpublished_at end,
      first_published_at = case when v_republish then coalesce(first_published_at, now()) else first_published_at end
    where id = w.id;
  end if;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (c.wedding_id, auth.uid(), 'user', 'moderation_' || p_decision, 'moderation_cases', c.id::text, array['status']);
  return jsonb_build_object('status', c.status, 'revision', c.revision);
end $$;
revoke all on function public.admin_review_moderation_case(uuid, text, text, integer) from public, anon;
grant execute on function public.admin_review_moderation_case(uuid, text, text, integer) to authenticated;

create or replace function public.moderation_case_json(c public.moderation_cases, p_staff boolean) returns jsonb
language sql stable security definer set search_path = '' set row_security = off
as $$
  select jsonb_build_object('id', c.id, 'wedding_id', c.wedding_id, 'action', c.action,
    'reason_code', c.reason_code, 'reason', c.reason, 'required_action', c.required_action,
    'was_published', c.was_published, 'status', c.status, 'revision', c.revision,
    'client_response', c.client_response, 'client_responded_at', c.client_responded_at,
    'staff_note', c.staff_note, 'resolution', c.resolution, 'opened_at', c.opened_at,
    'resolved_at', c.resolved_at, 'updated_at', c.updated_at,
    'history', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'actor', e.actor_kind,
        'note', e.note, 'at', e.created_at) || case when p_staff then jsonb_build_object('actor_id', e.actor_id)
        else '{}'::jsonb end order by e.id)
      from public.moderation_case_events e where e.case_id = c.id), '[]'::jsonb))
$$;
revoke all on function public.moderation_case_json(public.moderation_cases, boolean) from public, anon, authenticated;

-- Client view: the active case (or the latest closed one) for a wedding they own.
create or replace function public.wedding_moderation_status(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare c public.moderation_cases;
begin
  if auth.uid() is null or not exists (select 1 from public.weddings w
      where w.id = p_wedding_id and w.client_owner_id = auth.uid()) then
    raise exception 'MODERATION: Wedding not found.';
  end if;
  select * into c from public.moderation_cases where wedding_id = p_wedding_id and status <> 'superseded'
    order by (status in ('open', 'submitted', 'returned')) desc, opened_at desc limit 1;
  if c.id is null then return null; end if;
  return public.moderation_case_json(c, false);
end $$;
revoke all on function public.wedding_moderation_status(uuid) from public, anon;
grant execute on function public.wedding_moderation_status(uuid) to authenticated;

-- Staff queue: submitted corrections first, then cases awaiting the Client, then recent closures.
create or replace function public.admin_moderation_cases(p_include_closed boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return coalesce((select jsonb_agg(x.item order by x.rank, x.updated_at desc) from (
      select public.moderation_case_json(c, true) || jsonb_build_object('couple_names', w.couple_names,
          'slug', w.slug, 'own_wedding', w.client_owner_id = auth.uid(),
          'current_details', jsonb_build_object('slug', w.slug, 'couple_names', w.couple_names,
            'welcome_story', w.welcome_story, 'wedding_date', w.wedding_date, 'public_location', w.public_location,
            'attire_notes', w.attire_notes, 'background_music_url', w.background_music_url,
            'faq', w.faq, 'travel_info', w.travel_info,
            'venues', coalesce((select jsonb_agg(jsonb_build_object('name', v.name, 'address', v.address,
              'event_date', v.event_date, 'event_time', v.event_time, 'description', v.description, 'map_link', v.map_link))
              from public.venues v where v.wedding_id=w.id), '[]'::jsonb),
            'site_content', (select jsonb_build_object('story_draft', g.story_draft, 'travel_notes', g.travel_notes)
              from public.guest_site_content g where g.wedding_id=w.id),
            'registry', coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'description', r.description, 'notes', r.notes))
              from public.registry_items r where r.wedding_id=w.id), '[]'::jsonb),
            'sponsor_tiers', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'perks', t.perks))
              from public.sponsor_tiers t where t.wedding_id=w.id), '[]'::jsonb))) as item,
        case c.status when 'submitted' then 0 when 'returned' then 1 when 'open' then 2 else 3 end as rank,
        c.updated_at
      from public.moderation_cases c join public.weddings w on w.id = c.wedding_id
      where c.status in ('open', 'submitted', 'returned') or coalesce(p_include_closed, false)
      order by case c.status when 'submitted' then 0 when 'returned' then 1 when 'open' then 2 else 3 end,
        c.updated_at desc limit 200) x), '[]'::jsonb);
end $$;
revoke all on function public.admin_moderation_cases(boolean) from public, anon;
grant execute on function public.admin_moderation_cases(boolean) to authenticated;

-- Staff restrictions are lifted only through case review; nobody publishes over an active case.
create or replace function public.publish_wedding_with_fee(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  w public.weddings;
  q jsonb;
  v_fee bigint;
  v_staff boolean := coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false);
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to publish a wedding.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if not found then raise exception 'Wedding not found.'; end if;
  if auth.uid() is null or not (v_staff or w.client_owner_id = auth.uid()) then
    raise exception 'Only the Client or platform staff can publish this wedding.';
  end if;
  if w.lifecycle_admin_restricted or exists (select 1 from public.moderation_cases m
      where m.wedding_id = p_wedding_id and m.status in ('open', 'submitted', 'returned')) then
    raise exception 'MODERATION_RESTRICTED: Platform staff restricted this wedding. Review the reason, submit your correction, and an Admin will review it.';
  end if;
  if w.archived_at is not null then raise exception 'Restore the archived wedding before publishing.'; end if;
  if w.slug is null then raise exception 'Set a public web address (slug) before publishing.'; end if;
  if w.wedding_date is null then raise exception 'Set the wedding date before publishing.'; end if;
  if not exists (select 1 from public.venues v where v.wedding_id = p_wedding_id
      and v.event_time is not null and v.event_date is not null) then
    raise exception 'Add at least one wedding event with a date and time before publishing.';
  end if;
  q := public.publication_quote_internal(p_wedding_id);
  v_fee := (q->>'fee_minor')::bigint;
  if v_fee > 0 then
    if v_staff then
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, paid_at, provider, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'waived', now(), 'staff-waiver', q->>'code')
      on conflict (wedding_id) do update set status = 'waived', paid_at = now(), provider = 'staff-waiver';
    else
      insert into public.publication_fees (wedding_id, amount_minor, currency, status, reason_code)
      values (p_wedding_id, v_fee, w.currency, 'pending', q->>'code')
      on conflict (wedding_id) do update set amount_minor = excluded.amount_minor, reason_code = excluded.reason_code
        where public.publication_fees.status = 'pending';
      raise exception 'PAYMENT_REQUIRED: %', q->>'reason';
    end if;
  end if;
  update public.weddings set published_at = coalesce(published_at, now()), unpublished_at = null,
    first_published_at = coalesce(first_published_at, now()) where id = p_wedding_id;
  return true;
end $$;

-- Owners unpublish/archive their own weddings here; staff restricting a Client's wedding must
-- use admin_wedding_action with a reason. A Client action never clears a staff restriction.
create or replace function public.unpublish_wedding(p_wedding_id uuid, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare w public.weddings;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to unpublish a wedding.'; end if;
  select * into w from public.weddings where id = p_wedding_id for update;
  if auth.uid() is null or not found or w.client_owner_id is distinct from auth.uid() then
    if coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false) then
      raise exception 'MODERATION: Use the Admin unpublish action and give the Client a reason.';
    end if;
    raise exception 'Only the Client or platform staff can unpublish this wedding.';
  end if;
  update public.weddings set published_at = null,
    unpublished_at = case when published_at is not null then now() else unpublished_at end where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', 'client_unpublish', 'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

create or replace function public.archive_wedding(p_wedding_id uuid, p_archived boolean)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare w public.weddings;
begin
  select * into w from public.weddings where id = p_wedding_id for update;
  if auth.uid() is null or not found or w.client_owner_id is distinct from auth.uid() then
    if coalesce(public.current_platform_role() in ('owner', 'superadmin', 'admin'), false) then
      raise exception 'MODERATION: Use the Admin archive or restore action and give the Client a reason.';
    end if;
    raise exception 'Only the Client or platform staff can archive this wedding.';
  end if;
  if not coalesce(p_archived, true) and (w.lifecycle_admin_restricted or exists (select 1 from public.moderation_cases m
      where m.wedding_id = p_wedding_id and m.status in ('open', 'submitted', 'returned'))) then
    raise exception 'MODERATION_RESTRICTED: Platform staff archived this wedding. Submit your correction and an Admin will review it.';
  end if;
  update public.weddings set
    archived_at = case when coalesce(p_archived, true) then coalesce(archived_at, now()) else null end,
    published_at = case when coalesce(p_archived, true) then null else published_at end,
    unpublished_at = case when coalesce(p_archived, true) and published_at is not null then now() else unpublished_at end
  where id = p_wedding_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p_wedding_id, auth.uid(), 'user', case when coalesce(p_archived, true) then 'archive' else 'restore' end,
    'weddings', p_wedding_id::text, '{}');
  return true;
end $$;

-- Existing staff restrictions predate recorded reasons; give each an actionable case.
with legacy as (
  insert into public.moderation_cases (wedding_id, action, reason_code, reason, required_action, was_published)
  select w.id, case when w.archived_at is not null then 'archive' else 'unpublish' end, 'other',
    'Platform staff restricted this wedding before reasons were recorded.',
    'Review your wedding details, then submit a correction note describing any changes so an Admin can review it.',
    w.first_published_at is not null
  from public.weddings w
  where w.lifecycle_admin_restricted and not exists (select 1 from public.moderation_cases m
    where m.wedding_id = w.id and m.status in ('open', 'submitted', 'returned'))
  returning id, wedding_id
)
insert into public.moderation_case_events (case_id, wedding_id, actor_kind, event, note)
select id, wedding_id, 'system', 'opened', 'Legacy restriction recorded without a reason.' from legacy;

-- Payout cancellations keep the Client's request note and record a separate client-visible staff reason.
alter table public.payout_records add column if not exists staff_reason text
  check (staff_reason is null or length(staff_reason) <= 240);

create or replace function public.admin_set_payout_status(p_payout_id uuid, p_status text, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare p public.payout_records; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.require_staff();
  if p_status is null or p_status not in ('approved', 'sent', 'cancelled') then raise exception 'Invalid payout status.'; end if;
  select * into p from public.payout_records where id = p_payout_id for update;
  if not found then raise exception 'Payout not found.'; end if;
  if p.status::text = p_status then return true; end if;
  if p.requested_by = auth.uid() and p_status in ('approved', 'sent') then
    raise exception 'Another staff member must approve a payout you requested.';
  end if;
  if not ((p.status = 'requested' and p_status in ('approved', 'cancelled'))
       or (p.status = 'approved' and p_status in ('sent', 'cancelled'))) then
    raise exception 'A % payout cannot move to %.', p.status, p_status;
  end if;
  if p_status = 'cancelled' and (v_note is null or length(v_note) not between 10 and 240) then
    raise exception 'MODERATION: Give the Client a cancellation reason in 10 to 240 characters.';
  end if;
  if p_status in ('approved', 'sent') then
    perform 1 from public.wedding_kyc where wedding_id = p.wedding_id for share;
    if not public.kyc_is_complete(p.wedding_id) then
      raise exception 'PAYOUT_KYC_REQUIRED: Complete KYC to receive your payout.';
    end if;
  end if;
  update public.payout_records set status = p_status::public.payout_status, confirmed_by = auth.uid(),
    confirmed_at = now(), staff_reason = coalesce(left(v_note, 240), staff_reason) where id = p_payout_id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
  values (p.wedding_id, auth.uid(), 'user', 'payout_' || p_status, 'payout_records', p_payout_id::text, array['status']);
  return true;
end $$;
revoke all on function public.admin_set_payout_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_payout_status(uuid, text, text) to authenticated;

-- Preserve the existing history RPC shape and PR42's leadership-only boundary.
create or replace function public.admin_payouts() returns table (
  id uuid, wedding_id uuid, couple_names text, amount_minor bigint, currency text, status text,
  requested_at timestamptz, note text, own_request boolean)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff('superadmin');
  return query select p.id, p.wedding_id, w.couple_names, p.amount_minor, p.currency::text, p.status::text,
    p.requested_at, concat_ws(E'\n', nullif(p.note, ''),
      case when p.staff_reason is not null then 'Staff: ' || p.staff_reason
        when p.status='cancelled' then 'Staff: cancellation predates recorded reasons.' end),
    (p.requested_by = auth.uid())
  from public.payout_records p join public.weddings w on w.id = p.wedding_id
  order by p.requested_at desc limit 300;
end $$;
