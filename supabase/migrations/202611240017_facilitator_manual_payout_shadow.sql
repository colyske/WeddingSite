-- Unexposed manual-workflow model. No custody account or cash balance is
-- inferred. This is not authorization to send or record a real transfer.
create table public.facilitator_manual_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null,
  user_id uuid not null references public.profiles(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  currency text not null check (currency='KES'),
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  allocation_digest text not null check (allocation_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,request_key)
);
create table public.facilitator_manual_allocations (
  request_id uuid not null references public.facilitator_manual_requests(id),
  contribution_id uuid not null references public.referral_contribution_policy(contribution_id),
  review_id uuid not null references public.referral_funding_reviews(id),
  source_digest text not null,
  amount_minor bigint not null check (amount_minor>0),
  primary key(request_id,contribution_id)
);
create index facilitator_manual_allocations_source on public.facilitator_manual_allocations(contribution_id);
create table public.facilitator_manual_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.facilitator_manual_requests(id),
  action_key uuid not null unique,
  state text not null check (state in ('requested','reviewed','processing','hold','paid','cancelled')),
  reason text,
  fee_minor bigint,
  owner_solo boolean,
  transaction_reference text,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create table public.facilitator_manual_claims (
  request_id uuid primary key references public.facilitator_manual_requests(id),
  sender_id uuid not null references public.profiles(id),
  reviewer_id uuid references public.profiles(id),
  owner_solo boolean not null,
  fee_minor bigint not null check (fee_minor between 0 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  check ((owner_solo and reviewer_id is null) or (not owner_solo and reviewer_id is not null))
);
create table public.facilitator_manual_receipts (
  request_id uuid primary key references public.facilitator_manual_claims(request_id),
  provider text not null check (provider='daraja'),
  transaction_reference text not null check (transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  reported_by uuid not null references public.profiles(id),
  reported_at timestamptz not null default clock_timestamp(),
  unique(provider,transaction_reference)
);
create table public.facilitator_manual_incidents (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.facilitator_manual_claims(request_id),
  action_key uuid not null unique,
  transaction_reference text not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['facilitator_manual_requests','facilitator_manual_allocations',
    'facilitator_manual_events','facilitator_manual_claims','facilitator_manual_receipts',
    'facilitator_manual_incidents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger immutable before update or delete on public.%I
      for each row execute function public.referral_immutable()',t);
  end loop;
end $$;

create function public.facilitator_manual_enabled() returns boolean
language sql immutable set search_path='' as $$ select false $$;
create function public.facilitator_manual_state(p_request uuid) returns text
language sql stable security definer set search_path='' set row_security=off as $$
  select state from public.facilitator_manual_events where request_id=p_request order by id desc limit 1
$$;

-- Caller holds both global locks and the contribution row. A checked review is
-- a source-specific attestation, not proof of available external cash.
create function public.facilitator_manual_source_cap(p_contribution uuid,p_user uuid,p_currency text)
returns numeric language plpgsql security definer set search_path='' set row_security=off as $$
declare c public.contributions; b public.referral_balances; f public.referral_funding_reviews;
begin
  select * into c from public.contributions where id=p_contribution;
  perform public.referral_reconcile_estimate(p_contribution);
  select * into b from public.referral_balances where contribution_id=p_contribution;
  select * into f from public.referral_funding_reviews where contribution_id=p_contribution
    order by recorded_at desc,id desc limit 1;
  if c.id is null or b.contribution_id is null or f.id is null
    or f.currency is distinct from p_currency or c.currency::text is distinct from p_currency
    or not exists(select 1 from public.referral_funding_review_checks where review_id=f.id)
    or not exists(select 1 from public.referral_contribution_policy p
      join public.referral_attributions a on a.wedding_id=p.wedding_id
      join public.weddings w on w.id=p.wedding_id
      where p.contribution_id=p_contribution and p.rate_basis_points>0
        and a.referrer_id=p_user and a.eligible and w.client_owner_id is distinct from a.referrer_id
        and not exists(select 1 from public.wedding_memberships m
          where m.wedding_id=w.id and m.user_id=a.referrer_id and m.role='client'))
    or c.payment_environment is distinct from 'live'
    or c.payment_status is distinct from 'paid'
    or c.verified_provider_payment is distinct from true
    or c.settlement_route is distinct from 'platform_wallet'
    or c.provider_fee_pending is distinct from false
    or c.funds_available_at is null or c.funds_available_at>clock_timestamp()
    or b.hold_reasons && array['provider_cost_unknown','currency_mismatch','adjustment_review_or_hold',
      'overlapping_or_invalid_adjustments','refund_evidence_missing','not_eligible_verified_live_payment',
      'provable_self_account_link','policy_or_consent_off_at_admission']::text[]
    or encode(extensions.digest(jsonb_build_array(b.source_digest,c.funds_available_at,c.settlement_route)::text,
      'sha256'),'hex') is distinct from f.source_digest then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current checked source evidence is required.';
  end if;
  return least(f.estimate_minor::numeric,b.held_estimate_minor::numeric,
    greatest(0::numeric,f.settled_platform_fee_minor::numeric-f.provider_cost_minor-f.losses_minor
      -f.holds_minor-f.other_commitments_minor));
end $$;

-- Recheck every retained source, across beneficiaries and currencies. Cancelled
-- unclaimed requests are released; paid and uncertain claims remain liabilities.
create function public.facilitator_manual_check_sources() returns void
language plpgsql security definer set search_path='' set row_security=off as $$
declare x record; cap numeric;
begin
  if not public.verified_adjustment_inbox_clear_for_payout() then
    raise exception 'FACILITATOR_MANUAL_HOLD: Provider observations require review.';
  end if;
  for x in
    select a.contribution_id,r.user_id,r.currency,sum(a.amount_minor::numeric) amount
    from public.facilitator_manual_allocations a
    join public.facilitator_manual_requests r on r.id=a.request_id
    where public.facilitator_manual_state(r.id)<>'cancelled'
    group by a.contribution_id,r.user_id,r.currency order by a.contribution_id
  loop
    perform 1 from public.contributions where id=x.contribution_id for update;
    cap:=public.facilitator_manual_source_cap(x.contribution_id,x.user_id,x.currency);
    if x.amount + coalesce((select sum(a.amount_minor::numeric)
        from public.facilitator_reservation_allocations a where a.contribution_id=x.contribution_id),0)>cap then
      raise exception 'FACILITATOR_MANUAL_HOLD: Retained source liabilities exceed current evidence.';
    end if;
  end loop;
end $$;

create function public.facilitator_manual_request_internal(
  p_key uuid,p_recipient uuid,p_currency text,p_amount bigint,p_allocations jsonb,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare old public.facilitator_manual_requests; x record; f public.referral_funding_reviews;
  digest text; total numeric; used numeric; cap numeric; result uuid;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_key is null or p_recipient is null or p_currency is distinct from 'KES'
    or p_amount is null or p_amount not between 1 and 9007199254740991
    or p_confirmed is distinct from true or jsonb_typeof(p_allocations) is distinct from 'array' then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm a valid request.';
  end if;
  if jsonb_array_length(p_allocations) not between 1 and 100
    or exists(select 1 from jsonb_array_elements(p_allocations) e where jsonb_typeof(e) is distinct from 'object') then
    raise exception 'FACILITATOR_MANUAL_INPUT: Invalid allocations.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_allocations) e
    where (select count(*) from jsonb_object_keys(e))<>2
      or coalesce(e->>'review','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(e->>'amount','') !~ '^[1-9][0-9]{0,15}$'
      or (e->>'amount')::numeric>9007199254740991) then
    raise exception 'FACILITATOR_MANUAL_INPUT: Invalid allocation.';
  end if;
  select sum((e->>'amount')::numeric),encode(extensions.digest(
    jsonb_agg(jsonb_build_array(lower(e->>'review'),e->>'amount') order by lower(e->>'review'))::text,'sha256'),'hex')
    into total,digest from jsonb_array_elements(p_allocations) e;
  if total<>p_amount or (select count(distinct lower(e->>'review')) from jsonb_array_elements(p_allocations) e)
    <>jsonb_array_length(p_allocations) then
    raise exception 'FACILITATOR_MANUAL_INPUT: Invalid allocation total or duplicate review.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into old from public.facilitator_manual_requests where user_id=auth.uid() and request_key=p_key;
  if found then
    if (old.recipient_revision,old.currency,old.amount_minor,old.allocation_digest)
      is distinct from (p_recipient,p_currency,p_amount,digest) then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Request retry changed.';
    end if;
    return old.id;
  end if;
  if not public.facilitator_payout_recipient_ready(auth.uid(),p_recipient) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current verified recipient required.';
  end if;
  perform public.facilitator_manual_check_sources();
  for x in select (e->>'review')::uuid review_id,(e->>'amount')::bigint amount
    from jsonb_array_elements(p_allocations) e order by (e->>'review')::uuid loop
    select * into f from public.referral_funding_reviews where id=x.review_id;
    if f.id is null or f.id is distinct from (select id from public.referral_funding_reviews
      where contribution_id=f.contribution_id order by recorded_at desc,id desc limit 1) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Latest reviewed source required.';
    end if;
    perform 1 from public.contributions where id=f.contribution_id for update;
    cap:=public.facilitator_manual_source_cap(f.contribution_id,auth.uid(),p_currency);
    select coalesce(sum(a.amount_minor::numeric),0) into used from public.facilitator_manual_allocations a
      join public.facilitator_manual_requests r on r.id=a.request_id
      where a.contribution_id=f.contribution_id and public.facilitator_manual_state(r.id)<>'cancelled';
    select used+coalesce(sum(amount_minor::numeric),0) into used
      from public.facilitator_reservation_allocations where contribution_id=f.contribution_id;
    if used+x.amount>cap then
      raise exception 'FACILITATOR_MANUAL_HOLD: Source cannot cover the request and retained liabilities.';
    end if;
  end loop;
  if (select count(distinct f.contribution_id) from jsonb_array_elements(p_allocations) e
      join public.referral_funding_reviews f on f.id=(e->>'review')::uuid)<>jsonb_array_length(p_allocations) then
    raise exception 'FACILITATOR_MANUAL_INPUT: Duplicate source.';
  end if;
  insert into public.facilitator_manual_requests(request_key,user_id,recipient_revision,currency,amount_minor,allocation_digest)
    values(p_key,auth.uid(),p_recipient,p_currency,p_amount,digest) returning id into result;
  insert into public.facilitator_manual_allocations(request_id,contribution_id,review_id,source_digest,amount_minor)
    select result,f.contribution_id,f.id,f.source_digest,(e->>'amount')::bigint
    from jsonb_array_elements(p_allocations) e join public.referral_funding_reviews f on f.id=(e->>'review')::uuid;
  insert into public.facilitator_manual_events(request_id,action_key,state,actor_id)
    values(result,p_key,'requested',auth.uid());
  return result;
end $$;

create function public.facilitator_manual_action_internal(
  p_request uuid,p_key uuid,p_action text,p_reason text,p_fee bigint,
  p_reference text,p_owner_solo boolean,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; c public.facilitator_manual_claims;
  old public.facilitator_manual_events; role_name public.platform_role; reviewer uuid;
  current_state text; ref text:=upper(btrim(p_reference));
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_key is null or p_confirmed is distinct from true
    or p_owner_solo is null or p_action is null
    or p_action not in ('hold','reviewed','processing','paid','cancelled')
    or (p_action='hold' and (p_reason is null or p_reason not in
      ('recipient_check','funds_review','operator_unavailable','outcome_uncertain','other_review')))
    or (p_action<>'hold' and p_reason is not null)
    or (p_action<>'processing' and (p_fee is not null or p_owner_solo))
    or (p_action='processing' and (p_fee is null or p_fee not between 0 and 9007199254740991))
    or (p_action<>'paid' and p_reference is not null)
    or (p_action='paid' and (ref is null or ref !~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$')) then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm a valid action and its fields.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  role_name:=public.require_staff('admin');
  if p_owner_solo and role_name is distinct from 'owner' then
    raise exception 'FACILITATOR_MANUAL_AUTH: Only the Owner may act solo.';
  end if;
  select * into r from public.facilitator_manual_requests where id=p_request;
  if not found then raise exception 'FACILITATOR_MANUAL_CONFLICT: Request not found.'; end if;
  select * into old from public.facilitator_manual_events where action_key=p_key;
  if found then
    if (old.request_id,old.state,old.reason,old.actor_id,old.fee_minor,old.owner_solo,old.transaction_reference)
      is not distinct from (p_request,p_action,p_reason,auth.uid(),p_fee,
        case when p_action='processing' then p_owner_solo else null end,ref) then
      return jsonb_build_object('state',public.facilitator_manual_state(p_request),'replayed',true);
    end if;
    if p_action='paid' and exists(select 1 from public.facilitator_manual_incidents
      where action_key=p_key and request_id=p_request and actor_id=auth.uid() and transaction_reference=ref) then
      return jsonb_build_object('state','hold','conflict',true,'replayed',true);
    end if;
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Action retry changed; do not resend.';
  end if;
  current_state:=public.facilitator_manual_state(p_request);
  select * into c from public.facilitator_manual_claims where request_id=p_request;
  if current_state in ('paid','cancelled') then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Request is terminal.';
  end if;
  if p_action='cancelled' and c.request_id is not null then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Claimed payout cannot be released; do not resend.';
  end if;
  if p_action in ('reviewed','processing') then
    if c.request_id is not null then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Already claimed; do not resend.';
    end if;
    perform 1 from public.profiles where id=r.user_id for update;
    if not public.facilitator_payout_recipient_ready(r.user_id,r.recipient_revision) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Recipient changed or is not verified.';
    end if;
    perform public.facilitator_manual_check_sources();
  end if;
  if p_action='processing' then
    if p_owner_solo then
      reviewer:=null;
    else
      select e.actor_id into reviewer from public.facilitator_manual_events e
        join public.profiles p on p.id=e.actor_id and p.platform_role in ('admin','superadmin','owner')
        where e.request_id=p_request and e.state='reviewed' and e.actor_id<>auth.uid()
          and e.id>coalesce((select max(h.id) from public.facilitator_manual_events h
            where h.request_id=p_request and h.state='hold'),0)
        order by e.id desc limit 1;
      if reviewer is null then raise exception 'FACILITATOR_MANUAL_AUTH: Another staff reviewer is required.'; end if;
      perform 1 from public.profiles where id=reviewer and platform_role in ('admin','superadmin','owner') for share;
      if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Reviewer authority changed.'; end if;
    end if;
    if exists(select 1 from public.facilitator_manual_incidents) then
      raise exception 'FACILITATOR_MANUAL_HOLD: A duplicate receipt requires review; do not send.';
    end if;
    insert into public.facilitator_manual_claims(request_id,sender_id,reviewer_id,owner_solo,fee_minor)
      values(p_request,auth.uid(),reviewer,p_owner_solo,p_fee);
  elsif p_action='paid' then
    if c.request_id is null or c.sender_id is distinct from auth.uid() then
      raise exception 'FACILITATOR_MANUAL_AUTH: Only the claimed sender may report an outcome.';
    end if;
    if exists(select 1 from public.facilitator_manual_incidents where request_id=p_request) then
      raise exception 'FACILITATOR_MANUAL_HOLD: A conflicting outcome requires review; do not resend.';
    end if;
    if exists(select 1 from public.facilitator_manual_receipts where provider='daraja' and transaction_reference=ref)
      or exists(select 1 from public.simple_payout_receipts where provider='daraja' and transaction_reference=ref)
      or exists(select 1 from public.manual_payout_receipts where provider='daraja' and transaction_reference=ref)
      or exists(select 1 from public.b2c_callback_events where kind='result' and evidence->>'result_code'='0'
        and upper(evidence->>'transaction_id')=ref) then
      insert into public.facilitator_manual_incidents(request_id,action_key,transaction_reference,actor_id)
        values(p_request,p_key,ref,auth.uid());
      insert into public.facilitator_manual_events(request_id,action_key,state,reason,actor_id)
        values(p_request,p_key,'hold','outcome_uncertain',auth.uid());
      return jsonb_build_object('state','hold','conflict',true,'message','Conflicting reference; do not resend.');
    end if;
    insert into public.facilitator_manual_receipts(request_id,provider,transaction_reference,reported_by)
      values(p_request,'daraja',ref,auth.uid());
  end if;
  insert into public.facilitator_manual_events(request_id,action_key,state,reason,fee_minor,owner_solo,transaction_reference,actor_id)
    values(p_request,p_key,p_action,p_reason,p_fee,case when p_action='processing' then p_owner_solo else null end,ref,auth.uid());
  return jsonb_build_object('state',p_action,'operator_reported',p_action='paid');
end $$;

revoke all on function public.facilitator_manual_enabled(),public.facilitator_manual_state(uuid),
  public.facilitator_manual_source_cap(uuid,uuid,text),public.facilitator_manual_check_sources(),
  public.facilitator_manual_request_internal(uuid,uuid,text,bigint,jsonb,boolean),
  public.facilitator_manual_action_internal(uuid,uuid,text,text,bigint,text,boolean,boolean)
  from public,anon,authenticated,service_role;
