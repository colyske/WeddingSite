-- Synthetic outcome journal only. No observation proves a transfer or releases funds.
create table public.facilitator_shadow_observations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null references public.facilitator_shadow_claims(request_id),
  action_key uuid not null,
  payload_digest text not null check(payload_digest ~ '^[0-9a-f]{64}$'),
  provider text not null check(provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  transaction_reference text not null check(transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  actual_minor bigint not null check(actual_minor between 1 and 9007199254740991),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz not null,
  actor_id uuid not null references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(action_key,payload_digest)
);
create index facilitator_shadow_observation_reference
  on public.facilitator_shadow_observations(provider,transaction_reference);
create table public.facilitator_shadow_observation_incidents (
  observation_id uuid not null references public.facilitator_shadow_observations(id),
  reason text not null check(reason in ('changed_retry','request_mismatch','duplicate_reference','multiple_observations')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(observation_id,reason)
);
do $$ declare t text; begin
  foreach t in array array['facilitator_shadow_observations','facilitator_shadow_observation_incidents'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger immutable before update or delete on public.%I
      for each row execute function public.referral_immutable()',t);
  end loop;
end $$;

create function public.facilitator_shadow_observe_internal(
  p_request uuid,p_key uuid,p_provider text,p_reference text,p_actual bigint,p_currency text,
  p_observed_at timestamptz,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare claim public.facilitator_shadow_claims; r public.facilitator_reservation_requests;
  digest text; normalized text; observation uuid;
  changed_retry boolean; request_mismatch boolean; duplicate_reference boolean; multiple_observations boolean;
begin
  if not public.facilitator_shadow_claim_enabled() or not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_SHADOW_DISABLED: Shadow observations are disabled.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_SHADOW_CONFLICT: READ COMMITTED is required.';
  end if;
  normalized:=upper(btrim(p_reference));
  if auth.uid() is null or p_request is null or p_key is null or p_provider is null
    or p_provider !~ '^[a-z][a-z0-9_-]{1,39}$' or normalized is null
    or normalized !~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'
    or p_actual is null or p_actual not between 1 and 9007199254740991
    or p_currency is null or p_currency !~ '^[A-Z]{3}$' or p_observed_at is null
    or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_SHADOW_INPUT: Confirm complete synthetic observation fields.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select * into claim from public.facilitator_shadow_claims where request_id=p_request;
  if not found or claim.sender_id is distinct from auth.uid() then
    raise exception 'FACILITATOR_SHADOW_AUTH: Only the claimed sender may report an observation.';
  end if;
  select * into strict r from public.facilitator_reservation_requests where id=p_request;
  digest:=encode(extensions.digest(jsonb_build_array(p_request,p_provider,normalized,p_actual,p_currency,
    p_observed_at,auth.uid())::text,'sha256'),'hex');
  select id into observation from public.facilitator_shadow_observations
    where action_key=p_key and payload_digest=digest;
  if found then
    return jsonb_build_object('observation_id',observation,'status','observed',
      'incident',exists(select 1 from public.facilitator_shadow_observation_incidents where observation_id=observation),
      'replayed',true);
  end if;
  changed_retry:=exists(select 1 from public.facilitator_shadow_observations where action_key=p_key);
  request_mismatch:=p_actual is distinct from r.amount_minor or p_currency is distinct from r.currency
    or p_observed_at<claim.claimed_at or p_observed_at>clock_timestamp();
  duplicate_reference:=exists(select 1 from public.facilitator_shadow_observations
      where provider=p_provider and transaction_reference=normalized)
    or exists(select 1 from public.simple_payout_receipts where provider=p_provider and transaction_reference=normalized)
    or exists(select 1 from public.manual_payout_receipts where provider=p_provider and transaction_reference=normalized)
    or (p_provider='daraja' and exists(select 1 from public.b2c_callback_events
      where kind='result' and evidence->>'result_code'='0' and upper(evidence->>'transaction_id')=normalized));
  multiple_observations:=exists(select 1 from public.facilitator_shadow_observations where request_id=p_request);
  insert into public.facilitator_shadow_observations(request_id,action_key,payload_digest,provider,
    transaction_reference,actual_minor,currency,observed_at,actor_id)
    values(p_request,p_key,digest,p_provider,normalized,p_actual,p_currency,p_observed_at,auth.uid())
    returning id into observation;
  insert into public.facilitator_shadow_observation_incidents(observation_id,reason)
    select observation,x.reason from (values
      ('changed_retry',changed_retry),('request_mismatch',request_mismatch),
      ('duplicate_reference',duplicate_reference),('multiple_observations',multiple_observations)
    ) x(reason,applies) where x.applies;
  return jsonb_build_object('observation_id',observation,'status','observed',
    'incident',changed_retry or request_mismatch or duplicate_reference or multiple_observations,'replayed',false);
end $$;
revoke all on function public.facilitator_shadow_observe_internal(uuid,uuid,text,text,bigint,text,timestamptz,boolean)
  from public,anon,authenticated,service_role;
