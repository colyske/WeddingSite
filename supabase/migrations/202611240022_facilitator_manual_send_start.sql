-- A start is a retained liability and never, by itself, authorizes a transfer.
create table public.facilitator_manual_send_starts (
  request_id uuid primary key references public.facilitator_manual_claims(request_id),
  action_key uuid not null unique,
  sender_id uuid not null references public.profiles(id),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default clock_timestamp()
);
alter table public.facilitator_manual_send_starts enable row level security;
revoke all on public.facilitator_manual_send_starts from public,anon,authenticated,service_role;
create trigger immutable before update or delete on public.facilitator_manual_send_starts
  for each row execute function public.referral_immutable();

-- The caller holds both accounting locks and the sender's profile lock.
create function public.facilitator_manual_send_ready(p_request uuid) returns text
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare c public.facilitator_manual_claims; r public.facilitator_manual_requests;
  binding public.facilitator_manual_rebindings; claim_event public.facilitator_manual_events;
  digest text; role_name public.platform_role;
begin
  role_name:=public.require_staff('admin');
  select * into c from public.facilitator_manual_claims where request_id=p_request and sender_id=auth.uid();
  if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Claim is not accessible.'; end if;
  select * into r from public.facilitator_manual_requests where id=c.request_id;
  if public.facilitator_manual_state(p_request) is distinct from 'processing'
    or exists(select 1 from public.facilitator_manual_receipts where request_id=p_request)
    or exists(select 1 from public.facilitator_manual_incidents where request_id=p_request)
    or exists(select 1 from public.facilitator_manual_incidents i
      where not exists(select 1 from public.facilitator_manual_incident_reviews x where x.incident_id=i.id))
    or exists(select 1 from public.simple_payout_incidents where provider='daraja')
    or exists(select 1 from public.manual_payout_account_holds h
      join public.manual_payout_custody a on a.id=h.custody_id where a.provider='daraja') then
    raise exception 'FACILITATOR_MANUAL_HOLD: Payout or cross-rail incident requires review; do not resend.';
  end if;
  if c.owner_solo then
    if role_name is distinct from 'owner' then
      raise exception 'FACILITATOR_MANUAL_HOLD: Owner solo authority changed.';
    end if;
  else
    perform 1 from public.profiles where id=c.reviewer_id
      and platform_role in ('admin','superadmin','owner') for share;
    if not found then raise exception 'FACILITATOR_MANUAL_HOLD: Reviewer authority changed.'; end if;
  end if;
  perform 1 from public.profiles where id=r.user_id for update;
  select * into binding from public.facilitator_manual_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if binding.id is distinct from c.binding_id
    or coalesce(binding.recipient_revision,r.recipient_revision) is distinct from c.recipient_revision then
    raise exception 'FACILITATOR_MANUAL_HOLD: Destination binding changed.';
  end if;
  if binding.id is not null then
    perform 1 from public.profiles where id=binding.reviewed_by
      and platform_role in ('owner','superadmin') for share;
    if not found then raise exception 'FACILITATOR_MANUAL_HOLD: Destination reviewer authority changed.'; end if;
  end if;
  if not public.facilitator_manual_lock_recipient(r.user_id,c.recipient_revision) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Recipient changed or is not verified.';
  end if;
  perform public.facilitator_manual_check_sources(r.user_id,r.currency);
  digest:=public.facilitator_manual_evidence_digest(p_request);
  select * into claim_event from public.facilitator_manual_events
    where request_id=p_request and state='processing' and actor_id=c.sender_id
    order by id desc limit 1;
  if digest is null or claim_event.id is null or claim_event.evidence_digest is distinct from digest
    or claim_event.fee_minor is distinct from c.fee_minor
    or claim_event.owner_solo is distinct from c.owner_solo then
    raise exception 'FACILITATOR_MANUAL_HOLD: Claim evidence changed.';
  end if;
  if not c.owner_solo and not exists(select 1 from public.facilitator_manual_events e
    where e.request_id=p_request and e.state='reviewed' and e.actor_id=c.reviewer_id
      and e.id<claim_event.id and e.evidence_digest=digest and e.fee_minor=c.fee_minor
      and e.id>coalesce((select max(h.id) from public.facilitator_manual_events h
        where h.request_id=p_request and h.state='hold' and h.id<claim_event.id),0)) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Claim review evidence changed.';
  end if;
  return digest;
end $$;

-- This RPC returns no destination or authorization, even before an outer
-- transaction commits. Only the server may interpret a committed first start.
create function public.facilitator_manual_send_start(p_request uuid,p_key uuid,p_confirmed boolean) returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare digest text; prior public.facilitator_manual_send_starts;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_key is null or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm the send start.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  if not exists(select 1 from public.facilitator_manual_claims
    where request_id=p_request and sender_id=auth.uid()) then
    raise exception 'FACILITATOR_MANUAL_AUTH: Claim is not accessible.';
  end if;
  select * into prior from public.facilitator_manual_send_starts where request_id=p_request;
  if found then
    return jsonb_build_object('started',false,'send_authorized',false,'do_not_resend',true);
  end if;
  if exists(select 1 from public.facilitator_manual_send_starts where action_key=p_key) then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Send start key already used.';
  end if;
  digest:=public.facilitator_manual_send_ready(p_request);
  insert into public.facilitator_manual_send_starts(request_id,action_key,sender_id,evidence_digest)
    values(p_request,p_key,auth.uid(),digest);
  return jsonb_build_object('started',true,'send_authorized',false,'do_not_resend',true);
end $$;

-- A second transaction verifies the committed start and rechecks all evidence.
-- Its destination is a historical read, never itself an authorization.
create function public.facilitator_manual_send_checked(p_request uuid,p_key uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare s public.facilitator_manual_send_starts; digest text;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_key is null then
    raise exception 'FACILITATOR_MANUAL_AUTH: Send start is not accessible.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select * into s from public.facilitator_manual_send_starts
    where request_id=p_request and action_key=p_key and sender_id=auth.uid();
  if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Send start is not accessible.'; end if;
  digest:=public.facilitator_manual_send_ready(p_request);
  if digest is distinct from s.evidence_digest then
    raise exception 'FACILITATOR_MANUAL_HOLD: Send start evidence changed; do not resend.';
  end if;
  return public.facilitator_manual_claim_snapshot_internal(p_request)
    || jsonb_build_object('send_authorized',false,'do_not_resend',true);
end $$;

-- Add durable start state to the existing beneficiary and staff workspace.
do $$
declare definition text; updated text;
begin
  select pg_get_functiondef('public.facilitator_manual_status_internal(uuid)'::regprocedure) into definition;
  updated:=replace(definition,
    '''operator_reported'',reported,''external_transfer_verified'',false,''do_not_resend'',claimed',
    '''operator_reported'',reported,''external_transfer_verified'',false,''do_not_resend'',claimed,'
    || '''send_started'',exists(select 1 from public.facilitator_manual_send_starts s where s.request_id=r.id),'
    || '''send_outcome_unknown'',not reported and exists(select 1 from public.facilitator_manual_send_starts s where s.request_id=r.id)');
  if updated=definition then raise exception 'FACILITATOR_MANUAL_MIGRATION: Status definition changed.'; end if;
  execute updated;
end $$;

revoke all on function public.facilitator_manual_send_ready(uuid),
  public.facilitator_manual_send_start(uuid,uuid,boolean),
  public.facilitator_manual_send_checked(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.facilitator_manual_send_start(uuid,uuid,boolean),
  public.facilitator_manual_send_checked(uuid,uuid) to authenticated;
