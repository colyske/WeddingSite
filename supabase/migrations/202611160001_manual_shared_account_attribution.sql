-- Explicit manual-only attribution for shared merchant accounts.
-- No existing scope/history/policy is converted, enabled or credited.
alter table public.manual_payout_custody add column shared_manual boolean not null default false;
alter table public.manual_payout_custody alter column available_minor drop not null;
alter table public.manual_payout_custody alter column statement_at drop not null;
alter table public.manual_payout_custody add constraint manual_payout_scope_kind check (
  (shared_manual and available_minor is null and statement_at is null) or
  (not shared_manual and available_minor is not null and statement_at is not null));

create table public.manual_payout_attributed_settlements (
  contribution_id uuid primary key references public.contributions(id),
  custody_id uuid not null references public.manual_payout_custody(id),
  line_reference uuid not null,
  settled_minor bigint not null check(settled_minor>0),
  settled_at timestamptz not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  unique(custody_id,line_reference)
);
create table public.manual_payout_transfer_verifications (
  payout_id uuid primary key references public.manual_payout_requests(id),
  transaction_reference text not null,
  actual_minor bigint not null check(actual_minor>0),
  fee_minor bigint not null check(fee_minor>=0),
  currency text not null,
  booked_at timestamptz not null,
  debit_evidence uuid not null unique references public.manual_payout_evidence(id),
  reconciliation_evidence uuid not null unique references public.manual_payout_evidence(id),
  verified_by uuid not null references public.profiles(id),
  owner_solo boolean not null,
  verified_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['manual_payout_attributed_settlements','manual_payout_transfer_verifications'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger manual_payout_immutable before update or delete on public.%I
      for each row execute function public.manual_payout_immutable()',t);
  end loop;
end $$;

-- One contribution can back only one scope/rail. Both intake paths serialize on
-- the existing global lock; the trigger also rejects a direct privileged insert.
create function public.manual_payout_unique_settlement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(71110001);
  if (tg_table_name='manual_payout_settlements' and exists(
    select 1 from public.manual_payout_attributed_settlements where contribution_id=new.contribution_id))
    or (tg_table_name='manual_payout_attributed_settlements' and exists(
    select 1 from public.manual_payout_settlements where contribution_id=new.contribution_id)) then
    raise exception 'Contribution already allocated to another settlement scope.'; end if;
  return new;
end $$;
create trigger manual_payout_unique_settlement before insert on public.manual_payout_settlements
  for each row execute function public.manual_payout_unique_settlement();
create trigger manual_payout_unique_settlement before insert on public.manual_payout_attributed_settlements
  for each row execute function public.manual_payout_unique_settlement();

create function public.manual_payout_register_shared_account(p_account uuid,p_currency text,p_evidence uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.manual_payout_accounts; result uuid;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into strict a from public.manual_payout_accounts where id=p_account;
  perform public.manual_payout_evidence_require(a.evidence_id,'account',public.current_platform_role()='owner');
  perform public.manual_payout_evidence_require(p_evidence,'custody',public.current_platform_role()='owner');
  -- The existing unique provider/account/currency constraint forbids another alias
  -- or silently replacing a historic statement-backed scope for this account.
  insert into public.manual_payout_custody(provider,account_reference,currency,available_minor,statement_at,evidence_id,shared_manual)
    values(a.provider,p_account,p_currency,null,null,p_evidence,true) returning id into result;
  return result;
end $$;

create function public.manual_payout_attribute_settlement(p_contribution uuid,p_custody uuid,p_line uuid,
  p_settled bigint,p_at timestamptz,p_evidence uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare a public.manual_payout_custody; c public.contributions; solo boolean;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into strict a from public.manual_payout_custody where id=p_custody for update;
  select * into strict c from public.contributions where id=p_contribution for update;
  solo:=public.current_platform_role()='owner';
  perform public.manual_payout_evidence_require(a.evidence_id,'custody',solo);
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_accounts where id=a.account_reference),'account',solo);
  perform public.manual_payout_evidence_require(p_evidence,'settlement',solo);
  if not a.shared_manual or c.payment_environment is distinct from 'live'
    or c.settlement_route is distinct from 'platform_wallet' or c.payment_status is distinct from 'paid'
    or c.verified_provider_payment is distinct from true or c.provider_fee_pending is distinct from false
    or c.provider_fee_minor is null or c.provider_name is distinct from a.provider or c.currency is distinct from a.currency
    or p_settled is null or p_settled<=0 or p_settled is distinct from c.net_paid_minor-c.provider_fee_minor
    or p_at is null or c.paid_at is null or p_at<c.paid_at or p_at>clock_timestamp() then
    raise exception 'Attribution requires an actual verified live fee-known net contribution and checked transaction-specific settlement proof.'; end if;
  insert into public.manual_payout_attributed_settlements
    values(p_contribution,p_custody,p_line,p_settled,p_at,p_evidence,auth.uid());
  return true;
end $$;

-- Retain the old statement/account model unchanged for existing scopes and B2C.
-- Only manual request/transition foundations call this dispatcher.
create function public.manual_payout_manual_eligible(p_wedding uuid,p_custody uuid,p_recipient uuid,
  p_currency text,p_required bigint,p_excluding uuid default null,p_owner_solo boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare a public.manual_payout_custody; funds numeric; reserved numeric; obligations numeric;
begin
  select * into strict a from public.manual_payout_custody where id=p_custody;
  if not a.shared_manual then
    perform public.manual_payout_eligible(p_wedding,p_custody,p_recipient,p_currency,p_required,p_excluding,p_owner_solo);
    return;
  end if;
  if exists(select 1 from public.manual_payout_account_holds where custody_id=p_custody)
    or exists(select 1 from public.manual_payout_requests where custody_id=p_custody and id is distinct from p_excluding
      and public.manual_payout_state(id) in ('uncertain','resolution_proposed')) then
    raise exception 'Held account or uncertain outcome: no new exposure or blind resend.'; end if;
  perform public.manual_payout_evidence_require(a.evidence_id,'custody',p_owner_solo);
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_accounts where id=a.account_reference),'account',p_owner_solo);
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_recipients where id=p_recipient),'recipient',p_owner_solo);
  if a.currency is distinct from p_currency or p_required is null or p_required<=0
    or not public.kyc_is_complete(p_wedding) or not exists(
      select 1 from public.manual_payout_recipients r join public.wedding_kyc k on k.wedding_id=r.wedding_id
      where r.id=p_recipient and r.wedding_id=p_wedding and r.provider=a.provider and r.currency=p_currency
        and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')
        and not exists(select 1 from public.manual_payout_recipients newer where newer.wedding_id=p_wedding
          and newer.provider=r.provider and newer.currency=r.currency and newer.revision>r.revision)) then
    raise exception 'Current recipient verification, KYC, consent and exact currency required.'; end if;
  select coalesce(sum(s.settled_minor),0) into funds
    from public.manual_payout_attributed_settlements s join public.contributions c on c.id=s.contribution_id
    where s.custody_id=p_custody and c.wedding_id=p_wedding and c.currency=p_currency
      and c.payment_environment='live' and c.settlement_route='platform_wallet' and c.payment_status='paid'
      and c.verified_provider_payment and not c.provider_fee_pending and c.provider_fee_minor is not null
      and c.provider_name=a.provider and s.settled_minor=c.net_paid_minor-c.provider_fee_minor
      and (c.funds_available_at is null or c.funds_available_at<=now())
      and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',p_owner_solo);
  -- WeddingSite-only obligations and both rails' commitments, across scopes.
  -- No global Paybill balance, other-system receipts or assumed portal liquidity.
  select coalesce(sum(debit_minor::numeric+hold_minor),0) into obligations
    from public.manual_payout_sources() where wedding_id=p_wedding and currency=p_currency;
  select coalesce(sum(amount_minor::numeric+fee_minor),0) into reserved
    from public.manual_payout_requests where wedding_id=p_wedding and currency=p_currency and id is distinct from p_excluding
      and public.manual_payout_state(id) not in ('cancelled','not_transferred');
  if funds-reserved-obligations<p_required then
    raise exception 'Insufficient attributable settled wedding net after obligations and internal exposure reservations.'; end if;
end $$;
do $$ declare name text; definition text; updated text; begin
  foreach name in array array['manual_payout_request_foundation','manual_payout_transition_foundation'] loop
    select pg_get_functiondef(p.oid) into strict definition from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proname=name;
    updated:=replace(definition,'public.manual_payout_eligible(','public.manual_payout_manual_eligible(');
    if updated=definition then raise exception 'Unexpected manual eligibility predecessor'; end if;
    execute updated;
  end loop;
end $$;

alter function public.manual_payout_policy_blockers(public.manual_payout_operating_policies)
  rename to manual_payout_policy_blockers_statement;
create function public.manual_payout_policy_blockers(p public.manual_payout_operating_policies) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare a public.manual_payout_custody; blockers jsonb:='[]'; recipient uuid;
begin
  select * into a from public.manual_payout_custody where id=p.custody_id;
  if not coalesce(a.shared_manual,false) then return public.manual_payout_policy_blockers_statement(p); end if;
  if not exists(select 1 from public.profiles where id=p.actor_id and platform_role='owner') then
    blockers:=blockers||jsonb_build_array('Current protected Owner policy authority required'); end if;
  if p.per_payout_minor is null or p.daily_minor is null or p.daily_minor<p.per_payout_minor
    or p.payout_fee_minor is null or p.fee_payer is distinct from 'wedding' then
    blockers:=blockers||jsonb_build_array('Explicit per-transfer total, UTC-day exposure cap and wedding fee payer/amount required'); end if;
  if not exists(select 1 from public.platform_policies pp where pp.id is true
    and p.per_payout_minor::numeric-p.payout_fee_minor between pp.min_payout_minor and pp.max_payout_minor) then
    blockers:=blockers||jsonb_build_array('Manual principal limit must fit existing platform payout minimum/maximum'); end if;
  if not public.manual_payout_evidence_accepted(p.review_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.fee_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.rail_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(p.secure_evidence,'policy',true)
    or not public.manual_payout_evidence_accepted(a.evidence_id,'custody',true)
    or not public.manual_payout_evidence_accepted((select evidence_id from public.manual_payout_accounts where id=a.account_reference),'account',true) then
    blockers:=blockers||jsonb_build_array('Checked account attribution, policy, fee, authorized rail and secure evidence procedures required'); end if;
  if exists(select 1 from public.manual_payout_account_holds where custody_id=a.id)
    or exists(select 1 from public.manual_payout_requests where custody_id=a.id
      and public.manual_payout_state(id) in ('uncertain','resolution_proposed')) then
    blockers:=blockers||jsonb_build_array('Existing incident or uncertain outcome holds admission'); end if;
  if cardinality(p.recipient_ids)=0 or cardinality(p.recipient_ids)>100 or array_position(p.recipient_ids,null) is not null
    or cardinality(p.recipient_ids)<>(select count(distinct r) from unnest(p.recipient_ids) r) then
    blockers:=blockers||jsonb_build_array('Explicit recipient revision allowlist required');
  else
    foreach recipient in array p.recipient_ids loop
      if not exists(select 1 from public.manual_payout_recipients r join public.weddings w on w.id=r.wedding_id
        join public.wedding_kyc k on k.wedding_id=w.id where r.id=recipient and r.provider=a.provider
        and r.currency=a.currency and w.currency=r.currency and public.kyc_is_complete(w.id)
        and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')
        and public.manual_payout_evidence_accepted(r.evidence_id,'recipient',true)
        and not exists(select 1 from public.manual_payout_recipients newer where newer.wedding_id=r.wedding_id
          and newer.provider=r.provider and newer.currency=r.currency and newer.revision>r.revision)) then
        blockers:=blockers||jsonb_build_array('Current recipient, KYC/consent or currency invalid'); exit; end if;
    end loop;
  end if;
  return blockers;
end $$;

create function public.manual_payout_verify_transfer(p_id uuid,p_reference text,p_actual bigint,p_fee bigint,
  p_currency text,p_at timestamptz,p_debit_evidence uuid,p_evidence uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.manual_payout_requests; a public.manual_payout_custody; receipt public.manual_payout_receipts;
  prior public.manual_payout_transfer_verifications; sender uuid; solo boolean;
begin
  perform public.require_staff('superadmin'); perform public.manual_payout_intake_authority(false);
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  select * into strict a from public.manual_payout_custody where id=r.custody_id and shared_manual;
  solo:=r.owner_solo and r.requested_by=auth.uid() and public.current_platform_role()='owner';
  if r.owner_solo and not solo then raise exception 'Protected Owner owns this solo request.'; end if;
  select sender_id into sender from public.manual_payout_claims where payout_id=p_id and execution_channel='manual_external';
  if sender is null or (not solo and auth.uid() in (sender,r.requested_by)) then
    raise exception 'Independent reconciler for a manual claimed transfer required.'; end if;
  select * into strict receipt from public.manual_payout_receipts where payout_id=p_id;
  perform public.manual_payout_evidence_require(receipt.evidence_id,'receipt',solo);
  perform public.manual_payout_evidence_require(p_debit_evidence,'statement',solo);
  perform public.manual_payout_evidence_require(p_evidence,'reconciliation',solo);
  if (upper(btrim(p_reference)),p_actual,p_fee,p_currency) is distinct from
      (receipt.transaction_reference,receipt.actual_minor,receipt.actual_fee_minor,receipt.currency)
    or (p_actual,p_fee,p_currency) is distinct from (r.amount_minor,r.fee_minor,r.currency)
    or (receipt.provider,receipt.account_reference) is distinct from (a.provider,a.account_reference)
    or p_at is null or p_at<receipt.transferred_at or p_at>clock_timestamp() then
    raise exception 'Exact transaction-specific debit reference, net transfer, fee, account, currency and booked date required; retain exposure.'; end if;
  select * into prior from public.manual_payout_transfer_verifications where payout_id=p_id;
  if found then
    if (prior.transaction_reference,prior.actual_minor,prior.fee_minor,prior.currency,prior.booked_at,
      prior.debit_evidence,prior.reconciliation_evidence,prior.verified_by,prior.owner_solo) is distinct from
      (upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_debit_evidence,p_evidence,auth.uid(),solo) then
      raise exception 'Transfer verification replay changed.'; end if;
    return true;
  end if;
  if public.manual_payout_state(p_id)<>'reported' then raise exception 'Reported exact transfer required; never resend an uncertain transfer.'; end if;
  insert into public.manual_payout_transfer_verifications(payout_id,transaction_reference,actual_minor,fee_minor,currency,
    booked_at,debit_evidence,reconciliation_evidence,verified_by,owner_solo)
    values(p_id,upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_debit_evidence,p_evidence,auth.uid(),solo);
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id,owner_solo)
    values(p_id,'paid',auth.uid(),p_evidence,solo);
  return true;
end $$;

alter function public.manual_payout_guard_paid() rename to manual_payout_guard_paid_statement;
-- Trigger functions cannot be called normally; preserve the old trigger for
-- statement-mode requests with a WHEN clause, and add an exact shared-mode guard.
drop trigger manual_payout_guard_paid on public.manual_payout_events;
create function public.manual_payout_guard_paid_shared() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state='paid' and exists(select 1 from public.manual_payout_requests r
    join public.manual_payout_custody a on a.id=r.custody_id where r.id=new.payout_id and a.shared_manual) then
    if not exists(select 1 from public.manual_payout_transfer_verifications v
      join public.manual_payout_requests r on r.id=v.payout_id
      join public.manual_payout_claims c on c.payout_id=r.id and c.execution_channel='manual_external'
      join public.manual_payout_receipts x on x.payout_id=r.id
      where v.payout_id=new.payout_id and v.verified_by=new.actor_id and v.owner_solo=new.owner_solo
        and v.reconciliation_evidence=new.evidence_id
        and (v.actual_minor,v.fee_minor,v.currency) is not distinct from (r.amount_minor,r.fee_minor,r.currency)
        and (v.transaction_reference,v.actual_minor,v.fee_minor,v.currency) is not distinct from
          (x.transaction_reference,x.actual_minor,x.actual_fee_minor,x.currency)) then
      raise exception 'Paid requires atomically verified exact shared-account transfer evidence.'; end if;
  elsif new.state='paid' and not exists(select 1 from public.manual_payout_reconciliations r
    join public.manual_payout_statement_debits d on d.payout_id=r.payout_id
    where r.payout_id=new.payout_id) then
    raise exception 'Paid requires registered statement reconciliation.'; end if;
  return new;
end $$;
-- Retain the full original guard for old records. A trigger WHEN cannot query,
-- so a separate routing trigger enforces the full old contract using its exact
-- invariant, copied via an asserted definition transformation below.
do $$ declare definition text; updated text; begin
  select pg_get_functiondef('public.manual_payout_guard_paid_statement()'::regprocedure) into definition;
  updated:=replace(definition,'public.manual_payout_guard_paid_statement()', 'public.manual_payout_guard_paid_routed()');
  updated:=replace(updated,'if new.state=''paid'' and not exists(',
    'if new.state=''paid'' and not exists(select 1 from public.manual_payout_requests request join public.manual_payout_custody scope on scope.id=request.custody_id where request.id=new.payout_id and scope.shared_manual) and not exists(');
  if updated=definition or position('scope.shared_manual' in updated)=0 then raise exception 'Unexpected paid guard predecessor'; end if;
  execute updated;
end $$;
create trigger manual_payout_guard_paid before insert on public.manual_payout_events
  for each row execute function public.manual_payout_guard_paid_routed();
create trigger manual_payout_guard_paid_shared before insert on public.manual_payout_events
  for each row execute function public.manual_payout_guard_paid_shared();

-- Preserve paid WeddingSite history even without whole-account statement maps.
create function public.manual_payout_preserve_attributed_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if ((tg_table_name='expenses' and old.status::text='paid') or (tg_table_name='payout_records' and old.status::text='sent'))
    and ((new.wedding_id,new.amount_minor,new.currency,new.status) is distinct from (old.wedding_id,old.amount_minor,old.currency,old.status)
      or (to_jsonb(new)->'paid_at',to_jsonb(new)->'confirmed_at',to_jsonb(new)->'external_reference',to_jsonb(new)->'provider_reference')
      is distinct from (to_jsonb(old)->'paid_at',to_jsonb(old)->'confirmed_at',to_jsonb(old)->'external_reference',to_jsonb(old)->'provider_reference'))
    and exists(select 1 from public.manual_payout_requests r join public.manual_payout_custody a on a.id=r.custody_id
      where r.wedding_id=old.wedding_id and a.shared_manual) then
    raise exception 'Prior paid WeddingSite commitment cannot be rewritten after shared-account exposure.'; end if;
  return new;
end $$;
create trigger manual_payout_preserve_attributed_history before update on public.expenses
  for each row execute function public.manual_payout_preserve_attributed_history();
create trigger manual_payout_preserve_attributed_history before update on public.payout_records
  for each row execute function public.manual_payout_preserve_attributed_history();

alter function public.manual_payout_workspace() rename to manual_payout_workspace_references;
create function public.manual_payout_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.manual_payout_workspace_references();
  return result||jsonb_build_object(
    'sharedScopes',coalesce((select jsonb_agg(id) from public.manual_payout_custody where shared_manual),'[]'::jsonb),
    'weddings',coalesce((select jsonb_agg(jsonb_build_object('id',id,'currency',currency,'wedding_date',wedding_date))
      from public.weddings),'[]'::jsonb),
    'settlementCandidates',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'wedding_id',c.wedding_id,'currency',c.currency,
      'provider',c.provider_name,'net_minor',c.net_paid_minor-c.provider_fee_minor,'paid_at',c.paid_at))
      from public.contributions c where c.payment_environment='live' and c.settlement_route='platform_wallet'
        and c.payment_status='paid' and c.verified_provider_payment and not c.provider_fee_pending
        and c.provider_fee_minor is not null and not exists(select 1 from public.manual_payout_settlements s where s.contribution_id=c.id)
        and not exists(select 1 from public.manual_payout_attributed_settlements s where s.contribution_id=c.id)),'[]'::jsonb),
    'transferVerifications',coalesce((select jsonb_agg(jsonb_build_object('payout_id',payout_id,'verified_by',verified_by,
      'verified_at',verified_at)) from public.manual_payout_transfer_verifications),'[]'::jsonb));
end $$;

alter function public.manual_payout_balance(uuid) rename to manual_payout_balance_statement;
create function public.manual_payout_balance(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; backing numeric; unknown_funds numeric;
begin
  result:=public.manual_payout_balance_statement(p_wedding);
  select coalesce(sum(s.settled_minor),0) into backing
    from public.manual_payout_attributed_settlements s join public.contributions c on c.id=s.contribution_id
    where c.wedding_id=p_wedding and c.currency=result->>'currency' and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.payment_status='paid' and c.verified_provider_payment
      and not c.provider_fee_pending and c.provider_fee_minor is not null and s.settled_minor=c.net_paid_minor-c.provider_fee_minor
      and (c.funds_available_at is null or c.funds_available_at<=now())
      and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',true);
  select coalesce(sum(c.net_paid_minor),0) into unknown_funds from public.contributions c
    where c.wedding_id=p_wedding and c.currency=result->>'currency' and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.verified_provider_payment and c.payment_status='paid'
      and not (not c.provider_fee_pending and c.provider_fee_minor is not null
        and (c.funds_available_at is null or c.funds_available_at<=now()) and exists(
          select 1 from (
            select contribution_id,settled_minor,evidence_id from public.manual_payout_settlements
            union all select contribution_id,settled_minor,evidence_id from public.manual_payout_attributed_settlements
          ) s where s.contribution_id=c.id and s.settled_minor=c.net_paid_minor-c.provider_fee_minor
            and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',true)));
  return result||jsonb_build_object('attributable_settled_minor',(result->>'statement_backed_minor')::numeric+backing,
    'attributed_minor',backing,'unknown_or_held_minor',unknown_funds,
    'nonwithdrawable_estimate_minor',greatest((result->>'statement_backed_minor')::numeric+backing-
      (result->>'reserved_minor')::numeric-(result->>'spent_minor')::numeric-(result->>'known_obligations_minor')::numeric,0),
    'status','WeddingSite internal exposure only; merchant liquidity is checked externally, never guaranteed.');
end $$;

do $$ declare f record; begin
  for f in select p.oid from pg_proc p where p.pronamespace='public'::regnamespace and
    p.proname in ('manual_payout_unique_settlement','manual_payout_register_shared_account','manual_payout_attribute_settlement',
      'manual_payout_manual_eligible','manual_payout_policy_blockers_statement','manual_payout_policy_blockers',
      'manual_payout_verify_transfer','manual_payout_guard_paid_statement','manual_payout_guard_paid_routed',
      'manual_payout_guard_paid_shared','manual_payout_preserve_attributed_history','manual_payout_workspace_references',
      'manual_payout_workspace','manual_payout_balance_statement','manual_payout_balance') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.oid::regprocedure);
  end loop;
end $$;
grant execute on function public.manual_payout_register_shared_account(uuid,text,uuid),
  public.manual_payout_attribute_settlement(uuid,uuid,uuid,bigint,timestamptz,uuid),
  public.manual_payout_verify_transfer(uuid,text,bigint,bigint,text,timestamptz,uuid,uuid),
  public.manual_payout_workspace(),public.manual_payout_balance(uuid) to authenticated;
