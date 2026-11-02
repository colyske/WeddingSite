-- Manual external-transfer rehearsal control plane. NO activation path in this release.
-- Never changes live_payouts_enabled(), legacy balances, provider configuration or funds.
create table public.manual_payout_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false check (enabled = false),
  policy_revision uuid not null default extensions.gen_random_uuid(),
  limits_minor bigint,
  fee_policy_reference uuid,
  rail_entitlement_reference uuid,
  secure_evidence_reference uuid,
  check (limits_minor is null or limits_minor > 0)
);
insert into public.manual_payout_policy(singleton) values(true);

-- References are opaque IDs in a separately approved evidence repository, NOT URLs,
-- bank details, names, KYC documents or proof of automatic provider verification.
create table public.manual_payout_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('recipient','custody','settlement','receipt','no_transfer','policy')),
  external_reference uuid not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now()
);
create table public.manual_payout_evidence_checks (
  evidence_id uuid primary key references public.manual_payout_evidence(id),
  checked_by uuid not null references public.profiles(id),
  checked_at timestamptz not null default now()
);
create table public.manual_payout_recipients (
  id uuid primary key default extensions.gen_random_uuid(),
  revision bigint generated always as identity unique,
  wedding_id uuid not null references public.weddings(id),
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  kyc_snapshot_hash text not null,
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
-- One immutable opening custody envelope per account/currency. Refresh/top-ups are
-- deliberately unsupported: replacing a snapshot must not re-credit spent money.
create table public.manual_payout_custody (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  account_reference uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  available_minor bigint not null check (available_minor > 0),
  statement_at timestamptz not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  unique(provider, account_reference, currency)
);
create table public.manual_payout_settlements (
  contribution_id uuid primary key references public.contributions(id),
  custody_id uuid not null references public.manual_payout_custody(id),
  statement_line_reference uuid not null,
  settled_minor bigint not null check (settled_minor > 0),
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  unique(custody_id, statement_line_reference)
);
create table public.manual_payout_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null unique,
  wedding_id uuid not null references public.weddings(id),
  custody_id uuid not null references public.manual_payout_custody(id),
  recipient_revision uuid not null references public.manual_payout_recipients(id),
  amount_minor bigint not null check (amount_minor > 0),
  fee_minor bigint not null check (fee_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now()
);
create table public.manual_payout_events (
  id bigint generated always as identity primary key,
  payout_id uuid not null references public.manual_payout_requests(id),
  state text not null check (state in
    ('requested','approved','executing','uncertain','reported','paid','cancelled','resolution_proposed','not_transferred')),
  actor_id uuid not null references public.profiles(id),
  evidence_id uuid references public.manual_payout_evidence(id),
  created_at timestamptz not null default now(),
  unique(payout_id, state)
);
-- Claim is durable and never expires. The receipt is separate from the paid decision.
create table public.manual_payout_claims (
  payout_id uuid primary key references public.manual_payout_requests(id),
  execution_channel text not null default 'manual_external' check (execution_channel in ('manual_external','automatic_b2c')),
  claim_key uuid not null unique,
  sender_id uuid not null references public.profiles(id),
  claimed_at timestamptz not null default now()
);
create table public.manual_payout_receipts (
  payout_id uuid primary key references public.manual_payout_requests(id),
  provider text not null,
  account_reference uuid not null,
  transaction_reference text not null check (
    transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  actual_minor bigint not null check (actual_minor > 0),
  actual_fee_minor bigint not null check (actual_fee_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transferred_at timestamptz not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  unique(provider, account_reference, transaction_reference)
);

create function public.manual_payout_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Manual payout history is append-only.'; end $$;

do $$
declare t text;
begin
  foreach t in array array['manual_payout_policy','manual_payout_evidence','manual_payout_evidence_checks',
    'manual_payout_recipients','manual_payout_custody','manual_payout_settlements','manual_payout_requests',
    'manual_payout_events','manual_payout_claims','manual_payout_receipts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role',t);
    execute format('create trigger manual_payout_immutable before update or delete on public.%I
      for each row execute function public.manual_payout_immutable()',t);
  end loop;
end $$;

create function public.manual_payouts_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled and limits_minor is not null and fee_policy_reference is not null
    and rail_entitlement_reference is not null and secure_evidence_reference is not null
    from public.manual_payout_policy where singleton),false)
$$;
create function public.manual_payout_require_enabled() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  if not public.manual_payouts_enabled() then
    raise exception 'MANUAL_PAYOUT_BLOCKED: Manual payouts are OFF; policy, secure evidence custody, limits, fees and funded rail entitlement require separate approval.';
  end if;
  -- Serialize manual operations including idempotency before any row locks.
  perform pg_advisory_xact_lock(71110001);
end $$;

create function public.manual_payout_evidence_require(p_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.manual_payout_evidence e
    join public.manual_payout_evidence_checks c on c.evidence_id=e.id
    where e.id=p_id and e.kind=p_kind and c.checked_by<>e.submitted_by) then
    raise exception 'Independently checked manual evidence required.';
  end if;
end $$;

create function public.manual_payout_submit_evidence(p_kind text, p_reference uuid, p_sha256 text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_staff('superadmin');
  if p_kind = 'policy' then perform public.require_staff('owner');
  else perform public.manual_payout_require_enabled(); end if;
  insert into public.manual_payout_evidence(kind,external_reference,sha256,submitted_by)
    values(p_kind,p_reference,p_sha256,auth.uid()) returning id into v_id;
  return v_id;
end $$;
create function public.manual_payout_check_evidence(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.manual_payout_evidence;
begin
  perform public.manual_payout_require_enabled();
  select * into e from public.manual_payout_evidence where id=p_id;
  if not found or e.submitted_by=auth.uid() or e.kind='policy' then
    raise exception 'A different leader must check operational evidence.';
  end if;
  insert into public.manual_payout_evidence_checks(evidence_id,checked_by) values(p_id,auth.uid());
  return true;
end $$;

create function public.manual_payout_recipient(p_wedding uuid, p_evidence uuid, p_provider text, p_currency text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_hash text;
begin
  perform public.manual_payout_require_enabled();
  perform public.manual_payout_evidence_require(p_evidence,'recipient');
  perform 1 from public.weddings where id=p_wedding for update;
  perform 1 from public.wedding_kyc where wedding_id=p_wedding for share;
  if not public.kyc_is_complete(p_wedding) then raise exception 'PAYOUT_KYC_REQUIRED: Complete KYC and consent.'; end if;
  select encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex') into v_hash
    from public.wedding_kyc k where wedding_id=p_wedding;
  insert into public.manual_payout_recipients(wedding_id,evidence_id,provider,currency,kyc_snapshot_hash)
    values(p_wedding,p_evidence,p_provider,p_currency,v_hash) returning id into v_id;
  return v_id;
end $$;

create function public.manual_payout_register_custody(p_provider text, p_account uuid, p_currency text,
  p_available bigint, p_statement_at timestamptz, p_evidence uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.manual_payout_require_enabled();
  perform public.manual_payout_evidence_require(p_evidence,'custody');
  if exists(select 1 from public.payout_records where status<>'cancelled')
      or exists(select 1 from public.expenses)
      or exists(select 1 from public.payment_adjustments) then
    raise exception 'Unmapped historical commitments require an approved custody allocation before opening an envelope.';
  end if;
  if p_statement_at > now() then raise exception 'Future statement is invalid.'; end if;
  insert into public.manual_payout_custody(provider,account_reference,currency,available_minor,statement_at,evidence_id)
    values(p_provider,p_account,p_currency,p_available,p_statement_at,p_evidence) returning id into v_id;
  return v_id;
end $$;

create function public.manual_payout_register_settlement(p_contribution uuid, p_custody uuid,
  p_line uuid, p_settled bigint, p_evidence uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.contributions; a public.manual_payout_custody;
begin
  perform public.manual_payout_require_enabled();
  perform public.manual_payout_evidence_require(p_evidence,'settlement');
  select * into strict a from public.manual_payout_custody where id=p_custody for update;
  select * into strict c from public.contributions where id=p_contribution for update;
  if c.payment_environment<>'live' or c.settlement_route<>'platform_wallet'
    or not c.verified_provider_payment or c.payment_status<>'paid' or c.provider_fee_pending
    or c.provider_fee_minor is null or c.provider_name is distinct from a.provider
    or c.currency<>a.currency or p_settled is null or p_settled<=0
    or p_settled<>c.net_paid_minor-c.provider_fee_minor or c.paid_at is null
    or c.paid_at>a.statement_at then
    raise exception 'Only provider-verified, fee-known, statement-backed custody entitlements qualify.';
  end if;
  if p_settled + coalesce((select sum(settled_minor) from public.manual_payout_settlements
      where custody_id=p_custody),0)>a.available_minor then
    raise exception 'Statement envelope cannot be credited twice or overallocated.';
  end if;
  insert into public.manual_payout_settlements(contribution_id,custody_id,statement_line_reference,settled_minor,evidence_id)
    values(p_contribution,p_custody,p_line,p_settled,p_evidence);
  return true;
end $$;

-- Existing adjustment writers lock contribution BEFORE wedding. Match that order:
-- manual global lock -> custody -> sorted contributions -> wedding -> request/KYC.
create function public.manual_payout_lock(p_custody uuid, p_wedding uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.manual_payout_custody where id=p_custody for update;
  perform 1 from public.contributions where wedding_id=p_wedding order by id for update;
  perform 1 from public.weddings where id=p_wedding for update;
  perform 1 from public.wedding_kyc where wedding_id=p_wedding for share;
end $$;

create function public.manual_payout_state(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select state from public.manual_payout_events where payout_id=p_id order by id desc limit 1
$$;

create function public.manual_payout_eligible(p_wedding uuid, p_custody uuid, p_recipient uuid,
  p_currency text, p_required bigint, p_excluding uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_funds numeric; v_reserved numeric; v_account_reserved numeric; a public.manual_payout_custody;
begin
  select * into strict a from public.manual_payout_custody where id=p_custody;
  if a.currency<>p_currency or p_required is null or p_required<=0 then raise exception 'Invalid amount or currency.'; end if;
  if not public.kyc_is_complete(p_wedding) or not exists(
    select 1 from public.manual_payout_recipients r join public.wedding_kyc k on k.wedding_id=r.wedding_id
    where r.id=p_recipient and r.wedding_id=p_wedding and r.provider=a.provider and r.currency=p_currency
      and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')
      and not exists(select 1 from public.manual_payout_recipients newer
        where newer.wedding_id=p_wedding and newer.provider=r.provider and newer.currency=r.currency and newer.revision>r.revision)
  ) then raise exception 'Recipient revision, KYC or consent changed; request a new revision.'; end if;
  -- Conservative bounded scope: any adjustment or legacy commitment blocks the
  -- whole wedding, rather than inventing fee/refund allocation or double-spending it.
  if exists(select 1 from public.payment_adjustments where wedding_id=p_wedding)
    or exists(select 1 from public.financial_adjustment_ledger where wedding_id=p_wedding)
    or exists(select 1 from public.payout_records where wedding_id=p_wedding and status<>'cancelled')
    or exists(select 1 from public.expenses where wedding_id=p_wedding) then
    raise exception 'Existing adjustments, payouts or expenses require a separately approved allocation.';
  end if;
  select coalesce(sum(s.settled_minor),0) into v_funds
    from public.manual_payout_settlements s join public.contributions c on c.id=s.contribution_id
    where s.custody_id=p_custody and c.wedding_id=p_wedding and c.currency=p_currency
      and c.payment_environment='live' and c.settlement_route='platform_wallet'
      and c.payment_status='paid' and c.verified_provider_payment and not c.provider_fee_pending
      and c.provider_name=a.provider and c.provider_fee_minor is not null
      and s.settled_minor=c.net_paid_minor-c.provider_fee_minor;
  select coalesce(sum(amount_minor::numeric+fee_minor),0) into v_reserved
    from public.manual_payout_requests r where r.wedding_id=p_wedding and r.currency=p_currency
      and r.id is distinct from p_excluding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred');
  select coalesce(sum(amount_minor::numeric+fee_minor),0) into v_account_reserved
    from public.manual_payout_requests r where r.custody_id=p_custody and r.id is distinct from p_excluding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred');
  if v_funds-v_reserved<p_required or a.available_minor-v_account_reserved<p_required then
    raise exception 'Insufficient statement-backed uncommitted custody funds.';
  end if;
end $$;

-- Historical routes cannot certify a payment or become a shortcut into the new
-- workflow. Preserve cancellation and its existing client-visible reason history.
alter function public.admin_set_payout_status(uuid,text,text) rename to legacy_payout_status_internal;
revoke all on function public.legacy_payout_status_internal(uuid,text,text) from public,anon,authenticated,service_role;
create function public.admin_set_payout_status(p_payout_id uuid,p_status text,p_note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  if p_status is distinct from 'cancelled' then
    raise exception 'MANUAL_PAYOUT_BLOCKED: Legacy approvals and Mark sent are retired. Use independently reconciled manual payouts after separate activation.';
  end if;
  return public.legacy_payout_status_internal(p_payout_id,p_status,p_note);
end $$;
revoke all on function public.admin_set_payout_status(uuid,text,text) from public,anon;
grant execute on function public.admin_set_payout_status(uuid,text,text) to authenticated;

create function public.manual_payout_guard_commitment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.weddings where id=new.wedding_id for update;
  if exists(select 1 from public.manual_payout_requests r where r.wedding_id=new.wedding_id
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')) then
    raise exception 'Manual payout commitments require independent allocation before other spending.';
  end if;
  return new;
end $$;
create trigger manual_payout_guard_commitment before insert or update on public.expenses
  for each row execute function public.manual_payout_guard_commitment();
create trigger manual_payout_guard_commitment before insert or update on public.payout_records
  for each row execute function public.manual_payout_guard_commitment();

create function public.manual_payout_request(p_key uuid, p_wedding uuid, p_custody uuid,
  p_recipient uuid, p_amount bigint, p_fee bigint, p_currency text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; v_id uuid;
begin
  perform public.manual_payout_require_enabled();
  select * into r from public.manual_payout_requests where request_key=p_key;
  if found then
    if (r.wedding_id,r.custody_id,r.recipient_revision,r.amount_minor,r.fee_minor,r.currency,r.requested_by)
      is distinct from (p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,auth.uid()) then
      raise exception 'Idempotency key input conflict.';
    end if;
    return r.id;
  end if;
  if p_amount is null or p_amount<=0 or p_fee is null or p_fee<0 then raise exception 'Invalid amount or fee.'; end if;
  perform public.manual_payout_lock(p_custody,p_wedding);
  perform public.manual_payout_eligible(p_wedding,p_custody,p_recipient,p_currency,
    (p_amount::numeric+p_fee)::bigint);
  insert into public.manual_payout_requests(request_key,wedding_id,custody_id,recipient_revision,
    amount_minor,fee_minor,currency,requested_by)
    values(p_key,p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,auth.uid()) returning id into v_id;
  insert into public.manual_payout_events(payout_id,state,actor_id) values(v_id,'requested',auth.uid());
  return v_id;
end $$;

create function public.manual_payout_transition(p_id uuid, p_action text, p_key uuid default null,
  p_evidence uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; v_state text; v_checker uuid; v_sender uuid;
begin
  perform public.manual_payout_require_enabled();
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  perform 1 from public.manual_payout_requests where id=p_id for update;
  v_state:=public.manual_payout_state(p_id);
  select actor_id into v_checker from public.manual_payout_events where payout_id=p_id and state='approved';
  select sender_id into v_sender from public.manual_payout_claims where payout_id=p_id;
  if exists(select 1 from public.manual_payout_claims where payout_id=p_id and execution_channel<>'manual_external') then
    raise exception 'Another execution channel owns this reservation; manual actions cannot resend or resolve it.';
  end if;
  if p_action='approved' and v_state='requested' then
    if auth.uid()=r.requested_by then raise exception 'A different leader must approve.'; end if;
    perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
      (r.amount_minor::numeric+r.fee_minor)::bigint,r.id);
  elsif p_action='executing' then
    if exists(select 1 from public.manual_payout_claims where payout_id=p_id) then
      if v_sender=auth.uid() and exists(select 1 from public.manual_payout_claims
          where payout_id=p_id and claim_key=p_key and execution_channel='manual_external') then return true; end if;
      raise exception 'Transfer already claimed. Never resend.';
    end if;
    if v_state<>'approved' or auth.uid()=v_checker or p_key is null then
      raise exception 'Independent sender and approved request required.';
    end if;
    perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
      (r.amount_minor::numeric+r.fee_minor)::bigint,r.id);
    insert into public.manual_payout_claims(payout_id,claim_key,sender_id) values(p_id,p_key,auth.uid());
  elsif p_action='cancelled' and v_state in ('requested','approved') and v_sender is null then
    null;
  elsif p_action='uncertain' and v_state='executing' and auth.uid()=v_sender then
    null;
  elsif p_action='resolution_proposed' and v_state in ('executing','uncertain') then
    perform public.manual_payout_evidence_require(p_evidence,'no_transfer');
  elsif p_action='not_transferred' and v_state='resolution_proposed' then
    if auth.uid() in (v_sender,r.requested_by) or exists(select 1 from public.manual_payout_events
        where payout_id=p_id and state='resolution_proposed' and actor_id=auth.uid()) then
      raise exception 'Independent no-transfer resolution checker required.';
    end if;
    if p_evidence is distinct from (select evidence_id from public.manual_payout_events
        where payout_id=p_id and state='resolution_proposed') then raise exception 'Resolution evidence changed.'; end if;
    perform public.manual_payout_evidence_require(p_evidence,'no_transfer');
  elsif p_action='paid' and v_state='reported' then
    if auth.uid() in (v_sender,r.requested_by) then raise exception 'Independent reconciler required.'; end if;
    if p_evidence is distinct from (select evidence_id from public.manual_payout_receipts where payout_id=p_id)
      then raise exception 'Receipt evidence changed.'; end if;
    perform public.manual_payout_evidence_require(p_evidence,'receipt');
  else raise exception 'Invalid manual payout transition; reservations remain held.';
  end if;
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id)
    values(p_id,p_action,auth.uid(),p_evidence);
  return true;
end $$;

create function public.manual_payout_report(p_id uuid, p_reference text, p_actual bigint,
  p_fee bigint, p_currency text, p_at timestamptz, p_evidence uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; a public.manual_payout_custody;
begin
  perform public.manual_payout_require_enabled();
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  if public.manual_payout_state(p_id) not in ('executing','uncertain','resolution_proposed') or not exists(
    select 1 from public.manual_payout_claims where payout_id=p_id and sender_id=auth.uid() and execution_channel='manual_external'
  ) then raise exception 'Only the claimed sender can report an existing transfer.'; end if;
  -- Mismatches remain uncertain, never coerced into a success-shaped receipt.
  if p_actual is distinct from r.amount_minor or p_fee is distinct from r.fee_minor or p_currency is distinct from r.currency
    or p_at is null or p_at>now() or p_at<(select claimed_at from public.manual_payout_claims where payout_id=p_id)
    then raise exception 'Receipt mismatch: retain reservation and investigate; do not resend.'; end if;
  if not exists(select 1 from public.manual_payout_evidence where id=p_evidence and kind='receipt'
      and submitted_by=auth.uid()) then raise exception 'Sender receipt/statement evidence required.'; end if;
  select * into strict a from public.manual_payout_custody where id=r.custody_id;
  insert into public.manual_payout_receipts values(p_id,a.provider,a.account_reference,
    upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_evidence);
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id)
    values(p_id,'reported',auth.uid(),p_evidence);
  return true;
end $$;

create function public.manual_payout_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object('enabled',public.manual_payouts_enabled(),'automaticEnabled',public.live_payouts_enabled(),
    'verification','Manual evidence attestation; not automatic provider verification',
    'blockers',jsonb_build_array('Separate live activation approval required','Approved secure evidence custody required',
      'Funded merchant-rail entitlement unconfirmed','Operational limits and fee/refund/hold policy unapproved'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'wedding_id',r.wedding_id,
      'amount_minor',r.amount_minor,'fee_minor',r.fee_minor,'currency',r.currency,'recipient_revision',r.recipient_revision,
      'state',public.manual_payout_state(r.id),'requested_at',r.requested_at,
      'events',(select jsonb_agg(to_jsonb(e) order by e.id) from public.manual_payout_events e where e.payout_id=r.id)))
      from (select * from public.manual_payout_requests order by requested_at desc limit 100) r),'[]'::jsonb));
end $$;

create function public.manual_payout_history(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.weddings
      where id=p_wedding and client_owner_id=auth.uid()) then raise exception 'Access denied.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'amount_minor',r.amount_minor,
    'currency',r.currency,'status',public.manual_payout_state(r.id),'requested_at',r.requested_at))
    from (select * from public.manual_payout_requests where wedding_id=p_wedding
      order by requested_at desc limit 100) r),'[]'::jsonb);
end $$;

-- No direct table access, even service_role. Only explicitly audited RPCs are callable.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature, p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'manual_payout%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
    if f.proname in ('manual_payout_overview','manual_payout_history','manual_payout_submit_evidence','manual_payout_check_evidence',
      'manual_payout_recipient','manual_payout_register_custody','manual_payout_register_settlement',
      'manual_payout_request','manual_payout_transition','manual_payout_report') then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
