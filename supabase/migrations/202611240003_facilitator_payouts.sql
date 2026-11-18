-- Manual inventory evidence only: neither a balance nor an authorization to pay.
-- In particular, an assertion of exclusive custody is not proof of exclusivity.
-- No payout path may consume these records until reconciliation, reservations,
-- reversal handling and cross-rail receipt uniqueness are implemented.
create table public.facilitator_funding_attestations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null unique,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  custody_scope_reference uuid not null,
  period_start timestamptz not null,
  as_of timestamptz not null,
  expires_at timestamptz not null,
  cash_minor bigint not null check (cash_minor between 0 and 9007199254740991),
  unpaid_costs_minor bigint not null check (unpaid_costs_minor between 0 and 9007199254740991),
  holds_minor bigint not null check (holds_minor between 0 and 9007199254740991),
  other_commitments_minor bigint not null check (other_commitments_minor between 0 and 9007199254740991),
  exclusive_platform_funded_asserted boolean not null check (exclusive_platform_funded_asserted),
  evidence_reference uuid not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp(),
  check (period_start < as_of and as_of < expires_at),
  check (expires_at <= as_of + interval '7 days')
);

create table public.facilitator_funding_attestation_checks (
  attestation_id uuid primary key references public.facilitator_funding_attestations(id),
  checked_by uuid not null references public.profiles(id),
  owner_solo boolean not null,
  checked_at timestamptz not null default clock_timestamp()
);

create trigger facilitator_funding_attestations_immutable before update or delete
  on public.facilitator_funding_attestations for each row execute function public.referral_immutable();
create trigger facilitator_funding_attestation_checks_immutable before update or delete
  on public.facilitator_funding_attestation_checks for each row execute function public.referral_immutable();
alter table public.facilitator_funding_attestations enable row level security;
alter table public.facilitator_funding_attestation_checks enable row level security;
revoke all on public.facilitator_funding_attestations, public.facilitator_funding_attestation_checks
  from public, anon, authenticated, service_role;

create function public.facilitator_funding_attestation_create(
  p_key uuid, p_currency text, p_custody_scope_reference uuid,
  p_period_start timestamptz, p_as_of timestamptz, p_expires_at timestamptz,
  p_cash_minor bigint, p_unpaid_costs_minor bigint, p_holds_minor bigint,
  p_other_commitments_minor bigint, p_evidence_reference uuid, p_evidence_sha256 text,
  p_exclusive_platform_funded boolean, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare prior public.facilitator_funding_attestations; result uuid;
begin
  perform public.require_staff('owner');
  if p_key is null or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_custody_scope_reference is null or p_period_start is null or p_as_of is null
    or p_expires_at is null or p_cash_minor is null or p_unpaid_costs_minor is null
    or p_holds_minor is null or p_other_commitments_minor is null
    or least(p_cash_minor,p_unpaid_costs_minor,p_holds_minor,p_other_commitments_minor)<0
    or greatest(p_cash_minor,p_unpaid_costs_minor,p_holds_minor,p_other_commitments_minor)>9007199254740991
    or p_evidence_reference is null or p_evidence_sha256 is null
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or p_exclusive_platform_funded is distinct from true or p_confirmed is distinct from true then
    raise exception 'FACILITATOR_FUNDING: Confirm the manual exclusive platform-funded custody assertion and complete evidence.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  select * into prior from public.facilitator_funding_attestations where request_key=p_key;
  if found then
    if (prior.recorded_by,prior.currency,prior.custody_scope_reference,prior.period_start,prior.as_of,
      prior.expires_at,prior.cash_minor,prior.unpaid_costs_minor,prior.holds_minor,prior.other_commitments_minor,
      prior.evidence_reference,prior.evidence_sha256,prior.exclusive_platform_funded_asserted)
      is distinct from (auth.uid(),p_currency,p_custody_scope_reference,p_period_start,p_as_of,
        p_expires_at,p_cash_minor,p_unpaid_costs_minor,p_holds_minor,p_other_commitments_minor,
        p_evidence_reference,p_evidence_sha256,p_exclusive_platform_funded) then
      raise exception 'FACILITATOR_FUNDING: Attestation retry differs from the original.';
    end if;
    return prior.id;
  end if;
  if p_period_start>=p_as_of or p_as_of>clock_timestamp() or p_expires_at<=clock_timestamp()
    or p_expires_at>p_as_of+interval '7 days' then
    raise exception 'FACILITATOR_FUNDING: The manual inventory period or freshness is invalid.';
  end if;
  insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
    period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
    exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by)
  values(p_key,p_currency,p_custody_scope_reference,p_period_start,p_as_of,p_expires_at,
    p_cash_minor,p_unpaid_costs_minor,p_holds_minor,p_other_commitments_minor,
    p_exclusive_platform_funded,p_evidence_reference,p_evidence_sha256,auth.uid())
  returning id into result;
  return result;
end $$;

create function public.facilitator_funding_attestation_check(
  p_id uuid, p_owner_solo boolean, p_confirmed boolean
) returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare a public.facilitator_funding_attestations; existing public.facilitator_funding_attestation_checks;
begin
  perform public.require_staff('superadmin');
  if p_id is null or p_owner_solo is null or p_confirmed is distinct from true
    or (p_owner_solo and public.current_platform_role() is distinct from 'owner') then
    raise exception 'FACILITATOR_FUNDING: Confirm the manual review and permitted reviewer.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  select * into a from public.facilitator_funding_attestations where id=p_id;
  if not found then raise exception 'FACILITATOR_FUNDING: Attestation not found.'; end if;
  select * into existing from public.facilitator_funding_attestation_checks where attestation_id=p_id;
  if found then
    if existing.checked_by is distinct from auth.uid() or existing.owner_solo is distinct from p_owner_solo then
      raise exception 'FACILITATOR_FUNDING: Review already recorded by another actor.';
    end if;
    return true;
  end if;
  if a.expires_at<=clock_timestamp() then raise exception 'FACILITATOR_FUNDING: Manual inventory is stale.'; end if;
  if a.recorded_by=auth.uid() and not p_owner_solo then
    raise exception 'FACILITATOR_FUNDING: Another leader must review, or the owner must explicitly select solo review.';
  end if;
  insert into public.facilitator_funding_attestation_checks(attestation_id,checked_by,owner_solo)
    values(p_id,auth.uid(),p_owner_solo);
  return true;
end $$;

create function public.facilitator_funding_attestations_list() returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object('manual_assertions_only',true,'payouts_enabled',false,
    'available_minor','0','records',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'currency',a.currency,'custody_scope_reference',a.custody_scope_reference,
      'period_start',a.period_start,'as_of',a.as_of,'expires_at',a.expires_at,
      'cash_minor',a.cash_minor::text,'unpaid_costs_minor',a.unpaid_costs_minor::text,
      'holds_minor',a.holds_minor::text,'other_commitments_minor',a.other_commitments_minor::text,
      'exclusive_platform_funded_asserted',a.exclusive_platform_funded_asserted,
      'evidence_reference',a.evidence_reference,'evidence_sha256',a.evidence_sha256,
      'recorded_by',a.recorded_by,'recorded_at',a.recorded_at,
      'checked_by',c.checked_by,'owner_solo',c.owner_solo,'checked_at',c.checked_at,
      'stale',a.expires_at<=clock_timestamp()) order by a.recorded_at desc,a.id)
    from (select * from public.facilitator_funding_attestations order by recorded_at desc,id limit 100) a
    left join public.facilitator_funding_attestation_checks c on c.attestation_id=a.id),'[]'::jsonb));
end $$;

revoke all on function public.facilitator_funding_attestation_create(uuid,text,uuid,timestamptz,timestamptz,timestamptz,bigint,bigint,bigint,bigint,uuid,text,boolean,boolean),
  public.facilitator_funding_attestation_check(uuid,boolean,boolean),
  public.facilitator_funding_attestations_list() from public,anon,authenticated,service_role;
grant execute on function public.facilitator_funding_attestation_create(uuid,text,uuid,timestamptz,timestamptz,timestamptz,bigint,bigint,bigint,bigint,uuid,text,boolean,boolean),
  public.facilitator_funding_attestation_check(uuid,boolean,boolean),
  public.facilitator_funding_attestations_list() to authenticated;
