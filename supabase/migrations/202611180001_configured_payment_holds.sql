-- Forward-only: stored payment dates, fees, policies and payout gates are untouched.
do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.record_verified_payment(text,text,uuid,bigint,text,text,bigint,timestamptz)'::regprocedure);
  updated:=replace(definition,
    'select greatest(payout_hold_days, case when p_provider in (''paystack'', ''daraja'') then 3 else 0 end)
    into hold_days from public.platform_policies where id;',
    'select payout_hold_days into strict hold_days from public.platform_policies where id=true;');
  updated:=replace(updated,'make_interval(days => coalesce(hold_days, 3))','make_interval(days => hold_days)');
  if updated=definition or position('greatest(payout_hold_days' in updated)>0
    or position('select payout_hold_days into strict hold_days' in updated)=0 then
    raise exception 'Unexpected verified-payment hold predecessor'; end if;
  execute updated;
end $$;

create function public.simple_payout_balance_details(p_wedding uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'fee_pending_minor',coalesce(sum(c.net_paid_minor) filter(where c.provider_fee_pending
      or c.provider_fee_minor is null or c.provider_fee_minor<0 or c.provider_fee_minor>c.net_paid_minor),0),
    'time_held_minor',coalesce(sum(greatest(c.net_paid_minor-coalesce(c.provider_fee_minor,0),0))
      filter(where c.funds_available_at>now()),0),
    'next_time_release_at',min(c.funds_available_at) filter(where c.funds_available_at>now()),
    'obligations_minor',coalesce((select sum(s.debit_minor::numeric+s.hold_minor)
      from public.manual_payout_sources() s join public.weddings w on w.id=s.wedding_id
      where s.wedding_id=p_wedding and s.currency=w.currency),0),
    'payout_committed_minor',
      coalesce((select sum(r.amount_minor::numeric+r.fee_minor) from public.manual_payout_requests r
        join public.weddings w on w.id=r.wedding_id where r.wedding_id=p_wedding and r.currency=w.currency
        and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')),0)
      +coalesce((select sum(r.amount_minor::numeric+coalesce(cl.fee_minor,0)) from public.simple_payout_requests r
        left join public.simple_payout_claims cl on cl.payout_id=r.id where r.wedding_id=p_wedding
        and public.simple_payout_state(r.id)<>'cancelled'),0),
    'configured_hold_days',(select payout_hold_days from public.platform_policies where id=true),
    'min_payout_minor',(select min_payout_minor from public.platform_policies where id=true))
  from public.contributions c join public.weddings w on w.id=c.wedding_id
  where c.wedding_id=p_wedding and c.currency=w.currency and c.payment_environment='live'
    and c.settlement_route='platform_wallet' and c.payment_status='paid'
    and c.verified_provider_payment and c.provider_name in ('daraja','paystack')
$$;
revoke all on function public.simple_payout_balance_details(uuid) from public,anon,authenticated,service_role;

do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.simple_payout_status(uuid)'::regprocedure);
  updated:=replace(definition,'return result;','return result||public.simple_payout_balance_details(p_wedding);');
  if updated=definition then raise exception 'Unexpected simple status predecessor'; end if;
  execute updated;
end $$;
