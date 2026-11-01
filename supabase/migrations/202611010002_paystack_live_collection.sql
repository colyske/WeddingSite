-- Additive live Paystack admission. No activation, credential, or provider writes.
create table public.paystack_live_policy (
  singleton boolean primary key default true check (singleton),
  approved boolean not null default false,
  standard_enabled boolean not null default false,
  settlement_mode text not null default 'standard' check (settlement_mode in ('standard','split')),
  -- No usable beneficiary statement contract has been established in this build.
  split_contract_ready boolean not null default false constraint paystack_split_contract_unverified check (not split_contract_ready),
  split_enabled boolean not null default false,
  publication_enabled boolean not null default false,
  merchant_id text,
  credential_fingerprint text,
  fee_bearer text not null default 'subaccount' check (fee_bearer in ('account','subaccount')),
  capabilities jsonb not null default '[]' check (jsonb_typeof(capabilities) = 'array'),
  revision uuid not null default extensions.gen_random_uuid(),
  approved_by uuid,
  approved_at timestamptz,
  check (not approved or (merchant_id ~ '^[1-9][0-9]{0,15}$'
    and credential_fingerprint ~ '^[a-f0-9]{64}$' and approved_by is not null and approved_at is not null))
);
insert into public.paystack_live_policy(singleton) values(true);
alter table public.paystack_live_policy enable row level security;
revoke all on public.paystack_live_policy from public, anon, authenticated;
grant select on public.paystack_live_policy to service_role;

create table public.paystack_destinations (
  wedding_id uuid primary key references public.weddings(id),
  revision uuid not null default extensions.gen_random_uuid(),
  subaccount_code text not null check (subaccount_code ~ '^ACCT_[A-Za-z0-9]+$'),
  subaccount_id text not null check (subaccount_id ~ '^[1-9][0-9]*$'),
  merchant_id text not null,
  environment text not null check (environment = 'live'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  destination_fingerprint text not null check (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz not null,
  verified_by uuid not null,
  consent_at timestamptz,
  consent_by uuid,
  unique(merchant_id, environment, subaccount_code)
);
alter table public.paystack_destinations enable row level security;
revoke all on public.paystack_destinations from public, anon, authenticated;
grant select on public.paystack_destinations to service_role;

alter table public.contributions
  add column paystack_context jsonb,
  add column settlement_route text not null default 'platform_wallet'
    check (settlement_route in ('platform_wallet','paystack_direct'));

create table public.paystack_payment_evidence (
  contribution_id uuid primary key references public.contributions(id) on delete restrict,
  provider_event_id text not null,
  provider_reference text not null unique,
  provider_payment_reference text not null unique,
  amount_minor bigint not null,
  currency text not null,
  provider_fee_minor bigint not null,
  couple_minor bigint not null check (couple_minor >= 0),
  platform_minor bigint not null check (platform_minor >= 0),
  verified_at timestamptz not null default now(),
  check (couple_minor + platform_minor + provider_fee_minor = amount_minor)
);
alter table public.paystack_payment_evidence enable row level security;
revoke all on public.paystack_payment_evidence from public, anon, authenticated;
grant select on public.paystack_payment_evidence to service_role;
create trigger paystack_payment_evidence_immutable before update or delete on public.paystack_payment_evidence
  for each row execute function public.prevent_financial_adjustment_ledger_mutation();

-- Same existing two-decimal accounting boundary as currencies.js / amount-presets SQL, not a provider-country restriction.
create function public.paystack_accounting_currency_supported(p_currency text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_currency = any(string_to_array(
    'AED,AMD,ANG,AOA,ARS,AUD,AWG,AZN,BAM,BBD,BDT,BGN,BMD,BND,BOB,BRL,BSD,BTN,BWP,BYN,BZD,CAD,CDF,CHF,CNY,COP,CRC,CUC,CUP,CVE,CZK,DKK,DOP,DZD,EGP,ERN,ETB,EUR,FJD,FKP,GBP,GEL,GHS,GIP,GMD,GTQ,GYD,HKD,HNL,HRK,HTG,HUF,IDR,ILS,INR,JMD,KES,KGS,KHR,KYD,KZT,LKR,LRD,LSL,MAD,MDL,MKD,MNT,MOP,MRU,MUR,MVR,MWK,MXN,MYR,MZN,NAD,NGN,NIO,NOK,NPR,NZD,PAB,PEN,PGK,PHP,PKR,PLN,QAR,RON,RUB,SAR,SBD,SCR,SDG,SEK,SGD,SHP,SLE,SRD,SSP,STN,SVC,SZL,THB,TJS,TMT,TOP,TRY,TTD,TWD,TZS,UAH,USD,UYU,UZS,VES,WST,XCD,XCG,XDR,XSU,ZAR,ZMW,ZWG,ZWL',',')),false)
$$;

create function public.owner_set_paystack_policy(p_approved boolean, p_merchant_id text,
  p_credential_fingerprint text, p_capabilities jsonb, p_split_enabled boolean,
  p_publication_enabled boolean, p_fee_bearer text, p_confirmed boolean,
  p_standard_enabled boolean, p_expected_revision uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_staff('owner');
  if p_approved is null or not coalesce(p_confirmed,false) then raise exception 'Confirm the Paystack policy change.'; end if;
  perform 1 from public.paystack_live_policy where singleton for update;
  if not exists(select 1 from public.paystack_live_policy where revision=p_expected_revision) then
    raise exception 'Paystack policy changed. Reload before saving.';
  end if;
  if p_approved and (p_merchant_id is null or p_merchant_id !~ '^[1-9][0-9]{0,15}$'
    or p_credential_fingerprint is null or p_credential_fingerprint !~ '^[a-f0-9]{64}$'
    or p_capabilities is null or jsonb_typeof(p_capabilities) <> 'array'
    or jsonb_array_length(p_capabilities) not between 1 and 30
    or exists(select 1 from jsonb_array_elements(p_capabilities) pair
      where jsonb_typeof(pair) <> 'object' or coalesce(pair->>'market','') !~ '^[A-Z]{2}$'
        or not public.paystack_accounting_currency_supported(pair->>'currency')
        or exists(select 1 from jsonb_object_keys(pair) k where k not in ('market','currency')))
    or p_fee_bearer is null or p_fee_bearer not in ('account','subaccount')
    or p_split_enabled is null or p_publication_enabled is null or p_standard_enabled is null) then
    raise exception 'Confirm account-specific Paystack market/currency, approved collection scopes and fee bearer.';
  end if;
  update public.paystack_live_policy set approved=p_approved,
    standard_enabled=p_approved and coalesce(p_standard_enabled,false),
    split_enabled=p_approved and coalesce(p_split_enabled,false),
    publication_enabled=p_approved and coalesce(p_publication_enabled,false),
    merchant_id=case when p_approved then p_merchant_id end,
    credential_fingerprint=case when p_approved then p_credential_fingerprint end,
    capabilities=case when p_approved then p_capabilities else '[]'::jsonb end,
    fee_bearer=coalesce(p_fee_bearer,fee_bearer), revision=extensions.gen_random_uuid(),
    approved_by=case when p_approved then auth.uid() end,
    approved_at=case when p_approved then now() end where singleton;
  insert into public.audit_events(actor_id,source,action,table_name,record_id,changed_fields)
    values(auth.uid(),'user','paystack_policy_change','paystack_live_policy','singleton',
      array['approved','capabilities','fee_bearer','standard_enabled','split_enabled','publication_enabled','revision']);
  return true;
end $$;

create function public.owner_set_paystack_settlement_mode(p_mode text,p_revision uuid,p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare pp public.paystack_live_policy;
begin
  perform public.require_staff('owner');
  select * into pp from public.paystack_live_policy where singleton for update;
  if not coalesce(p_confirmed,false) or p_mode is null or p_mode not in ('standard','split')
    or p_revision is distinct from pp.revision then raise exception 'Confirm the current Paystack settlement mode; reload if changed.'; end if;
  if p_mode='split' and (not pp.approved or not pp.split_enabled or not pp.split_contract_ready) then
    raise exception 'Split settlement is unavailable until the provider allocation and statement contract is verified.';
  end if;
  update public.paystack_live_policy set settlement_mode=p_mode,revision=extensions.gen_random_uuid() where singleton;
  insert into public.audit_events(actor_id,source,action,table_name,record_id,changed_fields)
    values(auth.uid(),'user','paystack_mode_'||pp.settlement_mode||'_to_'||p_mode,
      'paystack_live_policy','singleton',array['settlement_mode']);
  return true;
end $$;

create function public.owner_verify_paystack_destination(p_wedding_id uuid, p_data jsonb, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare pp public.paystack_live_policy; w public.weddings;
begin
  perform public.require_staff('owner');
  if not coalesce(p_confirmed,false) then raise exception 'Confirm the verified destination.'; end if;
  select * into pp from public.paystack_live_policy where singleton for share;
  select * into w from public.weddings where id=p_wedding_id for share;
  if not found or not pp.approved or not pp.split_enabled or
    p_data->>'environment' is distinct from 'live' or p_data->>'merchant_id' is distinct from pp.merchant_id
    or p_data->>'credential_fingerprint' is distinct from pp.credential_fingerprint
    or p_data->>'currency' is distinct from w.currency
    or not exists(select 1 from jsonb_array_elements(pp.capabilities) pair where pair->>'currency'=w.currency) then
    raise exception 'Destination does not match the approved merchant and wedding currency.';
  end if;
  insert into public.paystack_destinations(wedding_id,subaccount_code,subaccount_id,merchant_id,environment,
    currency,credential_fingerprint,destination_fingerprint,verified_at,verified_by)
  values(w.id,p_data->>'subaccount_code',p_data->>'subaccount_id',pp.merchant_id,'live',w.currency,
    pp.credential_fingerprint,p_data->>'destination_fingerprint',now(),auth.uid())
  on conflict(wedding_id) do update set subaccount_code=excluded.subaccount_code,subaccount_id=excluded.subaccount_id,
    merchant_id=excluded.merchant_id,environment=excluded.environment,currency=excluded.currency,
    credential_fingerprint=excluded.credential_fingerprint,destination_fingerprint=excluded.destination_fingerprint,
    revision=extensions.gen_random_uuid(),verified_at=now(),verified_by=auth.uid(),consent_at=null,consent_by=null;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    values(w.id,auth.uid(),'user','paystack_destination_verified','paystack_destinations',w.id::text);
  return true;
end $$;

create function public.paystack_destination_status(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.paystack_destinations;
begin
  if auth.uid() is null or not (exists(select 1 from public.weddings
    where id=p_wedding_id and client_owner_id=auth.uid()) or public.current_platform_role() in ('owner','superadmin')) then
    raise exception 'Access denied.';
  end if;
  select * into d from public.paystack_destinations where wedding_id=p_wedding_id;
  return jsonb_build_object('verified',d.verified_at is not null,'consented',d.consent_at is not null,
    'revision',d.revision,'currency',d.currency,'kycComplete',public.kyc_is_complete(p_wedding_id),
    'settlementMode',(select settlement_mode from public.paystack_live_policy where singleton),
    'message','Paystack verifies the payout destination separately from required-details-and-consent KYC. Direct settlements cannot be withdrawn again from WeddingSite.');
end $$;

create function public.consent_paystack_destination(p_wedding_id uuid,p_revision uuid,p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding_id and client_owner_id=auth.uid()) then
    raise exception 'Only the wedding owner may consent to its Paystack destination.';
  end if;
  if not coalesce(p_confirmed,false) or not public.kyc_is_complete(p_wedding_id) then
    raise exception 'Complete required partner details and consent before direct settlement.';
  end if;
  update public.paystack_destinations set consent_at=now(),consent_by=auth.uid()
    where wedding_id=p_wedding_id and revision=p_revision;
  if not found then raise exception 'Destination changed. Reload and consent to the verified destination.'; end if;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    values(p_wedding_id,auth.uid(),'user','paystack_destination_consent','paystack_destinations',p_wedding_id::text);
  return true;
end $$;

create function public.paystack_contribution_quote(p_wedding_id uuid,p_amount_minor bigint,p_currency text,p_market text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare pp public.paystack_live_policy; d public.paystack_destinations; p public.platform_policies;
  fx public.publication_fx_snapshots; rate numeric:=1; fixed_fee bigint; fee bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into pp from public.paystack_live_policy where singleton;
  select * into d from public.paystack_destinations where wedding_id=p_wedding_id;
  select * into p from public.platform_policies where id;
  if not pp.approved or not coalesce('paystack'=any(p.enabled_payment_providers),false)
    or (pp.settlement_mode='standard' and not pp.standard_enabled)
    or (pp.settlement_mode='split' and (not pp.split_enabled or not pp.split_contract_ready
      or d.merchant_id is distinct from pp.merchant_id or d.credential_fingerprint is distinct from pp.credential_fingerprint
      or d.currency is distinct from p_currency or d.consent_at is null or not public.kyc_is_complete(p_wedding_id)))
    or not exists(select 1 from public.weddings where id=p_wedding_id and currency=p_currency
      and published_at is not null and archived_at is null)
    or not exists(select 1 from jsonb_array_elements(pp.capabilities) pair
      where pair->>'market'=p_market and pair->>'currency'=p_currency)
    or not public.paystack_accounting_currency_supported(p_currency)
    or p_amount_minor is null or p_amount_minor not between 1 and p.max_contribution_minor then
    raise exception 'Paystack selected settlement mode is held pending approved capability and required evidence.';
  end if;
  if p.contribution_fixed_fee_minor > 0 and p.contribution_fixed_fee_currency <> 'USD' then
    raise exception 'Owner must configure the fixed platform fee in USD before live Paystack.';
  end if;
  if p.contribution_fixed_fee_minor > 0 and p_currency <> 'USD' then
    select * into fx from public.publication_fx_snapshots where published_at >= now()-interval '36 hours'
      and published_at <= now()+interval '5 minutes' and rates->>p_currency is not null order by published_at desc limit 1;
    if not found then raise exception 'FX_UNAVAILABLE: A fresh USD platform-fee rate is required.'; end if;
    rate:=(fx.rates->>p_currency)::numeric;
    if rate <= 0 or rate > 1000000000000 then raise exception 'FX_UNAVAILABLE: Invalid platform-fee rate.'; end if;
  end if;
  fixed_fee:=ceil(p.contribution_fixed_fee_minor::numeric*rate)::bigint;
  fee:=round(p_amount_minor::numeric*p.contribution_fee_basis_points/10000)::bigint+fixed_fee;
  if fee >= p_amount_minor then raise exception 'Payment must exceed the configured platform fee.'; end if;
  return jsonb_build_object('kind','guest','environment','live','wedding_id',p_wedding_id,'merchant_id',pp.merchant_id,
    'credential_fingerprint',pp.credential_fingerprint,'policy_revision',pp.revision,
    'settlement_mode',pp.settlement_mode,'settlement_route',case when pp.settlement_mode='split' then 'paystack_direct' else 'platform_wallet' end,
    'amount_minor',p_amount_minor,'currency',p_currency,'market',p_market,
    'fee_bearer',case when pp.settlement_mode='split' then pp.fee_bearer else 'couple_wallet' end,
    'platform_fee_minor',fee,'fee_basis_points',p.contribution_fee_basis_points,'fixed_fee_minor',fixed_fee,
    'fixed_fee_usd_minor',p.contribution_fixed_fee_minor,'fx_snapshot_id',fx.id,'fx_rate',rate,'fx_published_at',fx.published_at)
    || case when pp.settlement_mode='split' then jsonb_build_object('destination_revision',d.revision,
      'subaccount_code',d.subaccount_code,'subaccount_id',d.subaccount_id,'destination_fingerprint',d.destination_fingerprint)
      else '{}'::jsonb end;
end $$;

-- Extend, rather than replace, the Daraja guard.
create or replace function public.guard_payment_environment() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.payment_environment <> 'test' and not (new.payment_environment='live' and new.provider_name in ('daraja','paystack')) then
    raise exception 'Live payment settlement is not enabled.';
  end if;
  return new;
end $$;
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.guard_live_payment_context()'::regprocedure);
  definition:=replace(definition,'if tg_op = ''INSERT'' then',
    'if new.provider_name = ''paystack'' then return new; end if;
  if tg_op = ''INSERT'' then');
  execute definition;
end $$;

create function public.guard_paystack_context() returns trigger
language plpgsql security definer set search_path = '' as $$
declare expected jsonb;
begin
  if tg_op='DELETE' then
    if old.paystack_context is not null then raise exception 'Paystack financial admissions cannot be deleted.'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and (old.provider_name='paystack' or new.provider_name='paystack')
    and old.payment_environment is distinct from new.payment_environment then
    raise exception 'Payment environment is immutable.';
  end if;
  if tg_op='UPDATE' and (old.paystack_context is not null or new.paystack_context is not null) then
    if old.paystack_context is distinct from new.paystack_context or old.settlement_route is distinct from new.settlement_route
      or old.provider_name is distinct from new.provider_name or old.payment_environment is distinct from new.payment_environment
      or old.pledged_amount_minor is distinct from new.pledged_amount_minor or old.currency is distinct from new.currency
      or old.wedding_id is distinct from new.wedding_id or old.provider_reference is distinct from new.provider_reference
      or old.platform_fee_basis_points is distinct from new.platform_fee_basis_points
      or old.platform_fixed_fee_minor is distinct from new.platform_fixed_fee_minor then
      raise exception 'Paystack admitted context is immutable.';
    end if;
    if new.payment_status='paid' and not exists(select 1 from public.paystack_payment_evidence e
      where e.contribution_id=new.id and e.provider_reference=new.provider_reference
        and e.amount_minor=new.pledged_amount_minor and e.currency=new.currency) then
      raise exception 'Paystack paid fulfillment requires independent provider allocation evidence.';
    end if;
    return new;
  end if;
  if new.provider_name='paystack' and new.payment_environment='live' then
    perform 1 from public.paystack_live_policy where singleton for share;
    perform 1 from public.platform_policies where id for share;
    perform 1 from public.paystack_destinations where wedding_id=new.wedding_id for share;
    expected:=public.paystack_contribution_quote(new.wedding_id,new.pledged_amount_minor,new.currency,new.paystack_context->>'market');
    if new.paystack_context is distinct from expected or new.settlement_route is distinct from expected->>'settlement_route'
      or new.payment_status <> 'pending' or new.verified_provider_payment
      or new.provider_reference is distinct from new.checkout_idempotency_key::text
      or new.platform_fee_basis_points is distinct from (expected->>'fee_basis_points')::integer
      or new.platform_fixed_fee_minor is distinct from (expected->>'fixed_fee_minor')::bigint then
      raise exception 'Paystack quote or controls changed. Reload before checkout.';
    end if;
  elsif new.paystack_context is not null or new.settlement_route <> 'platform_wallet' then
    raise exception 'Paystack direct context requires a live Paystack payment.';
  end if;
  return new;
end $$;
create trigger guard_paystack_context before insert or update or delete on public.contributions
  for each row execute function public.guard_paystack_context();

create function public.record_verified_paystack_payment(p_contribution_id uuid,p_event_id text,p_reference text,
  p_amount_minor bigint,p_currency text,p_fee_minor bigint,p_paid_at timestamptz,p_payment_reference text,p_allocation jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.contributions; couple bigint; platform bigint; recorded boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into c from public.contributions where id=p_contribution_id for update;
  if c.paystack_context is null or c.provider_name <> 'paystack' or c.payment_environment <> 'live'
    or c.provider_reference is distinct from p_reference or c.currency is distinct from p_currency
    or c.pledged_amount_minor is distinct from p_amount_minor or p_fee_minor is null or p_fee_minor < 0
    or length(coalesce(p_payment_reference,'')) not between 1 and 200 then raise exception 'Paystack evidence does not match admission.'; end if;
  couple:=p_amount_minor-(c.paystack_context->>'platform_fee_minor')::bigint
    -case when c.paystack_context->>'fee_bearer' in ('subaccount','couple_wallet') then p_fee_minor else 0 end;
  platform:=(c.paystack_context->>'platform_fee_minor')::bigint
    -case when c.paystack_context->>'fee_bearer'='account' then p_fee_minor else 0 end;
  if couple<0 or platform<0 or p_allocation is null or p_allocation is distinct from
    jsonb_build_object('couple_minor',couple,'platform_minor',platform,'provider_fee_minor',p_fee_minor) then
    raise exception 'Paystack fee allocation does not conserve the verified amount.';
  end if;
  insert into public.paystack_payment_evidence(contribution_id,provider_event_id,provider_reference,provider_payment_reference,
    amount_minor,currency,provider_fee_minor,couple_minor,platform_minor)
    values(c.id,p_event_id,p_reference,p_payment_reference,p_amount_minor,p_currency,p_fee_minor,couple,platform)
    on conflict(contribution_id) do nothing;
  if not exists(select 1 from public.paystack_payment_evidence e where e.contribution_id=c.id
    and e.provider_fee_minor=p_fee_minor and e.provider_payment_reference=p_payment_reference) then
    raise exception 'Conflicting Paystack evidence requires review.';
  end if;
  recorded:=public.record_verified_payment('paystack',p_event_id,c.id,p_amount_minor,p_currency,p_reference,p_fee_minor,p_paid_at,p_payment_reference);
  update public.contributions set provider_fee_pending=false where id=c.id and payment_status='paid';
  return recorded;
end $$;

-- Exclude direct settlements and their later adjustment entries from every wallet calculation.
do $$
declare signature text; definition text;
begin
  foreach signature in array array['public.withdrawable_balance(uuid,text)',
    'public.request_payout(uuid,bigint,text,text,boolean)','public.guard_test_payouts()'] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    definition:=replace(definition,'c.payment_environment = ''live''',
      'c.payment_environment = ''live'' and c.settlement_route = ''platform_wallet''');
    definition:=replace(definition,'live_payment.payment_environment = ''live''',
      'live_payment.payment_environment = ''live'' and live_payment.settlement_route = ''platform_wallet''');
    execute definition;
  end loop;
end $$;

-- Gross fundraising remains visible, but direct funds are not an available wallet asset.
do $$
declare definition text;
begin
  definition:=pg_get_viewdef('public.finance_summary'::regclass,true);
  definition:=replace(definition,'sum(contributions.net_paid_minor)',
    'sum(CASE WHEN contributions.settlement_route = ''platform_wallet'' THEN contributions.net_paid_minor ELSE 0 END)');
  definition:=replace(definition,'sum(contributions.provider_fee_minor)',
    'sum(CASE WHEN contributions.settlement_route = ''platform_wallet'' THEN contributions.provider_fee_minor ELSE 0 END)');
  definition:=replace(definition,'sum((contributions.net_paid_minor - contributions.provider_fee_minor))',
    'sum(CASE WHEN contributions.settlement_route = ''platform_wallet'' THEN contributions.net_paid_minor - contributions.provider_fee_minor ELSE 0 END)');
  definition:=replace(definition,'sum(contributions.net_paid_minor - contributions.provider_fee_minor)',
    'sum(CASE WHEN contributions.settlement_route = ''platform_wallet'' THEN contributions.net_paid_minor - contributions.provider_fee_minor ELSE 0 END)');
  definition:=replace(definition,'financial_adjustment_ledger.currency = currencies.currency',
    'financial_adjustment_ledger.currency = currencies.currency AND EXISTS (SELECT 1 FROM public.contributions wallet_c WHERE wallet_c.id=financial_adjustment_ledger.contribution_id AND wallet_c.settlement_route=''platform_wallet'')');
  definition:=replace(definition,'payment_adjustments.currency = currencies.currency',
    'payment_adjustments.currency = currencies.currency AND EXISTS (SELECT 1 FROM public.contributions wallet_c WHERE wallet_c.id=payment_adjustments.contribution_id AND wallet_c.settlement_route=''platform_wallet'')');
  execute 'create or replace view public.finance_summary with (security_invoker=true) as ' || definition;
end $$;

revoke all on function public.owner_set_paystack_policy(boolean,text,text,jsonb,boolean,boolean,text,boolean,boolean,uuid),
  public.owner_set_paystack_settlement_mode(text,uuid,boolean),
  public.owner_verify_paystack_destination(uuid,jsonb,boolean),public.paystack_destination_status(uuid),
  public.consent_paystack_destination(uuid,uuid,boolean) from public,anon;
grant execute on function public.owner_set_paystack_policy(boolean,text,text,jsonb,boolean,boolean,text,boolean,boolean,uuid),
  public.owner_set_paystack_settlement_mode(text,uuid,boolean),
  public.owner_verify_paystack_destination(uuid,jsonb,boolean),public.paystack_destination_status(uuid),
  public.consent_paystack_destination(uuid,uuid,boolean) to authenticated;
revoke all on function public.paystack_contribution_quote(uuid,bigint,text,text),
  public.record_verified_paystack_payment(uuid,text,text,bigint,text,bigint,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.paystack_contribution_quote(uuid,bigint,text,text),
  public.record_verified_paystack_payment(uuid,text,text,bigint,text,bigint,timestamptz,text,jsonb) to service_role;
