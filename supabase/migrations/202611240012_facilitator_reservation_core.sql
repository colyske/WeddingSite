-- Unexposed reservation foundation. This migration deliberately has no
-- activation mechanism and grants no API role access. Reviewed assertions
-- are not proof of custody: do not expose this core as a payable balance.
create table public.facilitator_reservation_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null,
  user_id uuid not null references public.profiles(id),
  recipient_revision uuid not null references public.facilitator_recipient_versions(revision_id),
  inventory_id uuid not null references public.facilitator_funding_attestations(id),
  custody_scope_reference uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  allocation_digest text not null check (allocation_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,request_key)
);

create table public.facilitator_reservation_allocations (
  request_id uuid not null references public.facilitator_reservation_requests(id),
  contribution_id uuid not null references public.referral_contribution_policy(contribution_id),
  review_id uuid not null references public.referral_funding_reviews(id),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  primary key(request_id,contribution_id)
);
create index facilitator_reservation_allocation_source on public.facilitator_reservation_allocations(contribution_id);
create index facilitator_reservation_scope on public.facilitator_reservation_requests(custody_scope_reference,currency);

create trigger facilitator_reservation_requests_immutable before update or delete
  on public.facilitator_reservation_requests for each row execute function public.referral_immutable();
create trigger facilitator_reservation_allocations_immutable before update or delete
  on public.facilitator_reservation_allocations for each row execute function public.referral_immutable();
alter table public.facilitator_reservation_requests enable row level security;
alter table public.facilitator_reservation_allocations enable row level security;
revoke all on public.facilitator_reservation_requests,public.facilitator_reservation_allocations
  from public,anon,authenticated,service_role;

-- This is intentionally a constant, not a feature flag. Replacing it is not
-- authorized until the custody, ingestion and cross-rail controls are complete.
create function public.facilitator_reservation_core_enabled() returns boolean
language sql immutable set search_path='' as $$ select false $$;
revoke all on function public.facilitator_reservation_core_enabled() from public,anon,authenticated,service_role;

create function public.facilitator_reservation_create_internal(
  p_key uuid,p_user uuid,p_recipient uuid,p_inventory uuid,p_currency text,
  p_amount bigint,p_allocations jsonb
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare
  inventory public.facilitator_funding_attestations;
  prior public.facilitator_reservation_requests;
  entry record;
  review public.referral_funding_reviews;
  contribution public.contributions;
  balance public.referral_balances;
  allocation_digest text;
  total numeric;
  used numeric;
  cap numeric;
  result uuid;
begin
  if not public.facilitator_reservation_core_enabled() then
    raise exception 'FACILITATOR_RESERVATION_DISABLED: Reservation core is not enabled.';
  end if;
  if auth.uid() is null or auth.uid() is distinct from p_user then
    raise exception 'FACILITATOR_RESERVATION_AUTH: Only the facilitator can request their own reservation.';
  end if;
  if p_key is null or p_recipient is null or p_inventory is null or p_currency !~ '^[A-Z]{3}$'
    or p_amount is null or p_amount not between 1 and 9007199254740991
    or jsonb_typeof(p_allocations) is distinct from 'array'
    or jsonb_array_length(p_allocations) not between 1 and 100 then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Invalid request.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_allocations) x
    where jsonb_typeof(x) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(x))<>2
      or coalesce(x->>'review','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(x->>'amount','') !~ '^[1-9][0-9]{0,15}$'
      or (x->>'amount')::numeric>9007199254740991) then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Invalid allocation.';
  end if;
  select sum((x->>'amount')::numeric),
    encode(extensions.digest(jsonb_agg(jsonb_build_array(lower(x->>'review'),x->>'amount')
      order by lower(x->>'review'))::text,'sha256'),'hex')
    into total,allocation_digest from jsonb_array_elements(p_allocations) x;
  if total<>p_amount or (select count(distinct lower(x->>'review')) from jsonb_array_elements(p_allocations) x)
      <>jsonb_array_length(p_allocations) then
    raise exception 'FACILITATOR_RESERVATION_INPUT: Allocation total or uniqueness is invalid.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=p_user for update;
  select * into prior from public.facilitator_reservation_requests where user_id=p_user and request_key=p_key;
  if found then
    if (prior.recipient_revision,prior.inventory_id,prior.currency,prior.amount_minor,prior.allocation_digest)
      is distinct from (p_recipient,p_inventory,p_currency,p_amount,allocation_digest) then
      raise exception 'FACILITATOR_RESERVATION_CONFLICT: This key belongs to a different request.';
    end if;
    return prior.id;
  end if;
  if not public.verified_adjustment_inbox_clear_for_payout() then
    raise exception 'FACILITATOR_RESERVATION_HOLD: Provider observations require review.';
  end if;
  if not public.facilitator_payout_recipient_ready(p_user,p_recipient) then
    raise exception 'FACILITATOR_RESERVATION_HOLD: The current recipient revision is not verified.';
  end if;
  select * into inventory from public.facilitator_funding_attestations where id=p_inventory;
  if not found or inventory.currency is distinct from p_currency or inventory.expires_at<=clock_timestamp()
    or not exists(select 1 from public.facilitator_funding_attestation_checks where attestation_id=inventory.id) then
    raise exception 'FACILITATOR_RESERVATION_HOLD: Current checked inventory is required.';
  end if;
  if exists(
    select 1 from public.facilitator_reservation_allocations a
    join public.facilitator_reservation_requests r on r.id=a.request_id
    join public.referral_funding_reviews f on f.id=a.review_id
    join public.contributions c on c.id=a.contribution_id
    left join public.referral_balances b on b.contribution_id=a.contribution_id
    where r.custody_scope_reference=inventory.custody_scope_reference and r.currency=p_currency
      and (b.contribution_id is null or c.payment_status is distinct from 'paid'
        or c.payment_environment is distinct from 'live'
        or c.verified_provider_payment is distinct from true
        or c.settlement_route is distinct from 'platform_wallet'
        or b.hold_reasons && array['provider_cost_unknown','currency_mismatch','adjustment_review_or_hold',
          'overlapping_or_invalid_adjustments','refund_evidence_missing','not_eligible_verified_live_payment',
          'provable_self_account_link','policy_or_consent_off_at_admission']::text[]
        or encode(extensions.digest(jsonb_build_array(b.source_digest,c.funds_available_at,c.settlement_route)::text,
          'sha256'),'hex') is distinct from a.source_digest
        or (select coalesce(sum(existing.amount_minor::numeric),0) from public.facilitator_reservation_allocations existing
          where existing.contribution_id=a.contribution_id)
          > least(f.estimate_minor::numeric,b.held_estimate_minor::numeric,
            greatest(0::numeric,f.settled_platform_fee_minor::numeric-f.provider_cost_minor-f.losses_minor
              -f.holds_minor-f.other_commitments_minor)))
  ) then
    raise exception 'FACILITATOR_RESERVATION_HOLD: A retained allocation has a source deficit or changed evidence.';
  end if;
  select coalesce(sum(amount_minor::numeric),0) into used from public.facilitator_reservation_requests
    where custody_scope_reference=inventory.custody_scope_reference and currency=p_currency;
  if used+p_amount > greatest(0::numeric,inventory.cash_minor::numeric-inventory.unpaid_costs_minor
    -inventory.holds_minor-inventory.other_commitments_minor) then
    raise exception 'FACILITATOR_RESERVATION_HOLD: Inventory cannot cover all retained reservations.';
  end if;
  insert into public.facilitator_reservation_requests(request_key,user_id,recipient_revision,inventory_id,
    custody_scope_reference,currency,amount_minor,allocation_digest)
    values(p_key,p_user,p_recipient,p_inventory,inventory.custody_scope_reference,p_currency,p_amount,allocation_digest)
    returning id into result;
  for entry in select (x->>'review')::uuid as review_id,(x->>'amount')::bigint as amount
      from jsonb_array_elements(p_allocations) x order by (x->>'review')::uuid loop
    select * into review from public.referral_funding_reviews where id=entry.review_id;
    if not found or review.currency is distinct from p_currency
      or not exists(select 1 from public.referral_funding_review_checks where review_id=review.id) then
      raise exception 'FACILITATOR_RESERVATION_HOLD: Checked source review is required.';
    end if;
    select * into contribution from public.contributions where id=review.contribution_id for update;
    select * into balance from public.referral_balances where contribution_id=review.contribution_id;
    if contribution.id is null or balance.contribution_id is null
      or not exists(select 1 from public.referral_contribution_policy p join public.referral_attributions a
        on a.wedding_id=p.wedding_id where p.contribution_id=review.contribution_id
        and a.referrer_id=p_user and a.eligible and p.rate_basis_points>0)
      or contribution.payment_environment is distinct from 'live'
      or contribution.payment_status is distinct from 'paid'
      or contribution.verified_provider_payment is distinct from true
      or contribution.settlement_route is distinct from 'platform_wallet'
      or contribution.provider_fee_pending is distinct from false
      or contribution.funds_available_at is null or contribution.funds_available_at>clock_timestamp()
      or balance.hold_reasons && array['provider_cost_unknown','currency_mismatch','adjustment_review_or_hold',
        'overlapping_or_invalid_adjustments','refund_evidence_missing','not_eligible_verified_live_payment',
        'provable_self_account_link','policy_or_consent_off_at_admission']::text[]
      or encode(extensions.digest(jsonb_build_array(balance.source_digest,contribution.funds_available_at,
        contribution.settlement_route)::text,'sha256'),'hex') is distinct from review.source_digest then
      raise exception 'FACILITATOR_RESERVATION_HOLD: Source evidence changed or is not eligible.';
    end if;
    cap:=least(review.estimate_minor::numeric,balance.held_estimate_minor::numeric,
      greatest(0::numeric,review.settled_platform_fee_minor::numeric-review.provider_cost_minor
        -review.losses_minor-review.holds_minor-review.other_commitments_minor));
    select coalesce(sum(amount_minor::numeric),0) into used from public.facilitator_reservation_allocations
      where contribution_id=review.contribution_id;
    if used+entry.amount>cap then
      raise exception 'FACILITATOR_RESERVATION_HOLD: Source cannot cover all retained allocations.';
    end if;
    insert into public.facilitator_reservation_allocations(request_id,contribution_id,review_id,source_digest,amount_minor)
      values(result,review.contribution_id,review.id,review.source_digest,entry.amount);
  end loop;
  return result;
end $$;
revoke all on function public.facilitator_reservation_create_internal(uuid,uuid,uuid,uuid,text,bigint,jsonb)
  from public,anon,authenticated,service_role;
