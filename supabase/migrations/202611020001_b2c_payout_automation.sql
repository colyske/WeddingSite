-- Separate from collection approval. No activation, funding or auto-approval is seeded.
create table public.b2c_policy (
  singleton boolean primary key default true check (singleton),
  revision integer not null default 1,
  require_four_eyes boolean not null default true,
  auto_approval_limits jsonb,
  dispatch_enabled boolean not null default false,
  activation_reference text,
  shortcode text,
  command_id text,
  contract_reference text,
  payout_fee_minor bigint check (payout_fee_minor >= 0),
  utility_budget_minor bigint check (utility_budget_minor >= 0),
  utility_statement_reference text,
  utility_verified_at timestamptz,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  -- Auto approval is a future explicit decision, not an implicit unlimited policy.
  check (require_four_eyes or auto_approval_limits is not null),
  check (not dispatch_enabled or (
    length(activation_reference) >= 10 and shortcode ~ '^[0-9]{5,7}$'
    and command_id in ('BusinessPayment','SalaryPayment','PromotionPayment')
    and length(contract_reference) >= 10 and payout_fee_minor is not null
    and utility_budget_minor is not null and length(utility_statement_reference)>=10
    and utility_verified_at is not null) is true)
);
insert into public.b2c_policy(singleton) values (true);
alter table public.b2c_policy enable row level security;
revoke all on public.b2c_policy from public, anon, authenticated, service_role;
create table public.b2c_policy_history (
  revision integer primary key,
  old_values jsonb not null,
  new_values jsonb not null,
  reason text not null,
  changed_by uuid not null references public.profiles(id),
  changed_at timestamptz not null default now()
);
alter table public.b2c_policy_history enable row level security;
revoke all on public.b2c_policy_history from public,anon,authenticated,service_role;

create table public.b2c_recipients (
  wedding_id uuid primary key references public.weddings(id) on delete restrict,
  msisdn text not null check (msisdn ~ '^254[17][0-9]{8}$'),
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  statement_reference text not null check (length(statement_reference) between 10 and 240),
  kyc_hash text not null,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  revoked boolean not null default false
);
alter table public.b2c_recipients enable row level security;
revoke all on public.b2c_recipients from public, anon, authenticated, service_role;

create table public.b2c_dispatches (
  id uuid primary key default extensions.gen_random_uuid(),
  payout_id uuid not null unique references public.payout_records(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  idempotency_key uuid not null unique,
  originator_id uuid not null unique,
  callback_hash text not null check (callback_hash ~ '^[0-9a-f]{64}$'),
  msisdn text not null check (msisdn ~ '^254[17][0-9]{8}$'),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor % 100 = 0),
  fee_minor bigint not null check (fee_minor >= 0),
  shortcode text not null,
  command_id text not null,
  policy_revision integer not null,
  state text not null default 'submitting'
    check (state in ('submitting','accepted','uncertain','succeeded','failed')),
  conversation_id text unique,
  transaction_id text unique,
  initiated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.b2c_dispatches enable row level security;
revoke all on public.b2c_dispatches from public, anon, authenticated, service_role;
create table public.b2c_events (
  id bigint generated always as identity primary key,
  dispatch_id uuid not null references public.b2c_dispatches(id),
  event_key text not null,
  kind text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique(dispatch_id, event_key)
);
alter table public.b2c_events enable row level security;
revoke all on public.b2c_events from public, anon, authenticated, service_role;

create function public.guard_b2c_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'B2C: Evidence journals are append-only.';
end $$;
create trigger b2c_events_immutable before update or delete on public.b2c_events
  for each row execute function public.guard_b2c_immutable();
create trigger b2c_policy_history_immutable before update or delete on public.b2c_policy_history
  for each row execute function public.guard_b2c_immutable();
create function public.guard_b2c_dispatch_identity() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' then raise exception 'B2C: Dispatch identity is immutable.'; end if;
  if (to_jsonb(new)-array['state','conversation_id','transaction_id','updated_at']) is distinct from
      (to_jsonb(old)-array['state','conversation_id','transaction_id','updated_at'])
    or old.conversation_id is not null and old.conversation_id is distinct from new.conversation_id
    or old.transaction_id is not null and old.transaction_id is distinct from new.transaction_id
    or old.state in ('succeeded','failed') and new.state is distinct from old.state then
    raise exception 'B2C: Dispatch identity and terminal outcome are immutable.';
  end if;
  return new;
end $$;
create trigger b2c_dispatch_identity before update or delete on public.b2c_dispatches
  for each row execute function public.guard_b2c_dispatch_identity();

create function public.b2c_audit(p_wedding uuid, p_id text, p_action text) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id,changed_fields)
  values(p_wedding,auth.uid(),'b2c',p_action,'b2c_dispatches',p_id,array['state'])
$$;
revoke all on function public.b2c_audit(uuid,text,text) from public, anon, authenticated;

create function public.owner_get_b2c_policy() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff('owner');
  return (select to_jsonb(p) from public.b2c_policy p);
end $$;
create function public.owner_update_b2c_policy(p_revision integer, p_changes jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.b2c_policy;
begin
  perform public.require_staff('owner');
  if p_reason is null or length(btrim(p_reason)) not between 10 and 240
    or p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'B2C: Policy reason and changes required.'; end if;
  select * into p from public.b2c_policy where singleton for update;
  if p_revision is distinct from p.revision then raise exception 'B2C: Stale policy revision.'; end if;
  if exists (select 1 from jsonb_object_keys(p_changes) k where k not in
    ('require_four_eyes','auto_approval_limits','dispatch_enabled','activation_reference','shortcode','command_id',
     'contract_reference','payout_fee_minor','utility_budget_minor','utility_statement_reference')) then raise exception 'B2C: Unknown policy field.'; end if;
  if p_changes ? 'auto_approval_limits' then
    if jsonb_typeof(p_changes->'auto_approval_limits') <> 'object'
      or exists(select 1 from jsonb_object_keys(p_changes->'auto_approval_limits') k
        where k not in ('per_payout_minor','daily_minor','wedding_ids'))
      or coalesce((p_changes->'auto_approval_limits'->>'per_payout_minor')::bigint,0) <= 0
      or coalesce((p_changes->'auto_approval_limits'->>'daily_minor')::bigint,0) <= 0
      or jsonb_typeof(p_changes->'auto_approval_limits'->'wedding_ids') is distinct from 'array'
      or jsonb_array_length(p_changes->'auto_approval_limits'->'wedding_ids') = 0 then
      raise exception 'B2C: Explicit per-payout, daily and wedding scope limits required.';
    end if;
  end if;
  if p_changes ? 'utility_budget_minor' and exists (
    select 1 from public.b2c_dispatches where state in ('submitting','accepted','uncertain')) then
    raise exception 'B2C: Resolve outstanding dispatches before replacing the verified utility budget.';
  end if;
  if p_changes ? 'utility_budget_minor' and coalesce(length(btrim(p_changes->>'utility_statement_reference')),0) not between 10 and 240 then
    raise exception 'B2C: Verified official utility balance statement reference required.';
  end if;
  update public.b2c_policy set
    require_four_eyes = coalesce((p_changes->>'require_four_eyes')::boolean, p.require_four_eyes),
    auto_approval_limits = coalesce(p_changes->'auto_approval_limits',p.auto_approval_limits),
    dispatch_enabled = coalesce((p_changes->>'dispatch_enabled')::boolean, p.dispatch_enabled),
    activation_reference = coalesce(p_changes->>'activation_reference', p.activation_reference),
    shortcode = coalesce(p_changes->>'shortcode', p.shortcode),
    command_id = coalesce(p_changes->>'command_id', p.command_id),
    contract_reference = coalesce(p_changes->>'contract_reference', p.contract_reference),
    payout_fee_minor = coalesce((p_changes->>'payout_fee_minor')::bigint, p.payout_fee_minor),
    utility_budget_minor = coalesce((p_changes->>'utility_budget_minor')::bigint, p.utility_budget_minor),
    utility_statement_reference = coalesce(p_changes->>'utility_statement_reference',p.utility_statement_reference),
    utility_verified_at = case when p_changes ? 'utility_budget_minor' then now() else p.utility_verified_at end,
    revision = p.revision + 1, updated_by = auth.uid(), updated_at = now() where singleton;
  insert into public.audit_events(actor_id,source,action,table_name,record_id,changed_fields)
    values(auth.uid(),'user','b2c_policy:' || btrim(p_reason),'b2c_policy',p.revision::text,
      array(select jsonb_object_keys(p_changes)));
  insert into public.b2c_policy_history(revision,old_values,new_values,reason,changed_by)
    select p.revision+1,to_jsonb(p),to_jsonb(current_policy),btrim(p_reason),auth.uid()
      from public.b2c_policy current_policy where singleton;
  return public.owner_get_b2c_policy();
end $$;

create function public.owner_review_b2c_recipient(p_wedding uuid, p_msisdn text,
  p_contribution uuid, p_statement_reference text, p_revoke boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c public.contributions; w public.weddings;
begin
  perform public.require_staff('owner');
  select * into w from public.weddings where id = p_wedding for update;
  if w.id is null or w.client_owner_id = auth.uid() then raise exception 'B2C: Independent staff review required.'; end if;
  if p_revoke then
    update public.b2c_recipients set revoked = true where wedding_id = p_wedding;
  else
    select * into c from public.contributions where id = p_contribution for share;
    if c.id is null or c.wedding_id <> p_wedding or c.provider_name is distinct from 'daraja'
      or c.payment_environment <> 'live' or c.payment_status <> 'paid'
      or not c.verified_provider_payment or c.provider_payment_reference is null then
      raise exception 'B2C: A verified live inbound M-Pesa receipt is required.';
    end if;
    if p_msisdn is null or p_msisdn !~ '^254[17][0-9]{8}$'
      or p_statement_reference is null or length(btrim(p_statement_reference)) not between 10 and 240
      or not public.kyc_is_complete(p_wedding)
      or not exists (select 1 from public.wedding_kyc k where k.wedding_id = p_wedding
        and (regexp_replace(k.partner1_phone, '[^0-9]', '', 'g') = p_msisdn
          or regexp_replace(k.partner2_phone, '[^0-9]', '', 'g') = p_msisdn)) then
      raise exception 'B2C: Statement proof of MSISDN ownership by a couple partner and complete KYC required.';
    end if;
    insert into public.b2c_recipients(wedding_id,msisdn,contribution_id,statement_reference,kyc_hash,reviewed_by)
      values(p_wedding,p_msisdn,p_contribution,btrim(p_statement_reference),
        (select encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex') from public.wedding_kyc k where wedding_id=p_wedding),auth.uid())
      on conflict(wedding_id) do update set msisdn=excluded.msisdn,contribution_id=excluded.contribution_id,
        statement_reference=excluded.statement_reference,kyc_hash=excluded.kyc_hash,reviewed_by=auth.uid(),reviewed_at=now(),revoked=false;
  end if;
  perform public.b2c_audit(p_wedding,p_wedding::text,case when p_revoke then 'recipient_revoked' else 'recipient_statement_reviewed' end);
  return true;
end $$;

-- Daraja wallet funds only. Paystack (including direct/split) can never fund B2C.
-- Do not import positive adjustments from other providers or from test receipts.
create function public.b2c_available_minor(p_wedding uuid, p_exclude_payout uuid default null)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(c.net_paid_minor-c.provider_fee_minor) from public.contributions c
    where c.wedding_id=p_wedding and c.currency='KES' and c.provider_name='daraja'
      and c.payment_environment='live' and c.settlement_route='platform_wallet'
      and c.payment_status='paid' and c.verified_provider_payment
      and not c.provider_fee_pending and c.provider_fee_minor is not null
      and (c.funds_available_at is null or c.funds_available_at<=now())),0)
    + coalesce((select sum(l.couple_net_delta_minor) from public.financial_adjustment_ledger l
      join public.contributions c on c.id=l.contribution_id
      where l.wedding_id=p_wedding and l.currency='KES' and c.provider_name='daraja'
        and c.payment_environment='live' and c.settlement_route='platform_wallet'),0)
    - coalesce((select sum(a.hold_minor) from public.payment_adjustments a
      join public.contributions c on c.id=a.contribution_id
      where a.wedding_id=p_wedding and a.currency='KES' and c.provider_name='daraja'
        and c.payment_environment='live' and c.settlement_route='platform_wallet'),0)
    - coalesce((select sum(p.amount_minor) from public.payout_records p where p.wedding_id=p_wedding
      and p.currency='KES' and p.status in ('requested','approved','sent')
      and (p_exclude_payout is null or p.id<>p_exclude_payout)),0)
    - coalesce((select sum(d.fee_minor) from public.b2c_dispatches d where d.wedding_id=p_wedding and d.state<>'failed'),0)
    - coalesce((select sum(e.amount_minor) from public.expenses e where e.wedding_id=p_wedding
      and e.currency='KES' and e.status in ('approved','paid')),0)
$$;
revoke all on function public.b2c_available_minor(uuid,uuid) from public, anon, authenticated;

create or replace function public.live_payouts_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select dispatch_enabled from public.b2c_policy where singleton),false)
$$;

create function public.b2c_reserve(p_payout uuid, p_key uuid, p_originator uuid, p_callback_hash text,
  p_shortcode text, p_command text, p_allow_auto boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.payout_records; policy public.b2c_policy; r public.b2c_recipients; d public.b2c_dispatches;
begin
  if auth.role() is distinct from 'service_role' then perform public.require_staff('superadmin'); end if;
  -- Global funding lock, followed by wedding then payout lock, consistent with manual transitions.
  select * into policy from public.b2c_policy where singleton for update;
  if not policy.dispatch_enabled or policy.shortcode is distinct from p_shortcode or policy.command_id is distinct from p_command then
    raise exception 'B2C: Dispatch is disabled or merchant capability is unapproved.';
  end if;
  perform 1 from public.weddings where id=(select wedding_id from public.payout_records where id=p_payout) for update;
  select * into p from public.payout_records where id=p_payout for update;
  select * into d from public.b2c_dispatches where payout_id=p_payout;
  if d.id is not null then return jsonb_build_object('dispatch_id',d.id,'state',d.state,'claimed',false); end if;
  if p.status='requested' and not policy.require_four_eyes and p_allow_auto is true then
    if not coalesce(policy.auto_approval_limits->'wedding_ids' ? p.wedding_id::text,false)
      or p.amount_minor > (policy.auto_approval_limits->>'per_payout_minor')::bigint
      or coalesce((select sum(amount_minor+fee_minor) from public.b2c_dispatches
        where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)
        + p.amount_minor + policy.payout_fee_minor > (policy.auto_approval_limits->>'daily_minor')::bigint
      or policy.updated_by is null or policy.updated_by = p.requested_by then
      raise exception 'B2C: Payout exceeds explicit auto-approval scope or limits.';
    end if;
    update public.payout_records set status='approved',confirmed_by=policy.updated_by,confirmed_at=now()
      where id=p.id returning * into p;
    perform public.b2c_audit(p.wedding_id,p.id::text,'payout_auto_approved:policy_' || policy.revision);
  end if;
  if p.id is null or p.status <> 'approved' or p.currency <> 'KES' or p.amount_minor % 100 <> 0
    or p.requested_by is null or p.confirmed_by is null or p.requested_by = p.confirmed_by
    then raise exception 'B2C: Four-eyes approved whole-KES payout required.'; end if;
  perform 1 from public.wedding_kyc where wedding_id=p.wedding_id for share;
  select * into r from public.b2c_recipients where wedding_id=p.wedding_id and not revoked for share;
  if r.wedding_id is null or not public.kyc_is_complete(p.wedding_id)
    or not exists (select 1 from public.wedding_kyc k where k.wedding_id=p.wedding_id
      and encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')=r.kyc_hash
      and (regexp_replace(k.partner1_phone,'[^0-9]','','g')=r.msisdn
        or regexp_replace(k.partner2_phone,'[^0-9]','','g')=r.msisdn)) then
    raise exception 'B2C: Recipient verification prerequisite missing or stale.';
  end if;
  -- Provider settlement/adjustment RPCs lock the original contribution before changing its journal.
  perform 1 from public.contributions where wedding_id=p.wedding_id for share;
  if public.b2c_available_minor(p.wedding_id,p.id) < p.amount_minor+policy.payout_fee_minor
    or policy.utility_budget_minor < p.amount_minor+policy.payout_fee_minor then
    raise exception 'B2C: Insufficient settled Daraja wallet or verified utility funding after fees and holds.';
  end if;
  insert into public.b2c_dispatches(payout_id,wedding_id,idempotency_key,originator_id,callback_hash,
    msisdn,amount_minor,fee_minor,shortcode,command_id,policy_revision,initiated_by)
    values(p.id,p.wedding_id,p_key,p_originator,p_callback_hash,r.msisdn,p.amount_minor,
      policy.payout_fee_minor,policy.shortcode,policy.command_id,policy.revision,auth.uid()) returning * into d;
  update public.b2c_policy set utility_budget_minor=utility_budget_minor-d.amount_minor-d.fee_minor where singleton;
  perform public.b2c_audit(p.wedding_id,d.id::text,'dispatch_reserved');
  return to_jsonb(d) - 'callback_hash' || jsonb_build_object('claimed',true);
end $$;

-- Managed payouts cannot be cancelled or manually marked sent while money may be in flight.
create function public.guard_b2c_payout() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.b2c_dispatches where payout_id=old.id)
    and new is distinct from old and current_setting('weddingsite.b2c_settlement',true) is distinct from 'on' then
    raise exception 'B2C: Managed payout requires verified reconciliation, not manual status changes.';
  end if;
  return new;
end $$;
create trigger guard_b2c_payout before update on public.payout_records
  for each row execute function public.guard_b2c_payout();

create function public.b2c_apply_event(p_dispatch uuid, p_kind text, p_event_key text, p_evidence jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare d public.b2c_dispatches; next_state text; inserted integer;
begin
  perform 1 from public.b2c_policy where singleton for update;
  perform 1 from public.weddings where id=(select wedding_id from public.b2c_dispatches where id=p_dispatch) for update;
  select * into d from public.b2c_dispatches where id=p_dispatch for update;
  if d.id is null then raise exception 'B2C: Dispatch not found.'; end if;
  if p_event_key is null or length(p_event_key) not between 1 and 160 or p_evidence is null
    or p_kind not in ('accepted','uncertain','result','timeout','reconciliation','rejected') then raise exception 'B2C: Invalid event.'; end if;
  if p_kind='rejected' and p_evidence->>'callback_hash' is distinct from d.callback_hash then
    raise exception 'B2C: Invalid callback capability.';
  end if;
  if p_kind in ('result','timeout') then
    if p_evidence->>'callback_hash' is distinct from d.callback_hash
      or p_evidence->>'originator_id' is distinct from d.originator_id::text
      or d.conversation_id is null or p_evidence->>'conversation_id' is distinct from d.conversation_id then
      raise exception 'B2C: Unauthenticated or uncorrelated callback.';
    end if;
  end if;
  insert into public.b2c_events(dispatch_id,event_key,kind,evidence)
    values(d.id,p_event_key,p_kind,p_evidence - 'callback_hash') on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    perform public.b2c_audit(d.wedding_id,d.id::text,'duplicate_callback_or_event');
    return d.state;
  end if;
  next_state := d.state;
  if d.state in ('succeeded','failed') and p_evidence->>'outcome' in ('succeeded','failed')
    and (p_evidence->>'outcome' is distinct from d.state
      or p_evidence->>'transaction_id' is distinct from d.transaction_id) then
    perform public.b2c_audit(d.wedding_id,d.id::text,'conflicting_terminal_evidence_requires_review');
  end if;
  if d.state not in ('succeeded','failed') then
    if p_kind='accepted' then
      if p_evidence->>'originator_id' is distinct from d.originator_id::text
        or coalesce(length(p_evidence->>'conversation_id'),0) not between 1 and 160 then
        raise exception 'B2C: Uncorrelated acceptance.';
      end if;
      if d.conversation_id is not null and d.conversation_id is distinct from p_evidence->>'conversation_id' then
        raise exception 'B2C: Conversation binding is immutable.';
      end if;
      update public.b2c_dispatches set conversation_id=p_evidence->>'conversation_id' where id=d.id;
      -- Never clear uncertainty by merely learning the provider accepted a request.
      next_state := case when d.state='uncertain' then 'uncertain' else 'accepted' end;
    elsif p_kind in ('uncertain','timeout') then next_state := 'uncertain';
    elsif p_kind in ('result','reconciliation') then
      -- A status-query observation alone is never settlement evidence.
      if p_evidence->>'verified_contract' = 'true' and p_evidence->>'outcome' in ('succeeded','failed')
        and (p_kind='result' or p_evidence->>'mechanism'='official_statement')
        and (p_evidence->>'amount_minor')::bigint = d.amount_minor
        and p_evidence->>'msisdn' = d.msisdn
        and coalesce(length(p_evidence->>'transaction_id'),0) between 1 and 160 then
        next_state := p_evidence->>'outcome';
        update public.b2c_dispatches set transaction_id=p_evidence->>'transaction_id' where id=d.id;
      else next_state := 'uncertain'; end if;
    end if;
  end if;
  update public.b2c_dispatches set state=next_state,updated_at=now() where id=d.id;
  if next_state in ('succeeded','failed') and d.state not in ('succeeded','failed') then
    perform set_config('weddingsite.b2c_settlement','on',true);
    update public.payout_records set status=case when next_state='succeeded' then 'sent' else 'cancelled' end::public.payout_status,
      provider_reference=case when next_state='succeeded' then p_evidence->>'transaction_id' else provider_reference end,
      staff_reason=case when next_state='failed' then 'Verified B2C failure; no automatic retry.' else staff_reason end
      where id=d.payout_id;
    perform set_config('weddingsite.b2c_settlement','off',true);
    -- Failed utility debits are NOT credited optimistically: a fresh verified balance is required.
  end if;
  perform public.b2c_audit(d.wedding_id,d.id::text,'b2c_' || p_kind || ':' || next_state);
  return next_state;
end $$;
revoke all on function public.b2c_apply_event(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.b2c_record_event(p_dispatch uuid, p_kind text, p_event_key text, p_evidence jsonb)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  return public.b2c_apply_event(p_dispatch,p_kind,p_event_key,p_evidence);
end $$;

create function public.b2c_callback_context(p_dispatch uuid, p_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.b2c_dispatches;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  select * into d from public.b2c_dispatches where id=p_dispatch and callback_hash=p_hash;
  if d.id is null then raise exception 'B2C: Invalid callback capability.'; end if;
  return to_jsonb(d) - 'callback_hash';
end $$;
create function public.b2c_status(p_payout uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  return coalesce((select jsonb_agg(to_jsonb(d) - array['callback_hash','msisdn']) from (
    select * from public.b2c_dispatches where p_payout is null or payout_id=p_payout order by created_at desc limit 100
  ) d),'[]'::jsonb);
end $$;

-- An inconclusive observation keeps the reservation. Human resolution requires a provider statement
-- independently proving transaction, recipient, amount and outcome; arbitrary status overrides are forbidden.
create function public.staff_reconcile_b2c(p_dispatch uuid, p_reference text, p_outcome text,
  p_transaction text, p_msisdn text, p_amount bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare d public.b2c_dispatches; result text;
begin
  perform public.require_staff('superadmin');
  select * into d from public.b2c_dispatches where id=p_dispatch;
  if d.id is null or d.initiated_by=auth.uid()
    or p_reference is null or length(btrim(p_reference)) not between 10 and 240
    or p_outcome is null or p_outcome not in ('succeeded','failed','inconclusive') then
    raise exception 'B2C: Independent statement review required.';
  end if;
  result := public.b2c_apply_event(p_dispatch,'reconciliation',extensions.gen_random_uuid()::text,
    jsonb_build_object('verified_contract',p_outcome<>'inconclusive','mechanism','official_statement',
      'reference',p_reference,'outcome',p_outcome,'transaction_id',p_transaction,
      'msisdn',p_msisdn,'amount_minor',p_amount));
  return result;
end $$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'owner_get_b2c_policy()','owner_update_b2c_policy(integer,jsonb,text)',
    'owner_review_b2c_recipient(uuid,text,uuid,text,boolean)',
    'b2c_reserve(uuid,uuid,uuid,text,text,text,boolean)','b2c_status(uuid)',
    'staff_reconcile_b2c(uuid,text,text,text,text,bigint)'
  ] loop
    execute 'revoke all on function public.' || sig || ' from public,anon';
    execute 'grant execute on function public.' || sig || ' to authenticated';
  end loop;
end $$;
revoke all on function public.b2c_record_event(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.b2c_callback_context(uuid,text) from public,anon,authenticated;
grant execute on function public.b2c_record_event(uuid,text,text,jsonb),public.b2c_callback_context(uuid,text) to service_role;
grant execute on function public.b2c_reserve(uuid,uuid,uuid,text,text,text,boolean) to service_role;

create function public.b2c_candidates() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  return coalesce((select jsonb_agg(p.id) from (
    select p.id from public.payout_records p join public.b2c_recipients r on r.wedding_id=p.wedding_id and not r.revoked
      where p.currency='KES' and (p.status='approved' or p.status='requested' and
        not (select require_four_eyes from public.b2c_policy where singleton))
      and not exists(select 1 from public.b2c_dispatches d where d.payout_id=p.id)
      order by p.requested_at limit 1
  ) p),'[]'::jsonb);
end $$;
revoke all on function public.b2c_candidates() from public,anon,authenticated;
grant execute on function public.b2c_candidates() to service_role;
create function public.staff_b2c_controls() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  return (select jsonb_build_object('dispatch_enabled',dispatch_enabled,'require_four_eyes',require_four_eyes,'revision',revision)
    from public.b2c_policy where singleton);
end $$;
revoke all on function public.staff_b2c_controls() from public,anon;
grant execute on function public.staff_b2c_controls() to authenticated;
create function public.b2c_worker_policy() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  return (select jsonb_build_object('dispatch_enabled',dispatch_enabled) from public.b2c_policy where singleton);
end $$;
revoke all on function public.b2c_worker_policy() from public,anon,authenticated;
grant execute on function public.b2c_worker_policy() to service_role;
create function public.b2c_mark_stale() returns integer
language plpgsql security definer set search_path = '' as $$
declare d record; changed integer:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  for d in select id from public.b2c_dispatches where state in ('submitting','accepted')
    and updated_at<now()-interval '30 minutes' loop
    perform public.b2c_apply_event(d.id,'uncertain','stale_dispatch',jsonb_build_object('reason','missing_final_result'));
    changed:=changed+1;
  end loop;
  return changed;
end $$;
revoke all on function public.b2c_mark_stale() from public,anon,authenticated;
grant execute on function public.b2c_mark_stale() to service_role;

-- Revoking admission must not prevent settlement of an already-bound result.
do $$
declare definition text := pg_get_functiondef('public.guard_test_payouts()'::regprocedure);
begin
  definition := replace(definition, 'if new.status',
    'if current_setting(''weddingsite.b2c_settlement'',true)=''on'' and exists(select 1 from public.b2c_dispatches d where d.payout_id=new.id and d.state in (''succeeded'',''failed'')) then return new; end if; if new.status');
  if position('weddingsite.b2c_settlement' in definition)=0 then raise exception 'Expected payout guard missing'; end if;
  execute definition;
end $$;

-- Keep existing request/report surfaces consistent with the new outbound fee reservation.
do $$
declare signature text; definition text;
begin
  foreach signature in array array[
    'public.request_payout(uuid,bigint,text,text,boolean)','public.withdrawable_balance(uuid,text)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    if position('c.payment_environment = ''live''' in definition)=0 then raise exception 'Expected live guard missing in %',signature; end if;
    definition := replace(definition,'c.payment_environment = ''live''',
      'c.payment_environment = ''live'' and c.provider_name = ''daraja'' and c.currency=''KES''');
    definition := replace(definition,'live_payment.payment_environment = ''live''',
      'live_payment.payment_environment = ''live'' and live_payment.provider_name = ''daraja'' and live_payment.currency=''KES''');
    definition := replace(definition,'- coalesce((select sum(p.amount_minor)',
      '- coalesce((select sum(d.fee_minor) from public.b2c_dispatches d where d.wedding_id=p_wedding_id and upper(p_currency)=''KES'' and d.state<>''failed''),0) - coalesce((select sum(p.amount_minor)');
    definition := replace(definition,'- coalesce(payout_reserve, 0)',
      '- coalesce((select sum(d.fee_minor) from public.b2c_dispatches d where d.wedding_id=p_wedding_id and upper(p_currency)=''KES'' and d.state<>''failed''),0) - coalesce(payout_reserve, 0)');
    execute definition;
  end loop;
end $$;
