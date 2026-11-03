-- Capability only: no policy is enabled, no evidence/funds fabricated, no B2C edits.
-- The original constrained-OFF manual policy remains intact as historical baseline.
create table public.manual_payout_operating_policies (
  revision uuid primary key default extensions.gen_random_uuid(),
  sequence bigint generated always as identity unique,
  previous_revision uuid unique references public.manual_payout_operating_policies(revision),
  enabled boolean not null default false,
  custody_id uuid references public.manual_payout_custody(id),
  recipient_ids uuid[] not null default '{}',
  per_payout_minor bigint check(per_payout_minor>0),
  daily_minor bigint check(daily_minor>0),
  payout_fee_minor bigint check(payout_fee_minor>=0),
  fee_payer text check(fee_payer='wedding'),
  statement_max_age_minutes integer check(statement_max_age_minutes>0),
  review_evidence uuid references public.manual_payout_evidence(id),
  fee_evidence uuid references public.manual_payout_evidence(id),
  rail_evidence uuid references public.manual_payout_evidence(id),
  secure_evidence uuid references public.manual_payout_evidence(id),
  actor_id uuid references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp()
);
insert into public.manual_payout_operating_policies(enabled) values(false);
create table public.manual_payout_policy_bindings (
  payout_id uuid primary key references public.manual_payout_requests(id),
  policy_revision uuid not null references public.manual_payout_operating_policies(revision),
  actor_id uuid not null references public.profiles(id),
  bound_at timestamptz not null default clock_timestamp()
);
do $$
declare t text;
begin
  foreach t in array array['manual_payout_operating_policies','manual_payout_policy_bindings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger manual_payout_immutable before update or delete on public.%I
      for each row execute function public.manual_payout_immutable()',t);
  end loop;
end $$;

create function public.manual_payout_policy_blockers(p public.manual_payout_operating_policies) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare blockers jsonb:='[]'; snapshot jsonb; recipient uuid; a public.manual_payout_custody;
begin
  if p.actor_id is null or not exists(select 1 from public.profiles where id=p.actor_id and platform_role='owner') then
    blockers:=blockers||jsonb_build_array('Current protected Owner policy authority required'); end if;
  if p.per_payout_minor is null or p.daily_minor is null or p.daily_minor<p.per_payout_minor
    or p.payout_fee_minor is null or p.fee_payer is distinct from 'wedding' or p.statement_max_age_minutes is null then
    blockers:=blockers||jsonb_build_array('Explicit per-transfer total, UTC-day total, wedding fee payer/amount and statement freshness required'); end if;
  if not exists(select 1 from public.platform_policies where id
    and p.per_payout_minor::numeric-p.payout_fee_minor between min_payout_minor and max_payout_minor) then
    blockers:=blockers||jsonb_build_array('Manual principal limit must fit existing platform payout minimum/maximum'); end if;
  if not public.manual_payout_evidence_accepted(p.review_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.fee_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.rail_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.secure_evidence,'policy',true) then
    blockers:=blockers||jsonb_build_array('Checked policy, fee, existing funded-rail entitlement and secure evidence procedures required'); end if;
  select * into a from public.manual_payout_custody where id=p.custody_id;
  snapshot:=public.manual_payout_custody_snapshot(p.custody_id,true);
  if a.id is null or snapshot is null
    or not public.manual_payout_evidence_accepted(a.evidence_id,'custody',true)
    or not public.manual_payout_evidence_accepted((select evidence_id from public.manual_payout_accounts where id=a.account_reference),'account',true) then
    blockers:=blockers||jsonb_build_array('Checked canonical existing custody account and statement required');
  elsif p.statement_max_age_minutes is null or (snapshot->>'statement_at')::timestamptz<
    clock_timestamp()-make_interval(mins=>p.statement_max_age_minutes) then
    blockers:=blockers||jsonb_build_array('Latest accepted custody statement is stale'); end if;
  if exists(select 1 from public.manual_payout_account_holds where custody_id=p.custody_id)
    or exists(select 1 from public.manual_payout_requests where custody_id=p.custody_id
      and public.manual_payout_state(id) in ('uncertain','resolution_proposed')) then
    blockers:=blockers||jsonb_build_array('Custody incident or uncertain outcome holds admission'); end if;
  if cardinality(p.recipient_ids)=0 or cardinality(p.recipient_ids)>100
    or array_position(p.recipient_ids,null) is not null
    or cardinality(p.recipient_ids)<>(select count(distinct r) from unnest(p.recipient_ids) r) then
    blockers:=blockers||jsonb_build_array('Explicit immutable recipient revision allowlist required');
  else
    foreach recipient in array p.recipient_ids loop
      if not exists(select 1 from public.manual_payout_recipients r join public.wedding_kyc k on k.wedding_id=r.wedding_id
        join public.weddings w on w.id=r.wedding_id where r.id=recipient and r.provider=a.provider
        and r.currency=a.currency and w.currency=r.currency and public.kyc_is_complete(w.id)
        and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')
        and public.manual_payout_evidence_accepted(r.evidence_id,'recipient',true)
        and not exists(select 1 from public.manual_payout_recipients newer where newer.wedding_id=r.wedding_id
          and newer.provider=r.provider and newer.currency=r.currency and newer.revision>r.revision)) then
        blockers:=blockers||jsonb_build_array('Allowlisted recipient evidence, current KYC/consent or currency invalid'); exit;
      end if;
    end loop;
  end if;
  return blockers;
end $$;

create or replace function public.manual_payouts_enabled() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select p.enabled and public.manual_payout_policy_blockers(p)='[]'::jsonb
    from public.manual_payout_operating_policies p order by sequence desc limit 1),false)
$$;

create function public.manual_payout_readiness() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.manual_payout_operating_policies; blockers jsonb;
begin
  perform public.require_staff('superadmin');
  select * into strict p from public.manual_payout_operating_policies order by sequence desc limit 1;
  blockers:=public.manual_payout_policy_blockers(p);
  return jsonb_build_object('policy',to_jsonb(p),'admission_enabled',p.enabled and blockers='[]'::jsonb,
    'configured_enabled',p.enabled,'blockers',blockers,'verification','Human evidence attestation, not provider verification',
    'intake_enabled',true,'outcomes_enabled',true,'automatic_changed',false,
    'history',(select jsonb_agg(to_jsonb(h) order by h.sequence desc) from
      (select * from public.manual_payout_operating_policies order by sequence desc limit 20) h));
end $$;

create function public.owner_set_manual_payout_policy(p_revision uuid,p_changes jsonb,p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old public.manual_payout_operating_policies; n public.manual_payout_operating_policies; key text; blockers jsonb;
begin
  perform public.manual_payout_intake_authority(true);
  select * into strict old from public.manual_payout_operating_policies order by sequence desc limit 1;
  if p_confirmed is not true or old.revision is distinct from p_revision or p_changes is null
    or jsonb_typeof(p_changes)<>'object' or p_changes='{}'::jsonb then
    raise exception 'MANUAL_POLICY_CONFLICT: Confirm current policy revision and explicit changes.'; end if;
  for key in select jsonb_object_keys(p_changes) loop
    if key not in ('enabled','custody_id','recipient_ids','per_payout_minor','daily_minor','payout_fee_minor',
      'fee_payer','statement_max_age_minutes','review_evidence','fee_evidence','rail_evidence','secure_evidence') then
      raise exception 'MANUAL_POLICY_CONFLICT: Unsupported policy field.'; end if;
  end loop;
  n:=jsonb_populate_record(old,p_changes);
  n.actor_id:=auth.uid();
  if n.custody_id is not null then perform 1 from public.manual_payout_custody where id=n.custody_id for update; end if;
  -- Match financial lock order; review authority remains locked through COMMIT.
  perform 1 from public.profiles where id in (select checked_by from public.manual_payout_evidence_checks)
    order by id for share;
  perform 1 from public.platform_policies where id for share;
  blockers:=public.manual_payout_policy_blockers(n);
  if n.enabled and blockers<>'[]'::jsonb then
    raise exception 'MANUAL_POLICY_BLOCKED: Reviewed policy prerequisites incomplete; inspect readiness.'; end if;
  insert into public.manual_payout_operating_policies(previous_revision,enabled,custody_id,recipient_ids,
    per_payout_minor,daily_minor,payout_fee_minor,fee_payer,statement_max_age_minutes,
    review_evidence,fee_evidence,rail_evidence,secure_evidence,actor_id)
    values(old.revision,n.enabled,n.custody_id,n.recipient_ids,n.per_payout_minor,n.daily_minor,n.payout_fee_minor,
      n.fee_payer,n.statement_max_age_minutes,n.review_evidence,n.fee_evidence,n.rail_evidence,n.secure_evidence,auth.uid());
  insert into public.audit_events(actor_id,table_name,record_id,action)
    values(auth.uid(),'manual_payout_operating_policies',old.revision::text,
      case when n.enabled then 'manual_policy_enabled_revision' else 'manual_policy_disabled_revision' end);
  return public.manual_payout_readiness();
end $$;

-- Preparation and post-claim accounting must remain available while admission OFF.
-- Reuse the released functions, changing ONLY their entry guard. Fail migration if
-- a predecessor differs, rather than silently replacing unknown financial logic.
do $$
declare f record; definition text; updated text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('manual_payout_transition','manual_payout_report','manual_payout_reconcile') loop
    definition:=pg_get_functiondef(f.oid);
    updated:=replace(definition,'perform public.manual_payout_require_enabled();',
      'perform public.require_staff(''superadmin''); perform public.manual_payout_intake_authority(false);');
    if updated=definition then raise exception 'Unexpected manual outcome guard predecessor'; end if;
    execute updated;
  end loop;
end $$;

create or replace function public.manual_payout_submit_evidence(p_kind text,p_reference uuid,p_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  if p_kind='policy' and public.current_platform_role()<>'owner' then raise exception 'Only protected Owner may submit policy evidence.'; end if;
  insert into public.manual_payout_evidence(kind,external_reference,sha256,submitted_by)
    values(p_kind,p_reference,p_sha256,auth.uid()) returning manual_payout_evidence.id into v_id;
  return v_id;
end $$;
create or replace function public.manual_payout_check_evidence(p_id uuid,p_owner_solo boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.manual_payout_evidence;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(p_owner_solo);
  select * into strict e from public.manual_payout_evidence where id=p_id;
  if e.kind='policy' and public.current_platform_role()<>'owner' then raise exception 'Protected Owner policy review required.'; end if;
  if e.submitted_by=auth.uid() and not p_owner_solo then raise exception 'A different leader must check evidence.'; end if;
  insert into public.manual_payout_evidence_checks(evidence_id,checked_by,owner_solo) values(p_id,auth.uid(),p_owner_solo);
  return true;
end $$;

-- Same private intake validators as B2C, but explicit manual Owner-solo authority.
do $$
declare f record; arguments text; names text;
begin
  for f in select p.oid,p.proname,p.proargnames,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('manual_payout_recipient_internal','manual_payout_register_account_internal',
      'manual_payout_append_statement_internal','manual_payout_map_source_internal','manual_payout_register_statement_debit_internal',
      'manual_payout_register_custody_internal','manual_payout_register_settlement_internal') loop
    arguments:=regexp_replace(pg_get_function_arguments(f.oid),', p_allow_owner_solo boolean DEFAULT false$','');
    if arguments=pg_get_function_arguments(f.oid) then raise exception 'Unexpected shared intake signature'; end if;
    select string_agg(quote_ident(x),',' order by i) into names
      from unnest(f.proargnames[1:f.pronargs-1]) with ordinality a(x,i);
    execute format($wrapper$
      create or replace function public.%I(%s) returns %s language plpgsql security definer set search_path='' as $body$
      begin
        perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
        return public.%I(%s,public.current_platform_role()='owner');
      end $body$;
    $wrapper$,regexp_replace(f.proname,'_internal$',''),arguments,pg_get_function_result(f.oid),f.proname,names);
  end loop;
end $$;

create function public.manual_payout_check_operating_policy(p_custody uuid,p_recipient uuid,p_amount bigint,p_fee bigint,
  p_excluding uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.manual_payout_operating_policies; exposure numeric;
begin
  perform public.manual_payout_require_enabled();
  select * into strict p from public.manual_payout_operating_policies order by sequence desc limit 1;
  perform public.manual_payout_lock(p_custody,(select wedding_id from public.manual_payout_recipients where id=p_recipient));
  perform public.manual_payout_require_enabled();
  if p.custody_id is distinct from p_custody or not (p_recipient=any(p.recipient_ids))
    or p_fee is distinct from p.payout_fee_minor or p_amount is null or p_amount<=0
    or p_amount::numeric+p_fee>p.per_payout_minor then
    raise exception 'MANUAL_POLICY_BLOCKED: Request outside reviewed account/recipient/amount/fee scope.'; end if;
  if p_excluding is not null and not exists(select 1 from public.manual_payout_policy_bindings
    where payout_id=p_excluding and policy_revision=p.revision) then
    raise exception 'MANUAL_POLICY_CONFLICT: Request policy is stale; cancel unclaimed request and review a new request.'; end if;
  -- UTC-day total includes both rails on this custody, and every prior-day open
  -- commitment; no new revision or channel switch resets exposure.
  select coalesce(sum(r.amount_minor::numeric+r.fee_minor),0) into exposure
    from public.manual_payout_requests r where r.custody_id=p_custody and r.id is distinct from p_excluding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')
      and (public.manual_payout_state(r.id)<>'paid'
        or r.requested_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')
        or exists(select 1 from public.manual_payout_claims c where c.payout_id=r.id
          and c.claimed_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))
        or exists(select 1 from public.manual_payout_events e where e.payout_id=r.id and e.state='paid'
          and e.created_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'))
        or exists(select 1 from public.manual_payout_receipts x where x.payout_id=r.id
          and x.transferred_at>=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')));
  if exposure+p_amount+p_fee>p.daily_minor then raise exception 'MANUAL_POLICY_BLOCKED: UTC-day total including open commitments exceeded.'; end if;
  return p.revision;
end $$;

alter function public.manual_payout_request(uuid,uuid,uuid,uuid,bigint,bigint,text,boolean) rename to manual_payout_request_foundation;
create function public.manual_payout_request(p_key uuid,p_wedding uuid,p_custody uuid,p_recipient uuid,
  p_amount bigint,p_fee bigint,p_currency text,p_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare revision uuid; id uuid; prior public.manual_payout_requests;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into prior from public.manual_payout_requests where request_key=p_key;
  if found then
    if (prior.wedding_id,prior.custody_id,prior.recipient_revision,prior.amount_minor,prior.fee_minor,prior.currency,prior.requested_by,prior.owner_solo)
      is distinct from (p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,auth.uid(),p_owner_solo) then
      raise exception 'Idempotency key input conflict.'; end if;
    if not exists(select 1 from public.manual_payout_policy_bindings where payout_id=prior.id) then
      raise exception 'MANUAL_POLICY_CONFLICT: Key belongs to another or historical channel.'; end if;
    return prior.id;
  end if;
  revision:=public.manual_payout_check_operating_policy(p_custody,p_recipient,p_amount,p_fee);
  id:=public.manual_payout_request_foundation(p_key,p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,p_owner_solo);
  insert into public.manual_payout_policy_bindings values(id,revision,auth.uid(),clock_timestamp());
  return id;
end $$;
alter function public.manual_payout_transition(uuid,text,uuid,uuid) rename to manual_payout_transition_foundation;
create function public.manual_payout_transition(p_id uuid,p_action text,p_key uuid default null,p_evidence uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_requests;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into strict r from public.manual_payout_requests where id=p_id;
  if p_action in ('approved','executing') then
    perform public.manual_payout_check_operating_policy(r.custody_id,r.recipient_revision,r.amount_minor,r.fee_minor,r.id);
  end if;
  return public.manual_payout_transition_foundation(p_id,p_action,p_key,p_evidence);
end $$;

-- Keep shared accounting, recipient and manual/automatic reconciliation unchanged.
-- Couples still cannot request a manual payout; activation never unlocks legacy RPCs.
alter function public.manual_payout_overview() rename to manual_payout_overview_foundation;
create function public.manual_payout_overview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.manual_payout_overview_foundation();
  return result||jsonb_build_object('enabled',public.manual_payouts_enabled(),
    'readiness',public.manual_payout_readiness(),'blockers',(public.manual_payout_readiness())->'blockers');
end $$;

alter function public.manual_payout_balance(uuid) rename to manual_payout_balance_foundation;
create function public.manual_payout_balance(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  return public.manual_payout_balance_foundation(p_wedding)||jsonb_build_object(
    'available_minor',0,'enabled',public.manual_payouts_enabled(),
    'status','Manual requests are staff-controlled. Estimates are not spendable or a transfer promise.');
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'manual_payout%' or p.proname='owner_set_manual_payout_policy') loop
    if f.proname in ('manual_payout_request_foundation','manual_payout_transition_foundation','manual_payout_overview_foundation',
      'manual_payout_balance_foundation',
      'manual_payout_policy_blockers','manual_payout_check_operating_policy') then
      execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    elsif f.proname in ('manual_payout_request','manual_payout_transition','manual_payout_overview',
      'manual_payout_readiness','manual_payout_balance','owner_set_manual_payout_policy') then
      execute format('revoke all on function %s from public,anon,service_role',f.signature);
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
