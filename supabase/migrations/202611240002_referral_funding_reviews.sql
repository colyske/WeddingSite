-- Evidence-bound review records only. These records do not establish spendable
-- cash, change historical estimates, reserve funds, or authorize transfers.
create table public.referral_funding_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  contribution_id uuid not null references public.referral_contribution_policy(contribution_id),
  source_digest text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  estimate_minor bigint not null check (estimate_minor > 0),
  platform_fee_minor bigint not null check (platform_fee_minor > 0),
  settled_platform_fee_minor bigint not null check (settled_platform_fee_minor >= 0),
  provider_cost_minor bigint not null check (provider_cost_minor >= 0),
  losses_minor bigint not null check (losses_minor >= 0),
  holds_minor bigint not null check (holds_minor >= 0),
  other_commitments_minor bigint not null check (other_commitments_minor >= 0),
  evidence_reference uuid not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp(),
  check (settled_platform_fee_minor <= platform_fee_minor)
);
create table public.referral_funding_review_checks (
  id bigint generated always as identity primary key,
  review_id uuid not null unique references public.referral_funding_reviews(id),
  checked_by uuid not null references public.profiles(id),
  owner_solo boolean not null,
  checked_at timestamptz not null default clock_timestamp()
);
create trigger referral_funding_reviews_immutable before update or delete on public.referral_funding_reviews
  for each row execute function public.referral_immutable();
create trigger referral_funding_checks_immutable before update or delete on public.referral_funding_review_checks
  for each row execute function public.referral_immutable();
alter table public.referral_funding_reviews enable row level security;
alter table public.referral_funding_review_checks enable row level security;
revoke all on public.referral_funding_reviews, public.referral_funding_review_checks
  from public, anon, authenticated, service_role;

create function public.referral_funding_review_create(
  p_contribution uuid, p_settled bigint, p_cost bigint, p_losses bigint,
  p_holds bigint, p_commitments bigint, p_reference uuid, p_sha256 text,
  p_confirmed boolean
) returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
declare c public.contributions; b public.referral_balances; result uuid;
begin
  perform public.require_staff('owner');
  if p_confirmed is distinct from true or p_contribution is null or p_reference is null
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_settled is null or p_cost is null or p_losses is null
    or p_holds is null or p_commitments is null
    or least(p_settled,p_cost,p_losses,p_holds,p_commitments)<0 then
    raise exception 'REFERRAL_FUNDING: Confirm all evidence and nonnegative amounts.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  select * into c from public.contributions where id=p_contribution for update;
  if not found then raise exception 'REFERRAL_FUNDING: Contribution not found.'; end if;
  perform public.referral_reconcile_estimate(p_contribution);
  select * into b from public.referral_balances where contribution_id=p_contribution;
  if not found or b.held_estimate_minor<=0 or c.payment_environment is distinct from 'live'
    or c.verified_provider_payment is distinct from true or c.payment_status is distinct from 'paid'
    or c.platform_fee_minor is null or c.platform_fee_minor<=0
    or c.currency is distinct from b.currency
    or c.funds_available_at is null or c.funds_available_at>clock_timestamp()
    or p_settled>c.platform_fee_minor or p_cost<c.provider_fee_minor
    or b.hold_reasons && array['provider_cost_unknown','currency_mismatch','adjustment_review_or_hold',
      'overlapping_or_invalid_adjustments','refund_evidence_missing','not_eligible_verified_live_payment',
      'provable_self_account_link','policy_or_consent_off_at_admission']::text[] then
    raise exception 'REFERRAL_FUNDING: This contribution is not eligible for funding review.';
  end if;
  insert into public.referral_funding_reviews(contribution_id,source_digest,currency,estimate_minor,
    platform_fee_minor,settled_platform_fee_minor,provider_cost_minor,losses_minor,holds_minor,
    other_commitments_minor,evidence_reference,evidence_sha256,recorded_by)
  values(c.id,encode(extensions.digest(jsonb_build_array(b.source_digest,c.funds_available_at,c.settlement_route)::text,'sha256'),'hex'),
    b.currency,b.held_estimate_minor,c.platform_fee_minor,p_settled,p_cost,
    p_losses,p_holds,p_commitments,p_reference,p_sha256,auth.uid()) returning id into result;
  return result;
end $$;

create function public.referral_funding_review_check(p_id uuid,p_owner_solo boolean,p_confirmed boolean)
returns boolean language plpgsql security definer set search_path='' set row_security=off as $$
declare r public.referral_funding_reviews; b public.referral_balances; c public.contributions;
begin
  perform public.require_staff('superadmin');
  if p_confirmed is distinct from true or p_owner_solo is null
    or (p_owner_solo and public.current_platform_role()<>'owner') then
    raise exception 'REFERRAL_FUNDING: Confirm the evidence review and permitted reviewer.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  select * into r from public.referral_funding_reviews where id=p_id;
  if not found then raise exception 'REFERRAL_FUNDING: Review not found.'; end if;
  select * into c from public.contributions where id=r.contribution_id for update;
  perform public.referral_reconcile_estimate(r.contribution_id);
  select * into b from public.referral_balances where contribution_id=r.contribution_id;
  if encode(extensions.digest(jsonb_build_array(b.source_digest,c.funds_available_at,c.settlement_route)::text,'sha256'),'hex')
    is distinct from r.source_digest or c.funds_available_at is null or c.funds_available_at>clock_timestamp() then
    raise exception 'REFERRAL_FUNDING: Source changed. Create a fresh evidence review.';
  end if;
  if r.recorded_by=auth.uid() and not p_owner_solo then
    raise exception 'REFERRAL_FUNDING: Another leader must check the evidence or the Owner must explicitly select solo review.';
  end if;
  insert into public.referral_funding_review_checks(review_id,checked_by,owner_solo)
    values(p_id,auth.uid(),p_owner_solo) on conflict(review_id) do nothing;
  if not exists(select 1 from public.referral_funding_review_checks
    where review_id=p_id and checked_by=auth.uid() and owner_solo=p_owner_solo) then
    raise exception 'REFERRAL_FUNDING: This review was already checked by another actor.';
  end if;
  return true;
end $$;

create function public.referral_funding_reviews_list() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  return coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object(
      'estimate_minor',x.estimate_minor::text,'platform_fee_minor',x.platform_fee_minor::text,
      'settled_platform_fee_minor',x.settled_platform_fee_minor::text,'provider_cost_minor',x.provider_cost_minor::text,
      'losses_minor',x.losses_minor::text,'holds_minor',x.holds_minor::text,
      'other_commitments_minor',x.other_commitments_minor::text) order by x.recorded_at desc) from (
    select r.*, ch.checked_by, ch.owner_solo, ch.checked_at,
      (encode(extensions.digest(jsonb_build_array(b.source_digest,c.funds_available_at,c.settlement_route)::text,'sha256'),'hex')
        is distinct from r.source_digest or c.funds_available_at is null or c.funds_available_at>clock_timestamp()) as source_changed
    from public.referral_funding_reviews r
    left join public.referral_funding_review_checks ch on ch.review_id=r.id
    left join public.referral_balances b on b.contribution_id=r.contribution_id
    left join public.contributions c on c.id=r.contribution_id
    order by r.recorded_at desc limit 100
  ) x),'[]'::jsonb);
end $$;

revoke all on function public.referral_funding_review_create(uuid,bigint,bigint,bigint,bigint,bigint,uuid,text,boolean),
  public.referral_funding_review_check(uuid,boolean,boolean),public.referral_funding_reviews_list()
  from public,anon,authenticated,service_role;
grant execute on function public.referral_funding_review_create(uuid,bigint,bigint,bigint,bigint,bigint,uuid,text,boolean),
  public.referral_funding_review_check(uuid,boolean,boolean),public.referral_funding_reviews_list() to authenticated;
