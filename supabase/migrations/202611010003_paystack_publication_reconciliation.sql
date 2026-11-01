alter table public.publication_checkouts drop constraint publication_checkouts_payment_mode_check;
alter table public.publication_checkouts add constraint publication_checkouts_payment_mode_check
  check (payment_mode='test' or (payment_mode='live' and provider='paystack'));
alter table public.publication_checkouts add column paystack_context jsonb;

create function public.begin_live_paystack_publication(p_wedding_id uuid,p_idempotency_key uuid,
  p_expected_amount bigint,p_expected_currency text,p_expected_usd_amount bigint,p_expected_fx_id uuid,
  p_merchant_id text,p_credential_fingerprint text)
returns public.publication_checkouts language plpgsql security definer set search_path = '' as $$
declare pp public.paystack_live_policy; row public.publication_checkouts;
begin
  select * into pp from public.paystack_live_policy where singleton for share;
  if not pp.approved or not pp.publication_enabled or pp.merchant_id is distinct from p_merchant_id
    or pp.credential_fingerprint is distinct from p_credential_fingerprint
    or not public.paystack_accounting_currency_supported(p_expected_currency) or
    not exists(select 1 from jsonb_array_elements(pp.capabilities) pair where pair->>'currency'=p_expected_currency) then
    raise exception 'Live Paystack publication is not approved for this merchant/currency.';
  end if;
  -- The existing admission function enforces owner, draft, policy/FX quote and idempotency.
  perform set_config('weddingsite.paystack_publication_context',jsonb_build_object(
    'kind','publication','environment','live','merchant_id',pp.merchant_id,
    'credential_fingerprint',pp.credential_fingerprint,'policy_revision',pp.revision,
    'currency',p_expected_currency,'amount_minor',p_expected_amount,'platform_fee_minor',p_expected_amount,
    'fee_bearer','account','usd_amount_minor',p_expected_usd_amount,'fx_snapshot_id',p_expected_fx_id)::text,true);
  row:=public.begin_publication_checkout(p_wedding_id,p_idempotency_key,'paystack',p_expected_amount,
    p_expected_currency,p_expected_usd_amount,p_expected_fx_id);
  perform set_config('weddingsite.paystack_publication_context','',true);
  return row;
end $$;

create function public.admit_live_paystack_publication() returns trigger
language plpgsql security definer set search_path = '' as $$
declare context jsonb; pp public.paystack_live_policy;
begin
  context:=nullif(current_setting('weddingsite.paystack_publication_context',true),'')::jsonb;
  if context is null then
    if new.payment_mode <> 'test' or new.paystack_context is not null then
      raise exception 'Use protected live publication admission.';
    end if;
    return new;
  end if;
  select * into pp from public.paystack_live_policy where singleton for share;
  if new.provider<>'paystack' or new.amount_minor is distinct from (context->>'amount_minor')::bigint
    or new.currency is distinct from context->>'currency' or not pp.approved or not pp.publication_enabled
    or context->>'policy_revision' is distinct from pp.revision::text then
    raise exception 'Live publication context changed.';
  end if;
  new.payment_mode:='live'; new.paystack_context:=context;
  -- Persist the known reference before the HTTP call so ambiguous initialization can be reconciled.
  new.provider_reference:=new.idempotency_key::text;
  return new;
end $$;
create trigger admit_live_paystack_publication before insert on public.publication_checkouts
  for each row execute function public.admit_live_paystack_publication();

create function public.guard_live_publication_reference() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' then
    if old.payment_mode='live' then raise exception 'Live publication admissions cannot be deleted.'; end if;
    return old;
  end if;
  if old.payment_mode='live' and old.provider_reference is distinct from new.provider_reference then
    raise exception 'Live publication reference is immutable.';
  end if;
  return new;
end $$;
create trigger guard_live_publication_reference before update or delete on public.publication_checkouts
  for each row execute function public.guard_live_publication_reference();

-- Use the admitted environment for accounting. Historical test_paid rows are untouched.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.record_verified_publication_payment(uuid,text,text,bigint,text,text,bigint)'::regprocedure);
  definition:=replace(definition,'''test_paid'',now(),checkout.provider || ''-test''',
    'case when checkout.payment_mode=''live'' then ''paid'' else ''test_paid'' end,now(),
     checkout.provider || case when checkout.payment_mode=''live'' then ''-live'' else ''-test'' end');
  definition:=replace(definition,'''publication_test_payment_verified''',
    'case when checkout.payment_mode=''live'' then ''publication_live_payment_verified'' else ''publication_test_payment_verified'' end');
  execute definition;
end $$;

create table public.paystack_publication_adjustments (
  event_id text primary key,
  checkout_id uuid not null references public.publication_checkouts(id) on delete restrict,
  adjustment_id text not null,
  provider_state text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  occurred_at timestamptz,
  recorded_at timestamptz not null default now()
);
create table public.paystack_publication_resolutions (
  event_id text primary key references public.paystack_publication_adjustments(event_id),
  outcome text not null check (outcome in ('retain_paid','require_payment','waive')),
  reason text not null check (length(reason) between 10 and 240),
  resolved_by uuid not null,
  resolved_at timestamptz not null default now()
);
alter table public.paystack_publication_adjustments enable row level security;
alter table public.paystack_publication_resolutions enable row level security;
revoke all on public.paystack_publication_adjustments,public.paystack_publication_resolutions from public,anon,authenticated;
grant select on public.paystack_publication_adjustments,public.paystack_publication_resolutions to service_role;
create trigger paystack_publication_adjustments_immutable before update or delete on public.paystack_publication_adjustments
  for each row execute function public.prevent_financial_adjustment_ledger_mutation();
create trigger paystack_publication_resolutions_immutable before update or delete on public.paystack_publication_resolutions
  for each row execute function public.prevent_financial_adjustment_ledger_mutation();

create function public.record_paystack_publication_adjustment(p_checkout_id uuid,p_event_id text,p_state text,
  p_adjustment_id text,p_amount_minor bigint,p_currency text,p_occurred_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.publication_checkouts;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
  select * into c from public.publication_checkouts where id=p_checkout_id;
  perform 1 from public.weddings where id=c.wedding_id for update;
  select * into c from public.publication_checkouts where id=p_checkout_id for share;
  if c.payment_mode is distinct from 'live' or c.provider<>'paystack' or c.status<>'paid' or p_amount_minor is null
    or p_amount_minor not between 1 and c.amount_minor or p_currency is distinct from c.currency
    or p_state not in ('refund_pending','refund_processed','refund_failed','dispute_open','dispute_withdrawn',
      'dispute_reinstated','dispute_lost','dispute_won','review')
    or length(coalesce(p_event_id,'')) not between 1 and 200 or length(coalesce(p_adjustment_id,'')) not between 1 and 200 then
    raise exception 'Publication adjustment does not match its admitted live payment.';
  end if;
  insert into public.paystack_publication_adjustments(event_id,checkout_id,adjustment_id,provider_state,amount_minor,currency,occurred_at)
    values(p_event_id,c.id,p_adjustment_id,p_state,p_amount_minor,p_currency,p_occurred_at) on conflict do nothing;
  return true;
end $$;

-- Refunds/disputes never silently republish or reprice a historical fee. Owner resolves
-- the publication entitlement separately after reviewing provider financial handling.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.publication_quote_internal(uuid)'::regprocedure);
  definition:=replace(definition,'select * into w from public.weddings where id = p_wedding_id;',
    'if exists(select 1 from public.paystack_publication_adjustments a join public.publication_checkouts pc on pc.id=a.checkout_id
      where pc.wedding_id=p_wedding_id and not exists(select 1 from public.paystack_publication_resolutions r where r.event_id=a.event_id)) then
      raise exception ''PUBLICATION_REVIEW: A provider refund or dispute requires Owner review before another publication action.'';
    end if;
    select * into w from public.weddings where id = p_wedding_id;');
  execute definition;
end $$;

create function public.owner_resolve_paystack_publication(p_event_id text,p_outcome text,p_reason text,p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare a public.paystack_publication_adjustments; c public.publication_checkouts;
begin
  perform public.require_staff('owner');
  select * into a from public.paystack_publication_adjustments where event_id=p_event_id;
  select * into c from public.publication_checkouts where id=a.checkout_id;
  perform 1 from public.weddings where id=c.wedding_id for update;
  if a.event_id is null or not coalesce(p_confirmed,false) or length(coalesce(p_reason,'')) not between 10 and 240
    or p_outcome is null or p_outcome not in ('retain_paid','require_payment','waive') then raise exception 'Confirm publication review outcome and reason.'; end if;
  if p_outcome='retain_paid' and a.provider_state not in ('refund_failed','dispute_reinstated','dispute_won') then
    raise exception 'Only restored or failed adjustment evidence can retain a paid entitlement; otherwise choose waiver or new payment.';
  end if;
  insert into public.paystack_publication_resolutions(event_id,outcome,reason,resolved_by)
    values(a.event_id,p_outcome,p_reason,auth.uid()) on conflict do nothing;
  if not found then return false; end if;
  if p_outcome in ('require_payment','waive') then
    update public.publication_fees set status=case when p_outcome='waive' then 'waived' else 'pending' end
      where wedding_id=c.wedding_id and status in ('paid','test_paid','pending');
  end if;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    values(c.wedding_id,auth.uid(),'user','paystack_publication_adjustment_resolved','paystack_publication_resolutions',a.event_id);
  return true;
end $$;

create function public.admin_paystack_publication_adjustments() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff();
  if public.current_platform_role() not in ('owner','superadmin') then raise exception 'Leadership finance access required.'; end if;
  return coalesce((select jsonb_agg(x) from (
    select a.* from public.paystack_publication_adjustments a where not exists(select 1 from public.paystack_publication_resolutions r where r.event_id=a.event_id)
    order by a.recorded_at desc limit 500) x),'[]'::jsonb);
end $$;

create table public.paystack_settlement_events (
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  settlement_id text not null check (settlement_id ~ '^[1-9][0-9]*$'),
  status text not null check (status in ('success','pending','processing','failed')),
  couple_minor bigint not null check (couple_minor >= 0),
  currency text not null,
  recorded_by uuid not null,
  recorded_at timestamptz not null default now(),
  primary key(contribution_id,settlement_id,status)
);
alter table public.paystack_settlement_events enable row level security;
revoke all on public.paystack_settlement_events from public,anon,authenticated;
grant select on public.paystack_settlement_events to service_role;
create trigger paystack_settlement_events_immutable before update or delete on public.paystack_settlement_events
  for each row execute function public.prevent_financial_adjustment_ledger_mutation();

create function public.record_paystack_settlement(p_contribution_id uuid,p_settlement_id text,
  p_status text,p_couple_minor bigint,p_currency text,p_actor_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role()<>'service_role' then raise exception 'Service role required.'; end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and platform_role in ('owner','superadmin')) then
    raise exception 'Leadership finance access required.';
  end if;
  if not exists(select 1 from public.paystack_payment_evidence e join public.contributions c on c.id=e.contribution_id
    where c.id=p_contribution_id and c.payment_status='paid' and e.couple_minor=p_couple_minor and e.currency=p_currency) then
    raise exception 'Settlement allocation differs from immutable payment evidence.';
  end if;
  insert into public.paystack_settlement_events(contribution_id,settlement_id,status,couple_minor,currency,recorded_by)
    values(p_contribution_id,p_settlement_id,p_status,p_couple_minor,p_currency,p_actor_id) on conflict do nothing;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    select wedding_id,p_actor_id,'provider','paystack_settlement_reconciled','paystack_settlement_events',p_contribution_id::text
    from public.contributions where id=p_contribution_id;
  return true;
end $$;

create function public.paystack_finance_summary(p_wedding_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.can_access_wedding(p_wedding_id) then raise exception 'Access denied.'; end if;
  return coalesce((select jsonb_agg(x) from (
    select c.id,c.currency,c.payment_status,e.couple_minor,e.platform_minor,e.provider_fee_minor,
      exists(select 1 from public.paystack_settlement_events s where s.contribution_id=c.id and s.status='success') as provider_settled,
      (select a.status from public.payment_adjustments a where a.contribution_id=c.id order by a.updated_at desc limit 1) as adjustment_status,
      0::bigint as withdrawable_minor
    from public.contributions c left join public.paystack_payment_evidence e on e.contribution_id=c.id
    where c.wedding_id=p_wedding_id and c.settlement_route='paystack_direct' order by c.created_at desc limit 1000
  ) x),'[]'::jsonb);
end $$;

revoke all on function public.begin_live_paystack_publication(uuid,uuid,bigint,text,bigint,uuid,text,text),
  public.paystack_finance_summary(uuid) from public,anon;
grant execute on function public.begin_live_paystack_publication(uuid,uuid,bigint,text,bigint,uuid,text,text),
  public.paystack_finance_summary(uuid) to authenticated;
revoke all on function public.record_paystack_settlement(uuid,text,text,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.record_paystack_settlement(uuid,text,text,bigint,text,uuid) to service_role;
revoke all on function public.record_paystack_publication_adjustment(uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_paystack_publication_adjustment(uuid,text,text,text,bigint,text,timestamptz) to service_role;
revoke all on function public.owner_resolve_paystack_publication(text,text,text,boolean),
  public.admin_paystack_publication_adjustments() from public,anon;
grant execute on function public.owner_resolve_paystack_publication(text,text,text,boolean),
  public.admin_paystack_publication_adjustments() to authenticated;
