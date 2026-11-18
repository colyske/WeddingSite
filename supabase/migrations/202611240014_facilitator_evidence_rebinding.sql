-- Private synthetic-only evidence revisions. These are not payout authorization.
create table public.facilitator_reservation_reconfirmations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null references public.facilitator_reservation_requests(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  expected_binding uuid,
  request_key uuid not null,
  actor_id uuid not null references public.profiles(id),
  confirmed_at timestamptz not null default clock_timestamp(),
  unique(actor_id,request_key)
);

create table public.facilitator_reservation_rebindings (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence bigint generated always as identity unique,
  request_id uuid not null references public.facilitator_reservation_requests(id),
  previous_binding uuid references public.facilitator_reservation_rebindings(id),
  action_key uuid not null unique,
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  inventory_id uuid not null references public.facilitator_funding_attestations(id),
  reconfirmation_id uuid references public.facilitator_reservation_reconfirmations(id),
  allocations jsonb not null,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default clock_timestamp()
);
alter table public.facilitator_reservation_reconfirmations add constraint facilitator_reconfirmation_binding_fk
  foreign key(expected_binding) references public.facilitator_reservation_rebindings(id);
create index facilitator_rebinding_request on public.facilitator_reservation_rebindings(request_id,sequence desc);

do $$ declare t text; begin
  foreach t in array array['facilitator_reservation_reconfirmations','facilitator_reservation_rebindings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger immutable before update or delete on public.%I
      for each row execute function public.referral_immutable()',t);
  end loop;
end $$;

create function public.facilitator_reservation_reconfirm_internal(
  p_request uuid,p_recipient uuid,p_expected uuid,p_key uuid,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_reservation_requests; prior public.facilitator_reservation_reconfirmations;
  latest uuid; result uuid;
begin
  if not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_RESERVATION_DISABLED: Reservation core is not enabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_recipient is null or p_key is null
    or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Explicit recipient confirmation is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into r from public.facilitator_reservation_requests where id=p_request and user_id=auth.uid();
  if not found then raise exception 'FACILITATOR_RESERVATION_AUTH: Only the beneficiary can confirm.'; end if;
  select * into prior from public.facilitator_reservation_reconfirmations
    where actor_id=auth.uid() and request_key=p_key;
  if found then
    if (prior.request_id,prior.recipient_revision,prior.expected_binding)
      is distinct from (p_request,p_recipient,p_expected) then
      raise exception 'FACILITATOR_RESERVATION_CONFLICT: Confirmation retry changed.';
    end if;
    return prior.id;
  end if;
  select id into latest from public.facilitator_reservation_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if latest is distinct from p_expected then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: The binding changed; reconfirm the current request.';
  end if;
  if not public.facilitator_payout_recipient_ready(r.user_id,p_recipient) then
    raise exception 'FACILITATOR_RESERVATION_HOLD: Current verified recipient required.';
  end if;
  insert into public.facilitator_reservation_reconfirmations(request_id,recipient_revision,expected_binding,request_key,actor_id)
    values(p_request,p_recipient,p_expected,p_key,auth.uid()) returning id into result;
  return result;
end $$;

create function public.facilitator_reservation_rebind_internal(
  p_request uuid,p_expected uuid,p_key uuid,p_recipient uuid,p_inventory uuid,
  p_allocations jsonb,p_reconfirmation uuid,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_reservation_requests; prior public.facilitator_reservation_rebindings;
  latest public.facilitator_reservation_rebindings; current_recipient uuid; result uuid;
begin
  if not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_RESERVATION_DISABLED: Reservation core is not enabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_key is null or p_recipient is null
    or p_inventory is null or p_allocations is null or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Confirm the evidence review.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('superadmin');
  select * into r from public.facilitator_reservation_requests where id=p_request;
  if not found then raise exception 'FACILITATOR_RESERVATION_CONFLICT: Reservation not found.'; end if;
  select * into prior from public.facilitator_reservation_rebindings where action_key=p_key;
  if found then
    if (prior.request_id,prior.previous_binding,prior.recipient_revision,prior.inventory_id,
        prior.allocations,prior.reconfirmation_id,prior.reviewed_by)
      is distinct from (p_request,p_expected,p_recipient,p_inventory,p_allocations,p_reconfirmation,auth.uid()) then
      raise exception 'FACILITATOR_RESERVATION_CONFLICT: Evidence review retry changed.';
    end if;
    return prior.id;
  end if;
  if exists(select 1 from public.facilitator_shadow_claims where request_id=p_request) then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: Claimed destination cannot be rebound.';
  end if;
  select * into latest from public.facilitator_reservation_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if latest.id is distinct from p_expected then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: Evidence binding changed; reload.';
  end if;
  current_recipient:=coalesce(latest.recipient_revision,r.recipient_revision);
  if p_recipient is distinct from current_recipient then
    if not exists(select 1 from public.facilitator_reservation_reconfirmations c
      where c.id=p_reconfirmation and c.request_id=p_request and c.actor_id=r.user_id
        and c.recipient_revision=p_recipient and c.expected_binding is not distinct from p_expected) then
      raise exception 'FACILITATOR_RESERVATION_HOLD: Beneficiary must reconfirm the changed recipient.';
    end if;
  elsif p_reconfirmation is not null then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Unexpected recipient reconfirmation.';
  end if;
  perform public.facilitator_reservation_evaluate_internal(r.request_key,r.user_id,p_recipient,p_inventory,
    r.currency,r.amount_minor,p_allocations,true);
  insert into public.facilitator_reservation_rebindings(request_id,previous_binding,action_key,recipient_revision,
    inventory_id,reconfirmation_id,allocations,reviewed_by)
    values(p_request,p_expected,p_key,p_recipient,p_inventory,p_reconfirmation,p_allocations,auth.uid())
    returning id into result;
  return result;
end $$;

-- A current binding check is not a claim and does not authorize a transfer.
create function public.facilitator_reservation_binding_evaluate_internal(p_request uuid,p_binding uuid)
returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_reservation_requests; binding public.facilitator_reservation_rebindings;
begin
  if not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_RESERVATION_DISABLED: Reservation core is not enabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_binding is null then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Current reviewed binding required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select * into r from public.facilitator_reservation_requests where id=p_request;
  if not found then raise exception 'FACILITATOR_RESERVATION_CONFLICT: Reservation not found.'; end if;
  select * into binding from public.facilitator_reservation_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if binding.id is distinct from p_binding then
    raise exception 'FACILITATOR_RESERVATION_CONFLICT: Current reviewed binding required.';
  end if;
  perform public.facilitator_reservation_evaluate_internal(r.request_key,r.user_id,binding.recipient_revision,
    binding.inventory_id,r.currency,r.amount_minor,binding.allocations,true);
  return binding.id;
end $$;

revoke all on function public.facilitator_reservation_reconfirm_internal(uuid,uuid,uuid,uuid,boolean),
  public.facilitator_reservation_rebind_internal(uuid,uuid,uuid,uuid,uuid,jsonb,uuid,boolean),
  public.facilitator_reservation_binding_evaluate_internal(uuid,uuid)
  from public,anon,authenticated,service_role;
