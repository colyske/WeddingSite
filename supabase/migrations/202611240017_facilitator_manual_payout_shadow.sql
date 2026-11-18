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
  evidence_digest text,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create table public.facilitator_manual_claims (
  request_id uuid primary key references public.facilitator_manual_requests(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  binding_id uuid,
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
  action_key uuid not null,
  transaction_reference text not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(request_id,action_key,transaction_reference,actor_id)
);
create table public.facilitator_manual_reports (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.facilitator_manual_claims(request_id),
  action_key uuid not null,
  transaction_reference text not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(request_id,action_key,transaction_reference,actor_id)
);
create table public.facilitator_manual_incident_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  incident_id bigint not null references public.facilitator_manual_incidents(id),
  request_key uuid not null unique,
  external_reference uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default clock_timestamp()
);
create table public.facilitator_manual_incident_reviews (
  incident_id bigint primary key references public.facilitator_manual_incidents(id),
  evidence_id uuid not null unique references public.facilitator_manual_incident_evidence(id),
  checked_by uuid not null references public.profiles(id),
  owner_solo boolean not null,
  checked_at timestamptz not null default clock_timestamp()
);
create table public.facilitator_manual_reconfirmations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null references public.facilitator_manual_requests(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  expected_binding uuid,
  request_key uuid not null,
  actor_id uuid not null references public.profiles(id),
  confirmed_at timestamptz not null default clock_timestamp(),
  unique(actor_id,request_key)
);
create table public.facilitator_manual_rebindings (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence bigint generated always as identity unique,
  request_id uuid not null references public.facilitator_manual_requests(id),
  previous_binding uuid references public.facilitator_manual_rebindings(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  reconfirmation_id uuid references public.facilitator_manual_reconfirmations(id),
  action_key uuid not null unique,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default clock_timestamp()
);
alter table public.facilitator_manual_reconfirmations add constraint facilitator_manual_confirmation_binding_fk
  foreign key(expected_binding) references public.facilitator_manual_rebindings(id);
alter table public.facilitator_manual_claims add constraint facilitator_manual_claim_binding_fk
  foreign key(binding_id) references public.facilitator_manual_rebindings(id);
create index facilitator_manual_rebinding_request on public.facilitator_manual_rebindings(request_id,sequence desc);
do $$ declare t text; begin
  foreach t in array array['facilitator_manual_requests','facilitator_manual_allocations',
    'facilitator_manual_events','facilitator_manual_claims','facilitator_manual_receipts',
    'facilitator_manual_incidents','facilitator_manual_reports',
    'facilitator_manual_incident_evidence','facilitator_manual_incident_reviews',
    'facilitator_manual_reconfirmations','facilitator_manual_rebindings'] loop
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

-- Caller holds the beneficiary profile lock and both accounting locks. Lock
-- the checker before the final readiness read so a role revocation that wins
-- the row lock is observed, and a later revocation waits for this transaction.
create function public.facilitator_manual_lock_recipient(p_user uuid,p_revision uuid) returns boolean
language plpgsql security definer set search_path='' set row_security=off as $$
declare checker uuid;
begin
  select c.checked_by into checker from public.facilitator_recipient_checks c
    join public.facilitator_recipient_versions v on v.revision_id=c.revision_id
    where v.revision_id=p_revision and v.user_id=p_user;
  if checker is not null then
    perform 1 from public.profiles where id=checker for share;
  end if;
  return public.facilitator_payout_recipient_ready(p_user,p_revision);
end $$;

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

-- A source deficit freezes its beneficiary and currency, including unrelated
-- sources in that bucket. Paid and uncertain claims remain liabilities.
create function public.facilitator_manual_check_sources(p_user uuid,p_currency text) returns void
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
    where r.user_id=p_user and r.currency=p_currency and public.facilitator_manual_state(r.id)<>'cancelled'
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

-- Caller holds the accounting locks and the contribution row.
create function public.facilitator_manual_source_available(p_contribution uuid,p_user uuid,p_currency text)
returns numeric language plpgsql security definer set search_path='' set row_security=off as $$
declare cap numeric; used numeric;
begin
  cap:=public.facilitator_manual_source_cap(p_contribution,p_user,p_currency);
  select coalesce(sum(a.amount_minor::numeric),0) into used from public.facilitator_manual_allocations a
    join public.facilitator_manual_requests r on r.id=a.request_id
    where a.contribution_id=p_contribution and public.facilitator_manual_state(r.id)<>'cancelled';
  select used+coalesce(sum(amount_minor::numeric),0) into used
    from public.facilitator_reservation_allocations where contribution_id=p_contribution;
  return cap-used;
end $$;

-- A single source quote is advisory, not a balance, reservation or cash check.
create function public.facilitator_manual_source_quote_internal(p_review uuid,p_currency text) returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare f public.referral_funding_reviews; available numeric;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_review is null or p_currency is distinct from 'KES' then
    raise exception 'FACILITATOR_MANUAL_INPUT: A signed-in beneficiary and valid source are required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for update;
  perform public.facilitator_manual_check_sources(auth.uid(),p_currency);
  select * into f from public.referral_funding_reviews where id=p_review;
  if f.id is null or f.id is distinct from (select id from public.referral_funding_reviews
    where contribution_id=f.contribution_id order by recorded_at desc,id desc limit 1) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Latest reviewed source required.';
  end if;
  perform 1 from public.contributions where id=f.contribution_id for update;
  available:=public.facilitator_manual_source_available(f.contribution_id,auth.uid(),p_currency);
  if available<0 then
    raise exception 'FACILITATOR_MANUAL_HOLD: Source cannot cover retained liabilities.';
  end if;
  return jsonb_build_object('review_id',f.id,'currency',p_currency,'capacity_minor',available::text,
    'reserved',false,'external_cash_verified',false,'send_authorized',false);
end $$;

create function public.facilitator_manual_request_internal(
  p_key uuid,p_recipient uuid,p_currency text,p_amount bigint,p_allocations jsonb,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare old public.facilitator_manual_requests; x record; f public.referral_funding_reviews;
  digest text; total numeric; result uuid;
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
  if not public.facilitator_manual_lock_recipient(auth.uid(),p_recipient) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current verified recipient required.';
  end if;
  perform public.facilitator_manual_check_sources(auth.uid(),p_currency);
  for x in select (e->>'review')::uuid review_id,(e->>'amount')::bigint amount
    from jsonb_array_elements(p_allocations) e order by (e->>'review')::uuid loop
    select * into f from public.referral_funding_reviews where id=x.review_id;
    if f.id is null or f.id is distinct from (select id from public.referral_funding_reviews
      where contribution_id=f.contribution_id order by recorded_at desc,id desc limit 1) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Latest reviewed source required.';
    end if;
    perform 1 from public.contributions where id=f.contribution_id for update;
    if x.amount>public.facilitator_manual_source_available(f.contribution_id,auth.uid(),p_currency) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Source cannot cover the request and retained liabilities.';
    end if;
  end loop;
  if (select count(distinct fr.contribution_id) from jsonb_array_elements(p_allocations) e
      join public.referral_funding_reviews fr on fr.id=(e->>'review')::uuid)<>jsonb_array_length(p_allocations) then
    raise exception 'FACILITATOR_MANUAL_INPUT: Duplicate source.';
  end if;
  insert into public.facilitator_manual_requests(request_key,user_id,recipient_revision,currency,amount_minor,allocation_digest)
    values(p_key,auth.uid(),p_recipient,p_currency,p_amount,digest) returning id into result;
  insert into public.facilitator_manual_allocations(request_id,contribution_id,review_id,source_digest,amount_minor)
    select result,fr.contribution_id,fr.id,fr.source_digest,(e->>'amount')::bigint
    from jsonb_array_elements(p_allocations) e join public.referral_funding_reviews fr on fr.id=(e->>'review')::uuid;
  insert into public.facilitator_manual_events(request_id,action_key,state,actor_id)
    values(result,p_key,'requested',auth.uid());
  return result;
end $$;

create function public.facilitator_manual_reconfirm_internal(
  p_request uuid,p_recipient uuid,p_expected uuid,p_key uuid,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; old public.facilitator_manual_reconfirmations;
  latest uuid; result uuid;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_recipient is null or p_key is null
    or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_MANUAL_INPUT: Explicit recipient confirmation is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into r from public.facilitator_manual_requests where id=p_request and user_id=auth.uid();
  if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Only the beneficiary can confirm.'; end if;
  select * into old from public.facilitator_manual_reconfirmations where actor_id=auth.uid() and request_key=p_key;
  if found then
    if (old.request_id,old.recipient_revision,old.expected_binding)
      is distinct from (p_request,p_recipient,p_expected) then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Confirmation retry changed.';
    end if;
    return old.id;
  end if;
  if public.facilitator_manual_state(p_request) in ('paid','cancelled')
    or exists(select 1 from public.facilitator_manual_claims where request_id=p_request) then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Claimed or terminal requests cannot change destination.';
  end if;
  select id into latest from public.facilitator_manual_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if latest is distinct from p_expected then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Destination binding changed; reload.';
  end if;
  if not public.facilitator_manual_lock_recipient(r.user_id,p_recipient) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current verified recipient required.';
  end if;
  insert into public.facilitator_manual_reconfirmations(request_id,recipient_revision,expected_binding,request_key,actor_id)
    values(p_request,p_recipient,p_expected,p_key,auth.uid()) returning id into result;
  return result;
end $$;

create function public.facilitator_manual_rebind_internal(
  p_request uuid,p_expected uuid,p_key uuid,p_recipient uuid,p_reconfirmation uuid,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; old public.facilitator_manual_rebindings;
  latest public.facilitator_manual_rebindings; current_recipient uuid; result uuid;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null or p_recipient is null or p_key is null
    or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm the destination review.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('superadmin');
  select * into r from public.facilitator_manual_requests where id=p_request;
  if not found then raise exception 'FACILITATOR_MANUAL_CONFLICT: Request not found.'; end if;
  select * into old from public.facilitator_manual_rebindings where action_key=p_key;
  if found then
    if (old.request_id,old.previous_binding,old.recipient_revision,old.reconfirmation_id,old.reviewed_by)
      is distinct from (p_request,p_expected,p_recipient,p_reconfirmation,auth.uid()) then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Destination review retry changed.';
    end if;
    return old.id;
  end if;
  if public.facilitator_manual_state(p_request) in ('paid','cancelled')
    or exists(select 1 from public.facilitator_manual_claims where request_id=p_request) then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Claimed or terminal requests cannot change destination.';
  end if;
  perform 1 from public.profiles where id=r.user_id for update;
  select * into latest from public.facilitator_manual_rebindings
    where request_id=p_request order by sequence desc limit 1;
  if latest.id is distinct from p_expected then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Destination binding changed; reload.';
  end if;
  current_recipient:=coalesce(latest.recipient_revision,r.recipient_revision);
  if p_recipient is distinct from current_recipient then
    if not exists(select 1 from public.facilitator_manual_reconfirmations c
      where c.id=p_reconfirmation and c.request_id=p_request and c.actor_id=r.user_id
        and c.recipient_revision=p_recipient and c.expected_binding is not distinct from p_expected) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Beneficiary must confirm the changed recipient.';
    end if;
  elsif p_reconfirmation is not null then
    raise exception 'FACILITATOR_MANUAL_INPUT: Unexpected recipient confirmation.';
  end if;
  if not public.facilitator_manual_lock_recipient(r.user_id,p_recipient) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current verified recipient required.';
  end if;
  perform public.facilitator_manual_check_sources(r.user_id,r.currency);
  insert into public.facilitator_manual_rebindings(request_id,previous_binding,recipient_revision,
    reconfirmation_id,action_key,reviewed_by)
    values(p_request,p_expected,p_recipient,p_reconfirmation,p_key,auth.uid()) returning id into result;
  return result;
end $$;

create function public.facilitator_manual_evidence_digest(p_request uuid) returns text
language sql stable security definer set search_path='' set row_security=off as $$
  select encode(extensions.digest(jsonb_build_array(coalesce(binding.recipient_revision,r.recipient_revision),
    binding.id,r.currency,
    jsonb_agg(jsonb_build_array(a.contribution_id,f.id,f.source_digest,b.source_digest)
      order by a.contribution_id))::text,'sha256'),'hex')
  from public.facilitator_manual_requests r
  left join lateral (select id,recipient_revision from public.facilitator_manual_rebindings
    where request_id=r.id order by sequence desc limit 1) binding on true
  join public.facilitator_manual_allocations a on a.request_id=r.id
  join public.referral_balances b on b.contribution_id=a.contribution_id
  join lateral (select id,source_digest from public.referral_funding_reviews
    where contribution_id=a.contribution_id order by recorded_at desc,id desc limit 1) f on true
  where r.id=p_request group by r.id,r.recipient_revision,binding.id,binding.recipient_revision,r.currency
$$;

create function public.facilitator_manual_status_internal(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; incident boolean; claimed boolean; reported boolean;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if auth.uid() is null or p_request is null then
    raise exception 'FACILITATOR_MANUAL_AUTH: Authentication is required.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  select * into r from public.facilitator_manual_requests where id=p_request;
  if not found or (r.user_id is distinct from auth.uid()
    and coalesce(public.current_platform_role()::text,'') not in ('admin','superadmin','owner')) then
    raise exception 'FACILITATOR_MANUAL_AUTH: Request is not accessible.';
  end if;
  select exists(select 1 from public.facilitator_manual_incidents where request_id=r.id),
    exists(select 1 from public.facilitator_manual_claims where request_id=r.id),
    exists(select 1 from public.facilitator_manual_receipts where request_id=r.id)
    into incident,claimed,reported;
  return jsonb_build_object('request_id',r.id,'amount_minor',r.amount_minor::text,'currency',r.currency,
    'state',case when incident then 'outcome_review_required' else public.facilitator_manual_state(r.id) end,
    'historical_state',public.facilitator_manual_state(r.id),'incident',incident,
    'operator_reported',reported,'external_transfer_verified',false,'do_not_resend',claimed);
end $$;

-- Historical disclosure only; this is not a readiness check or send authority.
create function public.facilitator_manual_claim_snapshot_internal(p_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; c public.facilitator_manual_claims;
  v public.facilitator_recipient_versions;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if auth.uid() is null or p_request is null then
    raise exception 'FACILITATOR_MANUAL_AUTH: Claim snapshot is not accessible.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  if coalesce(public.current_platform_role()::text,'') not in ('admin','superadmin','owner') then
    raise exception 'FACILITATOR_MANUAL_AUTH: Claim snapshot is not accessible.';
  end if;
  select * into c from public.facilitator_manual_claims where request_id=p_request and sender_id=auth.uid();
  if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Claim snapshot is not accessible.'; end if;
  select * into r from public.facilitator_manual_requests where id=c.request_id;
  select * into v from public.facilitator_recipient_versions
    where revision_id=c.recipient_revision and user_id=r.user_id;
  if not found then raise exception 'FACILITATOR_MANUAL_CONFLICT: Claim recipient is inconsistent.'; end if;
  insert into public.facilitator_recipient_audit(actor_id,subject_user_id,revision_id,action)
    values(auth.uid(),r.user_id,v.revision_id,'payout_snapshot');
  return jsonb_build_object('request_id',r.id,'binding_id',c.binding_id,'revision',v.revision_id,
    'expected_name',v.full_name,'phone',v.phone,'historical_only',true,'send_authorized',false);
end $$;

create function public.facilitator_manual_incident_evidence_internal(
  p_incident bigint,p_key uuid,p_reference uuid,p_sha256 text,p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare prior public.facilitator_manual_incident_evidence; result uuid;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if p_incident is null or p_key is null or p_reference is null or p_sha256 is null
    or p_sha256 !~ '^[0-9a-f]{64}$' or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm the investigation evidence.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select * into prior from public.facilitator_manual_incident_evidence where request_key=p_key;
  if found then
    if (prior.incident_id,prior.external_reference,prior.sha256,prior.submitted_by)
      is distinct from (p_incident,p_reference,p_sha256,auth.uid()) then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Investigation evidence retry changed.';
    end if;
    return prior.id;
  end if;
  if not exists(select 1 from public.facilitator_manual_incidents where id=p_incident)
    or exists(select 1 from public.facilitator_manual_incident_reviews where incident_id=p_incident) then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: Incident is unavailable or already reviewed.';
  end if;
  insert into public.facilitator_manual_incident_evidence(incident_id,request_key,external_reference,sha256,submitted_by)
    values(p_incident,p_key,p_reference,p_sha256,auth.uid()) returning id into result;
  return result;
end $$;

create function public.facilitator_manual_sender_current_internal(p_request uuid) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare c public.facilitator_manual_claims; r public.facilitator_manual_requests; result jsonb;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select * into c from public.facilitator_manual_claims where request_id=p_request and sender_id=auth.uid();
  if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Claim is not accessible.'; end if;
  select * into r from public.facilitator_manual_requests where id=c.request_id;
  perform 1 from public.profiles where id=r.user_id for update;
  if public.facilitator_manual_state(p_request)<>'processing'
    or exists(select 1 from public.facilitator_manual_incidents where request_id=p_request)
    or not public.facilitator_manual_lock_recipient(r.user_id,c.recipient_revision) then
    raise exception 'FACILITATOR_MANUAL_HOLD: Current destination is not available; do not resend.';
  end if;
  perform public.facilitator_manual_check_sources(r.user_id,r.currency);
  result:=public.facilitator_manual_claim_snapshot_internal(p_request);
  return result||jsonb_build_object('historical_only',false,'current_recipient_checked',true,
    'send_authorized',true,'do_not_resend',true);
end $$;

create function public.facilitator_manual_incident_review_internal(
  p_incident bigint,p_evidence uuid,p_owner_solo boolean,p_confirmed boolean
) returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare e public.facilitator_manual_incident_evidence; previous public.facilitator_manual_incident_reviews;
  role_name public.platform_role;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payout model is disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  if p_incident is null or p_evidence is null or p_owner_solo is null or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_MANUAL_INPUT: Confirm the incident investigation.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  role_name:=public.require_staff('admin');
  if p_owner_solo and role_name<>'owner' then
    raise exception 'FACILITATOR_MANUAL_AUTH: Only the Owner may review solo.';
  end if;
  select * into e from public.facilitator_manual_incident_evidence
    where id=p_evidence and incident_id=p_incident;
  if not found then raise exception 'FACILITATOR_MANUAL_CONFLICT: Investigation evidence not found.'; end if;
  select * into previous from public.facilitator_manual_incident_reviews where incident_id=p_incident;
  if found then
    if (previous.evidence_id,previous.checked_by,previous.owner_solo)
      is distinct from (p_evidence,auth.uid(),p_owner_solo) then
      raise exception 'FACILITATOR_MANUAL_CONFLICT: Incident already reviewed.';
    end if;
    return true;
  end if;
  if e.submitted_by=auth.uid() and not (p_owner_solo and role_name='owner') then
    raise exception 'FACILITATOR_MANUAL_AUTH: Independent review or Owner solo is required.';
  end if;
  insert into public.facilitator_manual_incident_reviews(incident_id,evidence_id,checked_by,owner_solo)
    values(p_incident,p_evidence,auth.uid(),p_owner_solo);
  return true;
end $$;

create function public.facilitator_manual_action_internal(
  p_request uuid,p_key uuid,p_action text,p_reason text,p_fee bigint,
  p_reference text,p_owner_solo boolean,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.facilitator_manual_requests; c public.facilitator_manual_claims;
  old public.facilitator_manual_events; role_name public.platform_role; reviewer uuid;
  binding public.facilitator_manual_rebindings;
  current_state text; v_evidence text; ref text:=upper(btrim(p_reference));
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
    or (p_action not in ('reviewed','processing') and p_fee is not null)
    or (p_action<>'processing' and p_owner_solo)
    or (p_action in ('reviewed','processing') and (p_fee is null or p_fee not between 0 and 9007199254740991))
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
  select * into c from public.facilitator_manual_claims where request_id=p_request;
  if p_action='paid' then
    if c.request_id is null or c.sender_id is distinct from auth.uid() then
      raise exception 'FACILITATOR_MANUAL_AUTH: Only the claimed sender may report an outcome.';
    end if;
    insert into public.facilitator_manual_reports(request_id,action_key,transaction_reference,actor_id)
      values(p_request,p_key,ref,auth.uid()) on conflict do nothing;
    if exists(select 1 from public.facilitator_manual_receipts
        where request_id=p_request and transaction_reference<>ref)
      or exists(select 1 from public.facilitator_manual_incidents where request_id=p_request)
      or exists(select 1 from public.facilitator_manual_events
        where action_key=p_key and (request_id<>p_request or state<>'paid'
          or transaction_reference is distinct from ref)) then
      insert into public.facilitator_manual_incidents(request_id,action_key,transaction_reference,actor_id)
        values(p_request,p_key,ref,auth.uid()) on conflict do nothing;
      return jsonb_build_object('state',public.facilitator_manual_state(p_request),'conflict',true,
        'message','Conflicting report retained; do not resend.');
    end if;
  end if;
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
  if current_state in ('paid','cancelled') then
    if p_action='paid' and exists(select 1 from public.facilitator_manual_receipts
      where request_id=p_request and transaction_reference=ref and reported_by=auth.uid()) then
      return jsonb_build_object('state','paid','replayed',true);
    end if;
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
    select * into binding from public.facilitator_manual_rebindings
      where request_id=p_request order by sequence desc limit 1;
    if binding.id is not null then
      perform 1 from public.profiles where id=binding.reviewed_by
        and platform_role in ('owner','superadmin') for share;
      if not found then
        raise exception 'FACILITATOR_MANUAL_HOLD: Destination reviewer authority changed.';
      end if;
    end if;
    if not public.facilitator_manual_lock_recipient(r.user_id,coalesce(binding.recipient_revision,r.recipient_revision)) then
      raise exception 'FACILITATOR_MANUAL_HOLD: Recipient changed or is not verified.';
    end if;
    perform public.facilitator_manual_check_sources(r.user_id,r.currency);
    v_evidence:=public.facilitator_manual_evidence_digest(p_request);
    if v_evidence is null then raise exception 'FACILITATOR_MANUAL_HOLD: Source evidence is missing.'; end if;
  end if;
  if p_action='processing' then
    if exists(select 1 from public.facilitator_manual_events h where h.request_id=p_request and h.state='hold')
      and not exists(select 1 from public.facilitator_manual_events e
        where e.request_id=p_request and e.state='reviewed'
          and e.id>(select max(h.id) from public.facilitator_manual_events h
            where h.request_id=p_request and h.state='hold')
          and e.evidence_digest=v_evidence and e.fee_minor=p_fee) then
      raise exception 'FACILITATOR_MANUAL_HOLD: A fresh confirmed review must resolve the hold.';
    end if;
    if p_owner_solo then
      reviewer:=null;
    else
      select e.actor_id into reviewer from public.facilitator_manual_events e
        join public.profiles p on p.id=e.actor_id and p.platform_role in ('admin','superadmin','owner')
        where e.request_id=p_request and e.state='reviewed' and e.actor_id<>auth.uid()
          and e.evidence_digest=v_evidence and e.fee_minor=p_fee
          and e.id>coalesce((select max(h.id) from public.facilitator_manual_events h
            where h.request_id=p_request and h.state='hold'),0)
        order by e.id desc limit 1;
      if reviewer is null then raise exception 'FACILITATOR_MANUAL_AUTH: Another staff reviewer is required.'; end if;
      perform 1 from public.profiles where id=reviewer and platform_role in ('admin','superadmin','owner') for share;
      if not found then raise exception 'FACILITATOR_MANUAL_AUTH: Reviewer authority changed.'; end if;
    end if;
    if exists(select 1 from public.facilitator_manual_incidents i
      where not exists(select 1 from public.facilitator_manual_incident_reviews x where x.incident_id=i.id)) then
      raise exception 'FACILITATOR_MANUAL_HOLD: A duplicate receipt requires review; do not send.';
    end if;
    insert into public.facilitator_manual_claims(
      request_id,recipient_revision,binding_id,sender_id,reviewer_id,owner_solo,fee_minor)
      values(p_request,coalesce(binding.recipient_revision,r.recipient_revision),binding.id,
        auth.uid(),reviewer,p_owner_solo,p_fee);
  elsif p_action='paid' then
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
  insert into public.facilitator_manual_events(request_id,action_key,state,reason,fee_minor,owner_solo,
    transaction_reference,evidence_digest,actor_id)
    values(p_request,p_key,p_action,p_reason,p_fee,case when p_action='processing' then p_owner_solo else null end,
      ref,v_evidence,auth.uid());
  return jsonb_build_object('state',p_action,'operator_reported',p_action='paid');
end $$;

revoke all on function public.facilitator_manual_enabled(),public.facilitator_manual_state(uuid),
  public.facilitator_manual_lock_recipient(uuid,uuid),
  public.facilitator_manual_source_cap(uuid,uuid,text),public.facilitator_manual_check_sources(uuid,text),
  public.facilitator_manual_source_available(uuid,uuid,text),
  public.facilitator_manual_source_quote_internal(uuid,text),
  public.facilitator_manual_evidence_digest(uuid),
  public.facilitator_manual_status_internal(uuid),
  public.facilitator_manual_claim_snapshot_internal(uuid),
  public.facilitator_manual_sender_current_internal(uuid),
  public.facilitator_manual_incident_evidence_internal(bigint,uuid,uuid,text,boolean),
  public.facilitator_manual_incident_review_internal(bigint,uuid,boolean,boolean),
  public.facilitator_manual_reconfirm_internal(uuid,uuid,uuid,uuid,boolean),
  public.facilitator_manual_rebind_internal(uuid,uuid,uuid,uuid,uuid,boolean),
  public.facilitator_manual_request_internal(uuid,uuid,text,bigint,jsonb,boolean),
  public.facilitator_manual_action_internal(uuid,uuid,text,text,bigint,text,boolean,boolean)
  from public,anon,authenticated,service_role;
