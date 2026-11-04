-- Company provider costs never reduce couple entitlement. No payment rows change.
-- Zero preserves the existing no-customer-processing-charge policy on upgrade.
alter table public.platform_policies add column withdrawal_processing_fee_minor bigint not null default 0
  check(withdrawal_processing_fee_minor between 0 and 9007199254740991),
  add column withdrawal_policy_revision bigint not null default 0;
alter table public.simple_payout_requests
  add column processing_fee_minor bigint check(processing_fee_minor between 0 and 9007199254740991),
  add column minimum_payout_minor bigint,
  add column maximum_payout_minor bigint,
  add column policy_revision bigint,
  add column minimum_exception boolean;
alter table public.simple_payout_requests add constraint simple_payout_quote_complete check(
  (processing_fee_minor is null and minimum_payout_minor is null and maximum_payout_minor is null and policy_revision is null and minimum_exception is null)
  or (processing_fee_minor is not null and minimum_payout_minor is not null and maximum_payout_minor is not null and policy_revision is not null
    and minimum_exception is not null and minimum_payout_minor>=0 and maximum_payout_minor>=minimum_payout_minor
    and policy_revision>=0 and amount_minor<=maximum_payout_minor
    and minimum_exception=(amount_minor<minimum_payout_minor)));
alter table public.simple_payout_claims alter column fee_minor drop not null;
create function public.simple_withdrawal_policy_revision() returns trigger
language plpgsql set search_path='' as $$
begin
  new.withdrawal_policy_revision:=old.withdrawal_policy_revision+
    case when (new.withdrawal_processing_fee_minor,new.min_payout_minor,new.max_payout_minor) is distinct from
      (old.withdrawal_processing_fee_minor,old.min_payout_minor,old.max_payout_minor) then 1 else 0 end;
  return new;
end $$;
revoke all on function public.simple_withdrawal_policy_revision() from public,anon,authenticated,service_role;
create trigger simple_withdrawal_policy_revision before update on public.platform_policies
  for each row execute function public.simple_withdrawal_policy_revision();

do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.admin_save_policies(jsonb)'::regprocedure);
  updated:=replace(definition,'select * into current_policy from public.platform_policies',
    'if p_data ? ''withdrawal_processing_fee_minor'' and
      (jsonb_typeof(p_data->''withdrawal_processing_fee_minor'') is distinct from ''number''
      or (p_data->>''withdrawal_processing_fee_minor'') !~ ''^[0-9]+$''
      or (p_data->>''withdrawal_processing_fee_minor'')::numeric>9007199254740991) then
      raise exception ''Withdrawal processing fee must be an exact nonnegative minor-unit amount.''; end if;
    select * into current_policy from public.platform_policies');
  updated:=replace(updated,'update public.platform_policies set',
    'update public.platform_policies set withdrawal_processing_fee_minor =
      coalesce((p_data->>''withdrawal_processing_fee_minor'')::bigint,withdrawal_processing_fee_minor),');
  if updated=definition or position('Withdrawal processing fee must' in updated)=0 then
    raise exception 'Unexpected financial policy predecessor'; end if;
  execute updated;
end $$;

create or replace function public.simple_payout_balance_raw(p_wedding uuid,p_exclude uuid default null,p_old_exclude uuid default null)
returns numeric language sql stable security definer set search_path='' as $$
  select coalesce((select sum(c.net_paid_minor::numeric)
    from public.contributions c join public.weddings w on w.id=c.wedding_id
    where c.wedding_id=p_wedding and c.currency=w.currency and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.payment_status='paid' and c.verified_provider_payment
      and c.provider_name in ('daraja','paystack')
      and (c.funds_available_at is null or c.funds_available_at<=now())),0)
    - coalesce((select sum(s.debit_minor::numeric+s.hold_minor) from public.manual_payout_sources() s
      join public.weddings w on w.id=s.wedding_id where s.wedding_id=p_wedding and s.currency=w.currency),0)
    - coalesce((select sum(r.amount_minor::numeric+r.fee_minor) from public.manual_payout_requests r
      join public.weddings w on w.id=r.wedding_id where r.wedding_id=p_wedding and r.currency=w.currency
      and r.id is distinct from p_old_exclude and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')),0)
    - coalesce((select sum(r.amount_minor::numeric+coalesce(r.processing_fee_minor,c.fee_minor,0))
      from public.simple_payout_requests r left join public.simple_payout_claims c on c.payout_id=r.id
      where r.wedding_id=p_wedding and r.id is distinct from p_exclude and public.simple_payout_state(r.id)<>'cancelled'),0)
$$;

create function public.simple_payout_submit(p_key uuid,p_wedding uuid,p_amount bigint,p_partner integer,p_confirmed boolean,
  p_processing_fee bigint,p_policy_revision bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior public.simple_payout_requests; result uuid; phone text; policy public.platform_policies; available bigint;
begin
  perform public.simple_payout_lock(p_wedding);
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'SIMPLE_PAYOUT: Wedding owner access required.'; end if;
  if p_confirmed is distinct from true or p_key is null or p_partner not in (1,2) or p_partner is null then
    raise exception 'SIMPLE_PAYOUT: Confirm the amount, selected recipient and consent.'; end if;
  select * into prior from public.simple_payout_requests where request_key=p_key;
  if found then
    if (prior.wedding_id,prior.requested_by,prior.amount_minor,prior.partner_slot) is distinct from
      (p_wedding,auth.uid(),p_amount,p_partner)
      or (p_processing_fee is null and p_policy_revision is null and coalesce(prior.processing_fee_minor,0)<>0)
      or ((p_processing_fee is not null or p_policy_revision is not null) and
        (p_processing_fee,p_policy_revision) is distinct from (prior.processing_fee_minor,prior.policy_revision)) then
      raise exception 'SIMPLE_PAYOUT: Request retry changed. Refresh history.'; end if;
    return prior.id;
  end if;
  select * into strict policy from public.platform_policies where id=true for share;
  if (p_processing_fee is null and (p_policy_revision is not null or policy.withdrawal_processing_fee_minor<>0))
    or (p_processing_fee is not null and (p_processing_fee is distinct from policy.withdrawal_processing_fee_minor
      or p_policy_revision is distinct from policy.withdrawal_policy_revision)) then
    raise exception 'SIMPLE_PAYOUT: Withdrawal quote changed. Refresh and explicitly reconfirm amount, processing fee and total debit.'; end if;
  if exists(select 1 from public.simple_payout_deficits where wedding_id=p_wedding) then
    raise exception 'SIMPLE_PAYOUT: A recorded adjustment deficit requires review. Existing claims remain held; do not create or resend a payout.'; end if;
  if not public.kyc_is_complete(p_wedding) then raise exception 'PAYOUT_KYC_REQUIRED: Complete both partners identity details and consent first.'; end if;
  select case when p_partner=1 then partner1_phone else partner2_phone end into phone from public.wedding_kyc where wedding_id=p_wedding;
  if not exists(select 1 from public.weddings where id=p_wedding and currency='KES')
    or regexp_replace(phone,'[^0-9]','','g') !~ '^(254[17][0-9]{8}|0[17][0-9]{8})$' then
    raise exception 'SIMPLE_PAYOUT: This path supports KES to an existing Kenyan partner phone. Ask support for other receiving methods; do not enter bank details here.'; end if;
  available:=public.simple_payout_available(p_wedding);
  if p_amount is null or p_amount<=0 or p_amount>9007199254740991 or p_amount>policy.max_payout_minor then
    raise exception 'SIMPLE_PAYOUT: Enter a positive amount within the configured maximum payout.'; end if;
  if p_amount::numeric+policy.withdrawal_processing_fee_minor>available
    or p_amount::numeric+policy.withdrawal_processing_fee_minor>9007199254740991 then
    raise exception 'SIMPLE_PAYOUT: Amount plus processing fee exceeds available wedding balance.'; end if;
  if p_amount<policy.min_payout_minor and p_amount::numeric+policy.withdrawal_processing_fee_minor<>available then
    raise exception 'SIMPLE_PAYOUT: Below-minimum payouts must drain the full remaining balance including the processing fee.'; end if;
  insert into public.simple_payout_requests(request_key,wedding_id,requested_by,amount_minor,currency,partner_slot,kyc_hash,
    processing_fee_minor,minimum_payout_minor,maximum_payout_minor,policy_revision,minimum_exception)
    values(p_key,p_wedding,auth.uid(),p_amount,'KES',p_partner,public.simple_payout_kyc_hash(p_wedding),
      policy.withdrawal_processing_fee_minor,policy.min_payout_minor,policy.max_payout_minor,policy.withdrawal_policy_revision,p_amount<policy.min_payout_minor)
    returning id into result;
  insert into public.simple_payout_events(payout_id,action_key,state,actor_id) values(result,p_key,'requested',auth.uid());
  return result;
end $$;
revoke all on function public.simple_payout_submit(uuid,uuid,bigint,integer,boolean,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.simple_payout_submit(uuid,uuid,bigint,integer,boolean,bigint,bigint) to authenticated;

-- Old zero-charge clients stay compatible; a nonzero fee requires a fresh quote.
create or replace function public.simple_payout_submit(p_key uuid,p_wedding uuid,p_amount bigint,p_partner integer,p_confirmed boolean)
returns uuid language sql security definer set search_path='' as $$
  select public.simple_payout_submit(p_key,p_wedding,p_amount,p_partner,p_confirmed,null,null)
$$;

do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.simple_payout_action(uuid,uuid,text,text,bigint,text,boolean,boolean,boolean)'::regprocedure);
  updated:=replace(definition,'if r.amount_minor>public.simple_payout_available(r.wedding_id,r.id)',
    'if r.amount_minor::numeric+coalesce(r.processing_fee_minor,0)>public.simple_payout_available(r.wedding_id,r.id)');
  updated:=replace(updated,'if p_fee is null or p_fee<0 or not p_recipient_confirmed',
    'if (r.processing_fee_minor is null and (p_fee is null or p_fee<0))
      or (r.processing_fee_minor is not null and p_fee is not null) or not p_recipient_confirmed');
  updated:=replace(updated,'perform public.manual_payout_check_amount(r.wedding_id,r.currency,r.amount_minor);',
    'if r.processing_fee_minor is null then
      perform public.manual_payout_check_amount(r.wedding_id,r.currency,r.amount_minor);
    end if;');
  updated:=replace(updated,'r.amount_minor::numeric+p_fee>public.simple_payout_available(r.wedding_id,r.id)',
    'r.amount_minor::numeric+coalesce(r.processing_fee_minor,p_fee)>public.simple_payout_available(r.wedding_id,r.id)');
  if updated=definition or position('coalesce(r.processing_fee_minor,p_fee)' in updated)=0 then
    raise exception 'Unexpected simple action predecessor'; end if;
  execute updated;
  definition:=pg_get_functiondef('public.simple_payout_status(uuid)'::regprocedure);
  updated:=replace(definition,'select r.id,r.amount_minor,r.currency',
    'select r.id,r.processing_fee_minor,r.minimum_payout_minor,r.maximum_payout_minor,r.minimum_exception,r.policy_revision,r.amount_minor,r.currency');
  if updated=definition then raise exception 'Unexpected simple status predecessor'; end if;
  execute updated;
  definition:=pg_get_functiondef('public.simple_payout_balance_details(uuid)'::regprocedure);
  updated:=replace(definition,'r.amount_minor::numeric+coalesce(cl.fee_minor,0)',
    'r.amount_minor::numeric+coalesce(r.processing_fee_minor,cl.fee_minor,0)');
  updated:=replace(updated,'greatest(c.net_paid_minor-coalesce(c.provider_fee_minor,0),0)','c.net_paid_minor');
  updated:=replace(updated,'''configured_hold_days'',',
    '''provider_costs_company_overhead'',true,
    ''withdrawal_processing_revenue_minor'',coalesce((select sum(r.processing_fee_minor) from public.simple_payout_requests r
      where r.wedding_id=p_wedding and public.simple_payout_state(r.id)=''paid''),0),
    ''withdrawal_processing_reserved_minor'',coalesce((select sum(r.processing_fee_minor) from public.simple_payout_requests r
      where r.wedding_id=p_wedding and public.simple_payout_state(r.id) not in (''paid'',''cancelled'')),0),
    ''withdrawal_processing_fee_minor'',(select withdrawal_processing_fee_minor from public.platform_policies where id=true),
    ''policy_revision'',(select withdrawal_policy_revision from public.platform_policies where id=true),
    ''max_payout_minor'',(select max_payout_minor from public.platform_policies where id=true),
    ''configured_hold_days'',');
  if updated=definition or position('provider_costs_company_overhead' in updated)=0 then
    raise exception 'Unexpected simple balance detail predecessor'; end if;
  execute updated;
end $$;
