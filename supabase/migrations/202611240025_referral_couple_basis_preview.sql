-- Informational only: historical estimates, obligations and couple funds are unchanged.
alter function public.referral_my_summary() rename to referral_my_summary_legacy;
revoke all on function public.referral_my_summary_legacy()
  from public,anon,authenticated,service_role;

create function public.referral_my_summary() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
declare legacy jsonb; preview jsonb;
begin
  legacy:=public.referral_my_summary_legacy();

  with referred as (
    select a.wedding_id,w.currency,a.eligible,
      (exists(select 1 from public.referral_eligibility_events e where e.wedding_id=a.wedding_id)
        or w.client_owner_id is not distinct from a.referrer_id
        or exists(select 1 from public.wedding_memberships m
          where m.wedding_id=a.wedding_id and m.user_id=a.referrer_id and m.role='client')) as excluded
    from public.referral_attributions a
    join public.weddings w on w.id=a.wedding_id
    where a.referrer_id=auth.uid()
  ), eligible_contributions as (
    select c.id,c.wedding_id,c.net_paid_minor,p.rate_basis_points
    from referred r
    join public.referral_contribution_policy p on p.wedding_id=r.wedding_id
    join public.contributions c on c.id=p.contribution_id and c.wedding_id=r.wedding_id
    where r.eligible and not r.excluded and p.rate_basis_points>0
      and c.currency=r.currency and p.currency=c.currency
      and c.payment_environment='live' and c.settlement_route='platform_wallet'
      and c.payment_status='paid' and c.verified_provider_payment
      and c.provider_name in ('daraja','paystack')
      and (c.funds_available_at is null or c.funds_available_at<=now())
  ), adjustment_totals as (
    select a.contribution_id,sum(s.debit_minor::numeric+s.hold_minor) as deductions
    from public.manual_payout_sources() s
    join public.payment_adjustments a on a.id=s.id and s.kind='adjustment'
    join eligible_contributions c on c.id=a.contribution_id and c.wedding_id=s.wedding_id
    join referred r on r.wedding_id=c.wedding_id and r.currency=s.currency
    group by a.contribution_id
  ), bases as (
    select c.wedding_id,c.rate_basis_points,
      greatest(c.net_paid_minor::numeric-coalesce(a.deductions,0),0) as basis
    from eligible_contributions c left join adjustment_totals a on a.contribution_id=c.id
  ), totals as (
    select wedding_id,sum(basis) as basis,
      sum(floor(basis*rate_basis_points/10000)) as estimate
    from bases group by wedding_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'reference',r.wedding_id,'currency',r.currency,'eligible',r.eligible,
    'excluded_by_account_link',r.excluded,
    'basis_minor',coalesce(t.basis,0)::text,
    'estimate_minor',coalesce(t.estimate,0)::text
  ) order by r.wedding_id),'[]'::jsonb) into preview
  from referred r left join totals t on t.wedding_id=r.wedding_id;

  return legacy||jsonb_build_object('couple_basis_estimates',preview);
end $$;
revoke all on function public.referral_my_summary() from public,anon,authenticated,service_role;
grant execute on function public.referral_my_summary() to authenticated;
