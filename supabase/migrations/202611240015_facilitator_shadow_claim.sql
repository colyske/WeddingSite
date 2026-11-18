-- A synthetic-only claim model. It must not be used to send or report transfers.
create table public.facilitator_shadow_claims (
  request_id uuid primary key references public.facilitator_reservation_requests(id),
  binding_id uuid not null references public.facilitator_reservation_rebindings(id),
  claim_key uuid not null unique,
  sender_id uuid not null references public.profiles(id),
  reviewer_id uuid not null references public.profiles(id),
  owner_solo boolean not null,
  claimed_at timestamptz not null default clock_timestamp()
);
create table public.facilitator_shadow_claim_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.facilitator_shadow_claims(request_id),
  action_key uuid not null unique,
  state text not null check (state in ('claimed','uncertain')),
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['facilitator_shadow_claims','facilitator_shadow_claim_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger immutable before update or delete on public.%I
      for each row execute function public.referral_immutable()',t);
  end loop;
end $$;

create function public.facilitator_shadow_claim_enabled() returns boolean
language sql immutable set search_path='' as $$ select false $$;

create function public.facilitator_shadow_claim_internal(
  p_request uuid,p_binding uuid,p_key uuid,p_owner_solo boolean,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare existing public.facilitator_shadow_claims; binding public.facilitator_reservation_rebindings;
  actor_role public.platform_role;
begin
  if not public.facilitator_shadow_claim_enabled() or not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_SHADOW_DISABLED: Shadow claims are disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_SHADOW_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_binding is null or p_key is null
    or p_owner_solo is null or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_SHADOW_INPUT: Confirm the synthetic claim.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  actor_role:=public.require_staff('admin');
  select * into existing from public.facilitator_shadow_claims where claim_key=p_key;
  if found then
    if (existing.request_id,existing.binding_id,existing.sender_id,existing.owner_solo)
      is distinct from (p_request,p_binding,auth.uid(),p_owner_solo) then
      raise exception 'FACILITATOR_SHADOW_CONFLICT: Claim retry changed.';
    end if;
    return existing.request_id;
  end if;
  if exists(select 1 from public.facilitator_shadow_claims where request_id=p_request) then
    raise exception 'FACILITATOR_SHADOW_CONFLICT: Already claimed; never resend.';
  end if;
  select * into binding from public.facilitator_reservation_rebindings where id=p_binding and request_id=p_request;
  if not found then raise exception 'FACILITATOR_SHADOW_CONFLICT: Reviewed binding required.'; end if;
  if p_owner_solo then
    if actor_role is distinct from 'owner' then
      raise exception 'FACILITATOR_SHADOW_AUTH: Protected Owner solo review required.';
    end if;
  else
    if binding.reviewed_by=auth.uid() then
      raise exception 'FACILITATOR_SHADOW_AUTH: A different leader must review.';
    end if;
    perform 1 from public.profiles where id=binding.reviewed_by
      and platform_role in ('owner','superadmin') for share;
    if not found then raise exception 'FACILITATOR_SHADOW_AUTH: Reviewer authority changed.'; end if;
  end if;
  perform public.facilitator_reservation_binding_evaluate_internal(p_request,p_binding);
  insert into public.facilitator_shadow_claims(request_id,binding_id,claim_key,sender_id,reviewer_id,owner_solo)
    values(p_request,p_binding,p_key,auth.uid(),binding.reviewed_by,p_owner_solo);
  insert into public.facilitator_shadow_claim_events(request_id,action_key,state,actor_id)
    values(p_request,p_key,'claimed',auth.uid());
  return p_request;
end $$;

create function public.facilitator_shadow_uncertain_internal(p_request uuid,p_key uuid,p_confirmed boolean)
returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare old public.facilitator_shadow_claim_events;
begin
  if not public.facilitator_shadow_claim_enabled() or not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_SHADOW_DISABLED: Shadow claims are disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_SHADOW_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_key is null or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_SHADOW_INPUT: Confirm the synthetic hold.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  if not exists(select 1 from public.facilitator_shadow_claims where request_id=p_request) then
    raise exception 'FACILITATOR_SHADOW_CONFLICT: Claim required.';
  end if;
  select * into old from public.facilitator_shadow_claim_events where action_key=p_key;
  if found then
    if (old.request_id,old.state,old.actor_id) is distinct from (p_request,'uncertain',auth.uid()) then
      raise exception 'FACILITATOR_SHADOW_CONFLICT: Hold retry changed.';
    end if;
    return p_request;
  end if;
  insert into public.facilitator_shadow_claim_events(request_id,action_key,state,actor_id)
    values(p_request,p_key,'uncertain',auth.uid());
  return p_request;
end $$;
revoke all on function public.facilitator_shadow_claim_enabled(),
  public.facilitator_shadow_claim_internal(uuid,uuid,uuid,boolean,boolean),
  public.facilitator_shadow_uncertain_internal(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;
