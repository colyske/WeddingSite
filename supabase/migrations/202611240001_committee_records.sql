create table public.committee_records (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  meeting_date date not null,
  committee text not null check (length(trim(committee)) between 1 and 120),
  notes text not null check (length(trim(notes)) between 1 and 4000),
  decision text not null default '' check (length(decision) <= 2000),
  action_owner text not null default '' check (length(action_owner) <= 120),
  due_date date,
  category text not null check (category in ('task', 'program', 'guest', 'budget')),
  task_done boolean not null default false,
  suggestion text not null default '' check (length(suggestion) <= 2000),
  review_status text not null default 'none' check (review_status in ('none', 'pending', 'approved', 'returned')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((suggestion = '' and review_status = 'none') or (suggestion <> '' and review_status <> 'none'))
);
create index committee_records_wedding_idx on public.committee_records (wedding_id, created_at desc);
alter table public.committee_records enable row level security;
revoke all on public.committee_records from public, anon, authenticated;

create function public.committee_access(p_wedding_id uuid, p_owner_only boolean default false)
returns boolean language sql stable security definer set search_path = '' set row_security = off
as $$
  select auth.uid() is not null and (
    exists (select 1 from public.weddings w where w.id = p_wedding_id and w.client_owner_id = auth.uid())
    or (not p_owner_only and public.has_active_wedding_team_role(p_wedding_id, array['coordinator']))
  );
$$;

create function public.get_committee_records(p_wedding_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if not public.committee_access(p_wedding_id) then
    raise exception 'Wedding team access denied.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc)
    from public.committee_records r where r.wedding_id = p_wedding_id), '[]'::jsonb);
end;
$$;

create function public.create_committee_record(
  p_wedding_id uuid, p_meeting_date date, p_committee text, p_notes text,
  p_decision text, p_action_owner text, p_due_date date, p_category text, p_suggestion text
) returns uuid language plpgsql security definer set search_path = '' set row_security = off
as $$
declare v_id uuid;
begin
  if not public.committee_access(p_wedding_id) then
    raise exception 'Wedding team access denied.' using errcode = '42501';
  end if;
  insert into public.committee_records
    (wedding_id, created_by, meeting_date, committee, notes, decision, action_owner, due_date, category, suggestion, review_status)
  values
    (p_wedding_id, auth.uid(), p_meeting_date, trim(p_committee), trim(p_notes), trim(coalesce(p_decision, '')),
     trim(coalesce(p_action_owner, '')), p_due_date, p_category, trim(coalesce(p_suggestion, '')),
     case when trim(coalesce(p_suggestion, '')) = '' then 'none' else 'pending' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.set_committee_task(p_wedding_id uuid, p_record_id uuid, p_done boolean)
returns void language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if not public.committee_access(p_wedding_id) then
    raise exception 'Wedding team access denied.' using errcode = '42501';
  end if;
  if p_done is null then raise exception 'Task status is required.' using errcode = '22023'; end if;
  update public.committee_records set task_done = p_done
    where wedding_id = p_wedding_id and id = p_record_id and (action_owner <> '' or due_date is not null);
  if not found then raise exception 'Committee task not found.' using errcode = '22023'; end if;
end;
$$;

create function public.review_committee_suggestion(p_wedding_id uuid, p_record_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  if not public.committee_access(p_wedding_id, true) then
    raise exception 'Only the couple can review committee suggestions.' using errcode = '42501';
  end if;
  if p_status not in ('approved', 'returned') or p_status is null then
    raise exception 'Invalid review status.' using errcode = '22023';
  end if;
  update public.committee_records set review_status = p_status, reviewed_by = auth.uid(), reviewed_at = now()
    where wedding_id = p_wedding_id and id = p_record_id and review_status = 'pending';
  if not found then raise exception 'Pending suggestion not found.' using errcode = '22023'; end if;
end;
$$;

revoke all on function public.committee_access(uuid, boolean) from public, anon, authenticated;
revoke all on function public.get_committee_records(uuid) from public, anon;
revoke all on function public.create_committee_record(uuid, date, text, text, text, text, date, text, text) from public, anon;
revoke all on function public.set_committee_task(uuid, uuid, boolean) from public, anon;
revoke all on function public.review_committee_suggestion(uuid, uuid, text) from public, anon;
grant execute on function public.get_committee_records(uuid) to authenticated;
grant execute on function public.create_committee_record(uuid, date, text, text, text, text, date, text, text) to authenticated;
grant execute on function public.set_committee_task(uuid, uuid, boolean) to authenticated;
grant execute on function public.review_committee_suggestion(uuid, uuid, text) to authenticated;
