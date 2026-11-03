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
  kind text not null check (kind in ('account','commitment','statement','recipient','custody','settlement','receipt','reconciliation','no_transfer','policy')),
  external_reference uuid not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now()
);
create table public.manual_payout_evidence_checks (
  evidence_id uuid not null references public.manual_payout_evidence(id),
  checked_by uuid not null references public.profiles(id),
  owner_solo boolean not null default false,
  primary key(evidence_id,checked_by),
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
create table public.manual_payout_accounts (
  id uuid primary key,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  canonical_registry_reference uuid not null unique,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  unique(id,provider)
);
create table public.manual_payout_custody (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,39}$'),
  account_reference uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  available_minor bigint not null check (available_minor >= 0),
  statement_at timestamptz not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  foreign key(account_reference,provider) references public.manual_payout_accounts(id,provider),
  unique(provider, account_reference, currency)
);
create table public.manual_payout_statement_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence bigint generated always as identity unique,
  custody_id uuid not null references public.manual_payout_custody(id),
  previous_batch uuid unique references public.manual_payout_statement_batches(id),
  statement_reference uuid not null,
  statement_at timestamptz not null,
  opening_minor bigint not null check (opening_minor>=0),
  credit_minor bigint not null check (credit_minor>=0),
  debit_minor bigint not null check (debit_minor>=0),
  closing_minor bigint not null check (closing_minor>=0),
  held_minor bigint not null check (held_minor>=0 and held_minor<=closing_minor),
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  statement_digest text not null,
  recorded_by uuid not null references public.profiles(id),
  check (closing_minor::numeric=opening_minor::numeric+credit_minor-debit_minor),
  unique(custody_id,statement_reference),
  unique(custody_id,statement_digest)
);
create unique index manual_payout_first_batch on public.manual_payout_statement_batches(custody_id) where previous_batch is null;
create table public.manual_payout_statement_lines (
  custody_id uuid not null references public.manual_payout_custody(id),
  batch_id uuid not null references public.manual_payout_statement_batches(id),
  line_reference uuid not null,
  source_kind text not null check (source_kind in ('contribution','payout','expense','adjustment','manual_payout','statement_debit')),
  source_id uuid not null,
  amount_minor bigint not null check (amount_minor>=0),
  direction text not null check (direction in ('credit','debit','hold')),
  evidence_id uuid not null references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  primary key(custody_id,line_reference)
);
create table public.manual_payout_settlements (
  contribution_id uuid primary key references public.contributions(id),
  custody_id uuid not null references public.manual_payout_custody(id),
  statement_line_reference uuid not null,
  settled_minor bigint not null check (settled_minor > 0),
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null default auth.uid() references public.profiles(id),
  batch_id uuid not null references public.manual_payout_statement_batches(id),
  settled_at timestamptz not null,
  unique(custody_id, statement_line_reference)
);
-- Each revision binds the current source hash. Never edit a prior allocation.
create table public.manual_payout_source_allocations (
  id bigint generated always as identity primary key,
  source_kind text not null check (source_kind in ('payout','expense','adjustment')),
  source_id uuid not null,
  snapshot_hash text not null,
  custody_id uuid not null references public.manual_payout_custody(id),
  reflected_batch uuid references public.manual_payout_statement_batches(id),
  line_reference uuid,
  booked_at timestamptz,
  debit_minor bigint not null check (debit_minor>=0),
  hold_minor bigint not null check (hold_minor>=0),
  paid_debit boolean not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  unique(source_kind,source_id,snapshot_hash)
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
  owner_solo boolean not null default false,
  requested_at timestamptz not null default now()
);
create table public.manual_payout_events (
  id bigint generated always as identity primary key,
  payout_id uuid not null references public.manual_payout_requests(id),
  state text not null check (state in
    ('requested','approved','executing','uncertain','reported','paid','cancelled','resolution_proposed','not_transferred')),
  actor_id uuid not null references public.profiles(id),
  owner_solo boolean not null default false,
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
create table public.manual_payout_statement_debit_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  custody_id uuid not null references public.manual_payout_custody(id),
  batch_id uuid not null references public.manual_payout_statement_batches(id),
  line_reference uuid not null,
  transaction_reference text not null check (transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  actual_minor bigint not null check (actual_minor>0),
  actual_fee_minor bigint not null check (actual_fee_minor>=0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  booked_at timestamptz not null,
  evidence_id uuid not null references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  unique(custody_id,line_reference),
  unique(custody_id,transaction_reference)
);
create table public.manual_payout_reconciliations (
  payout_id uuid primary key references public.manual_payout_requests(id),
  statement_entry_id uuid not null unique references public.manual_payout_statement_debit_entries(id),
  provider text not null,
  account_reference uuid not null,
  statement_reference uuid not null,
  line_reference uuid not null,
  transaction_reference text not null,
  actual_minor bigint not null check (actual_minor>0),
  actual_fee_minor bigint not null check (actual_fee_minor>=0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  booked_at timestamptz not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  reconciled_by uuid not null references public.profiles(id),
  owner_solo boolean not null,
  reconciled_at timestamptz not null default now(),
  unique(provider,account_reference,statement_reference,line_reference)
);
create table public.manual_payout_statement_debits (
  payout_id uuid primary key references public.manual_payout_reconciliations(payout_id),
  batch_id uuid not null references public.manual_payout_statement_batches(id),
  line_reference uuid not null,
  evidence_id uuid not null unique references public.manual_payout_evidence(id),
  recorded_by uuid not null references public.profiles(id),
  unique(batch_id,line_reference)
);
-- An observation is not a paid decision. Contradictory/late evidence freezes both
-- rails; this release deliberately has no incident-release or history-edit RPC.
create table public.manual_payout_account_holds (
  id uuid primary key default extensions.gen_random_uuid(),
  custody_id uuid not null references public.manual_payout_custody(id),
  payout_id uuid not null references public.manual_payout_requests(id),
  evidence_id uuid references public.manual_payout_evidence(id),
  execution_channel text not null check (execution_channel in ('manual_external','automatic_b2c')),
  authority_actor_id uuid not null references public.profiles(id),
  authority_role_at_observation public.platform_role not null,
  journal_reference uuid,
  journal_sha256 text,
  transaction_reference text check (transaction_reference ~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$'),
  actual_minor bigint check (actual_minor>0),
  actual_fee_minor bigint check (actual_fee_minor>=0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  observed_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique(payout_id,evidence_id),
  unique(payout_id,journal_reference),
  check ((evidence_id is not null and journal_reference is null and journal_sha256 is null)
    or (execution_channel='automatic_b2c' and evidence_id is null and journal_reference is not null
      and journal_sha256 is not null and journal_sha256 ~ '^[0-9a-f]{64}$'))
);

create function public.manual_payout_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Manual payout history is append-only.'; end $$;

do $$
declare t text;
begin
  foreach t in array array['manual_payout_policy','manual_payout_evidence','manual_payout_evidence_checks','manual_payout_accounts',
    'manual_payout_recipients','manual_payout_custody','manual_payout_settlements','manual_payout_requests',
    'manual_payout_events','manual_payout_claims','manual_payout_receipts','manual_payout_reconciliations',
    'manual_payout_statement_batches','manual_payout_statement_lines','manual_payout_source_allocations','manual_payout_statement_debits',
    'manual_payout_account_holds','manual_payout_statement_debit_entries'] loop
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
declare actual_role public.platform_role;
begin
  perform public.require_staff('superadmin');
  perform pg_advisory_xact_lock(71110001);
  -- Locking SELECT observes a concurrent revocation after an advisory-lock wait.
  -- Retain the share lock through COMMIT so authority cannot change mid-write.
  select platform_role into actual_role from public.profiles where id=auth.uid() for share;
  if actual_role is null or actual_role not in ('owner','superadmin') then raise exception 'Staff authority revoked.'; end if;
  if not public.manual_payouts_enabled() then
    raise exception 'MANUAL_PAYOUT_BLOCKED: Manual payouts are OFF; policy, secure evidence custody, limits, fees and funded rail entitlement require separate approval.';
  end if;
end $$;

create function public.manual_payout_evidence_accepted(p_id uuid,p_kind text,p_allow_owner_solo boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.manual_payout_evidence e
    join public.manual_payout_evidence_checks c on c.evidence_id=e.id
    join public.profiles checker on checker.id=c.checked_by
    where e.id=p_id and e.kind=p_kind and checker.platform_role in ('owner','superadmin')
      and (c.checked_by<>e.submitted_by or (p_allow_owner_solo and c.owner_solo and checker.platform_role='owner')))
$$;
create function public.manual_payout_evidence_require(p_id uuid, p_kind text, p_allow_owner_solo boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id in (select checked_by from public.manual_payout_evidence_checks
    where evidence_id=p_id) order by id for share;
  if not public.manual_payout_evidence_accepted(p_id,p_kind,p_allow_owner_solo) then
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
create function public.manual_payout_check_evidence(p_id uuid,p_owner_solo boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare e public.manual_payout_evidence;
begin
  perform public.manual_payout_require_enabled();
  select * into e from public.manual_payout_evidence where id=p_id;
  if p_owner_solo is null or (p_owner_solo and public.current_platform_role()<>'owner') then
    raise exception 'Only protected Owner may explicitly attest evidence solo.';
  end if;
  if not found or (e.submitted_by=auth.uid() and not p_owner_solo) or e.kind='policy' then
    raise exception 'A different leader must check operational evidence.';
  end if;
  insert into public.manual_payout_evidence_checks(evidence_id,checked_by,owner_solo) values(p_id,auth.uid(),p_owner_solo);
  return true;
end $$;

create function public.manual_payout_intake_authority(p_allow_owner_solo boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare actual_role public.platform_role;
begin
  perform pg_advisory_xact_lock(71110001);
  select platform_role into actual_role from public.profiles where id=auth.uid() for share;
  if auth.uid() is null or actual_role is null or actual_role not in ('owner','superadmin')
    or p_allow_owner_solo is null or (p_allow_owner_solo and actual_role<>'owner') then
    raise exception 'Current authorized intake actor required.';
  end if;
end $$;

create function public.manual_payout_recipient_internal(p_wedding uuid, p_evidence uuid, p_provider text, p_currency text,
  p_allow_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_hash text;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'recipient',p_allow_owner_solo);
  perform 1 from public.weddings where id=p_wedding for update;
  perform 1 from public.wedding_kyc where wedding_id=p_wedding for share;
  if not public.kyc_is_complete(p_wedding) then raise exception 'PAYOUT_KYC_REQUIRED: Complete KYC and consent.'; end if;
  select encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex') into v_hash
    from public.wedding_kyc k where wedding_id=p_wedding;
  insert into public.manual_payout_recipients(wedding_id,evidence_id,provider,currency,kyc_snapshot_hash)
    values(p_wedding,p_evidence,p_provider,p_currency,v_hash) returning id into v_id;
  return v_id;
end $$;

create function public.manual_payout_register_account_internal(p_account uuid,p_provider text,p_registry uuid,p_evidence uuid,
  p_allow_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'account',p_allow_owner_solo);
  insert into public.manual_payout_accounts(id,provider,canonical_registry_reference,evidence_id,recorded_by)
    values(p_account,p_provider,p_registry,p_evidence,auth.uid());
  return p_account;
end $$;

create function public.manual_payout_custody_snapshot(p_custody uuid,p_owner_solo boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('batch_id',b.id,'statement_at',b.statement_at,
    'available_minor',b.closing_minor-b.held_minor,'currency',a.currency,
    'provider',a.provider,'account_reference',a.account_reference)
  from public.manual_payout_custody a join public.manual_payout_statement_batches b on b.custody_id=a.id
  where a.id=p_custody and not exists(select 1 from public.manual_payout_statement_batches bad
    where bad.custody_id=a.id and not public.manual_payout_evidence_accepted(bad.evidence_id,
      case when bad.previous_batch is null then 'custody' else 'statement' end,p_owner_solo))
  order by b.sequence desc limit 1
$$;

create function public.manual_payout_append_statement_internal(p_custody uuid,p_previous uuid,p_statement uuid,p_at timestamptz,
  p_opening bigint,p_credit bigint,p_debit bigint,p_closing bigint,p_held bigint,p_evidence uuid,
  p_allow_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare prior public.manual_payout_statement_batches; v_id uuid;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'statement',p_allow_owner_solo);
  perform 1 from public.manual_payout_custody where id=p_custody for update;
  select * into strict prior from public.manual_payout_statement_batches where custody_id=p_custody order by sequence desc limit 1;
  if p_previous is distinct from prior.id or p_opening is distinct from prior.closing_minor
    or p_at is null or p_at<=prior.statement_at or p_at>clock_timestamp() then
    raise exception 'Statement chain, opening balance or time watermark conflict.';
  end if;
  insert into public.manual_payout_statement_batches(custody_id,previous_batch,statement_reference,statement_at,
    opening_minor,credit_minor,debit_minor,closing_minor,held_minor,evidence_id,statement_digest,recorded_by)
    select p_custody,p_previous,p_statement,p_at,p_opening,p_credit,p_debit,p_closing,p_held,p_evidence,e.sha256,auth.uid()
    from public.manual_payout_evidence e where e.id=p_evidence returning id into v_id;
  return v_id;
end $$;

-- A source snapshot is private; only controlled definer RPCs can inspect it.
-- Positive adjustments never add entitlement beyond a verified original credit.
create function public.manual_payout_sources()
returns table(kind text,id uuid,wedding_id uuid,currency text,debit_minor bigint,hold_minor bigint,paid boolean,snapshot_hash text)
language sql stable security definer set search_path = '' as $$
  select 'payout',p.id,p.wedding_id,p.currency::text,
    case when p.status in ('requested','approved','sent') then p.amount_minor else 0 end,
    0::bigint,p.status='sent',encode(extensions.digest(to_jsonb(p)::text,'sha256'),'hex')
    from public.payout_records p
  union all
  select 'expense',e.id,e.wedding_id,e.currency::text,
    case when e.status in ('approved','paid') then e.amount_minor else 0 end,
    0::bigint,e.status='paid',encode(extensions.digest(to_jsonb(e)::text,'sha256'),'hex')
    from public.expenses e
  union all
  select 'adjustment',a.id,a.wedding_id,a.currency::text,greatest(-coalesce(l.delta,0),0)::bigint,
    greatest(a.hold_minor,case when l.delta is null and a.status in ('pending','open','review','processed','lost')
      then a.amount_minor else 0 end)::bigint,
    coalesce(l.delta,0)<0,encode(extensions.digest((to_jsonb(a)||jsonb_build_object('ledger',l.history))::text,'sha256'),'hex')
    from public.payment_adjustments a left join lateral (
      select sum(x.couple_net_delta_minor) as delta,jsonb_agg(to_jsonb(x) order by x.id) as history
      from public.financial_adjustment_ledger x where x.adjustment_id=a.id
    ) l on true
$$;

create function public.manual_payout_record_line(p_batch uuid,p_line uuid,p_kind text,p_source uuid,
  p_amount bigint,p_direction text,p_evidence uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare existing public.manual_payout_statement_lines; custody uuid;
begin
  select custody_id into strict custody from public.manual_payout_statement_batches where id=p_batch;
  select * into existing from public.manual_payout_statement_lines where custody_id=custody and line_reference=p_line;
  if found then
    if (existing.batch_id,existing.source_kind,existing.source_id,existing.amount_minor,existing.direction)
      is distinct from (p_batch,p_kind,p_source,p_amount,p_direction) then
      raise exception 'Canonical statement line already allocated; conflicting evidence remains held.';
    end if;
    return;
  end if;
  insert into public.manual_payout_statement_lines values(custody,p_batch,p_line,p_kind,p_source,p_amount,p_direction,p_evidence,auth.uid());
end $$;

create function public.manual_payout_map_source_internal(p_kind text,p_source uuid,p_custody uuid,p_batch uuid,p_evidence uuid,
  p_line uuid default null,p_at timestamptz default null,p_allow_owner_solo boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
declare s record; b public.manual_payout_statement_batches; v_id bigint; v_debits numeric; v_holds numeric;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'commitment',p_allow_owner_solo);
  select * into strict s from public.manual_payout_sources() where kind=p_kind and id=p_source;
  perform public.manual_payout_lock(p_custody,s.wedding_id);
  -- Read after locking: a concurrent refund/status change must not bind an old snapshot.
  select * into strict s from public.manual_payout_sources() where kind=p_kind and id=p_source;
  if not exists(select 1 from public.manual_payout_custody where id=p_custody and currency=s.currency) then
    raise exception 'Commitment currency/account binding conflict.';
  end if;
  if exists(select 1 from public.manual_payout_source_allocations where source_kind=p_kind
    and source_id=p_source and custody_id<>p_custody) or (p_kind='adjustment' and not exists(
      select 1 from public.payment_adjustments adjustment join public.manual_payout_custody custody
        on custody.provider=adjustment.provider where adjustment.id=p_source and custody.id=p_custody)) then
    raise exception 'Commitment provider/account binding conflict.';
  end if;
  if p_batch is not null then
    select * into strict b from public.manual_payout_statement_batches where id=p_batch and custody_id=p_custody;
    if p_line is null or p_at is null or p_at>b.statement_at or exists(select 1 from public.manual_payout_statement_batches
      where id=b.previous_batch and p_at<=statement_at) then raise exception 'Exact statement line/date watermark required.'; end if;
    if s.debit_minor>0 and not s.paid then raise exception 'Unpaid commitments cannot be declared statement-reflected debits.'; end if;
    select coalesce(sum(amount_minor) filter(where direction='debit'),0),
      coalesce(sum(amount_minor) filter(where direction='hold'),0) into v_debits,v_holds
      from public.manual_payout_statement_lines where batch_id=p_batch and line_reference<>p_line;
    -- Historical paid debits before the opening watermark are already reflected
    -- in the opening available balance; subsequent periods consume debit capacity.
    if (b.previous_batch is not null and v_debits+s.debit_minor>b.debit_minor) or v_holds+s.hold_minor>b.held_minor then
      raise exception 'Statement debit/hold capacity already allocated.';
    end if;
    perform public.manual_payout_record_line(p_batch,p_line,p_kind,p_source,
      (s.debit_minor::numeric+s.hold_minor)::bigint,case when s.debit_minor>0 then 'debit' else 'hold' end,p_evidence);
  end if;
  insert into public.manual_payout_source_allocations(source_kind,source_id,snapshot_hash,custody_id,
    reflected_batch,line_reference,booked_at,debit_minor,hold_minor,paid_debit,evidence_id,recorded_by)
    values(p_kind,p_source,s.snapshot_hash,p_custody,p_batch,p_line,p_at,s.debit_minor,s.hold_minor,s.paid,p_evidence,auth.uid()) returning id into v_id;
  return v_id;
end $$;

create function public.manual_payout_register_statement_debit_internal(p_batch uuid,p_line uuid,p_reference text,
  p_actual bigint,p_fee bigint,p_currency text,p_at timestamptz,p_evidence uuid,
  p_allow_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare b public.manual_payout_statement_batches; a public.manual_payout_custody; used numeric; entry_id uuid;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  select * into strict b from public.manual_payout_statement_batches where id=p_batch;
  select * into strict a from public.manual_payout_custody where id=b.custody_id for update;
  perform public.manual_payout_evidence_require(p_evidence,'statement',p_allow_owner_solo);
  perform public.manual_payout_evidence_require(b.evidence_id,
    case when b.previous_batch is null then 'custody' else 'statement' end,p_allow_owner_solo);
  if b.previous_batch is null or p_line is null or p_at is null or p_at>b.statement_at
    or p_at<=(select statement_at from public.manual_payout_statement_batches where id=b.previous_batch)
    or p_actual is null or p_actual<=0 or p_fee is null or p_fee<0
    or p_currency is distinct from a.currency then
    raise exception 'Registered statement debit requires exact period, currency, amount and fee.';
  end if;
  if exists(select 1 from public.manual_payout_statement_debit_entries where custody_id=a.id
    and (line_reference=p_line or transaction_reference=upper(btrim(p_reference)))) then
    raise exception 'Registered statement debit line/reference must be unique.';
  end if;
  select coalesce(sum(amount_minor),0) into used from public.manual_payout_statement_lines
    where batch_id=b.id and direction='debit';
  if used+p_actual+p_fee>b.debit_minor then raise exception 'Statement debit capacity exceeded.'; end if;
  insert into public.manual_payout_statement_debit_entries(custody_id,batch_id,line_reference,transaction_reference,
    actual_minor,actual_fee_minor,currency,booked_at,evidence_id,recorded_by)
    values(a.id,b.id,p_line,upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_evidence,auth.uid())
    returning id into entry_id;
  perform public.manual_payout_record_line(b.id,p_line,'statement_debit',entry_id,
    (p_actual::numeric+p_fee)::bigint,'debit',p_evidence);
  return entry_id;
end $$;

create function public.manual_payout_guard_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.state='paid' and not exists(
    select 1 from public.manual_payout_reconciliations r
    join public.manual_payout_statement_debits d on d.payout_id=r.payout_id
    join public.manual_payout_statement_debit_entries e on e.id=r.statement_entry_id
    join public.manual_payout_statement_batches b on b.id=e.batch_id
    join public.manual_payout_requests request on request.id=r.payout_id
    join public.manual_payout_custody a on a.id=request.custody_id
    join public.manual_payout_statement_lines l on l.custody_id=a.id and l.line_reference=e.line_reference
    where r.payout_id=new.payout_id and r.reconciled_by=new.actor_id and r.owner_solo=new.owner_solo
      and (r.provider,r.account_reference,r.statement_reference,r.line_reference,r.transaction_reference,
        r.actual_minor,r.actual_fee_minor,r.currency,r.booked_at)
        is not distinct from (a.provider,a.account_reference,b.statement_reference,e.line_reference,e.transaction_reference,
          e.actual_minor,e.actual_fee_minor,e.currency,e.booked_at)
      and e.custody_id=a.id and b.custody_id=a.id and d.batch_id=b.id and d.line_reference=e.line_reference
      and (e.actual_minor,e.actual_fee_minor,e.currency) is not distinct from
        (request.amount_minor,request.fee_minor,request.currency)
      and l.batch_id=b.id and l.source_kind='statement_debit' and l.source_id=e.id and l.direction='debit'
      and l.amount_minor=e.actual_minor::numeric+e.actual_fee_minor
  ) then raise exception 'Paid requires atomically allocated registered statement reconciliation.'; end if;
  return new;
end $$;
create trigger manual_payout_guard_paid before insert on public.manual_payout_events
  for each row execute function public.manual_payout_guard_paid();

create function public.manual_payout_register_custody_internal(p_provider text, p_account uuid, p_currency text,
  p_available bigint, p_statement_at timestamptz, p_evidence uuid,p_held bigint default null,
  p_allow_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'custody',p_allow_owner_solo);
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_accounts
    where id=p_account and provider=p_provider),'account',p_allow_owner_solo);
  if p_statement_at > clock_timestamp() or p_held is null or p_held<0 then raise exception 'Explicit available/held statement funds and valid date required.'; end if;
  insert into public.manual_payout_custody(provider,account_reference,currency,available_minor,statement_at,evidence_id)
    values(p_provider,p_account,p_currency,p_available,p_statement_at,p_evidence) returning id into v_id;
  insert into public.manual_payout_statement_batches(custody_id,statement_reference,statement_at,opening_minor,
    credit_minor,debit_minor,closing_minor,held_minor,evidence_id,statement_digest,recorded_by)
    select v_id,e.external_reference,p_statement_at,(p_available::numeric+p_held)::bigint,0,0,
      (p_available::numeric+p_held)::bigint,p_held,e.id,e.sha256,auth.uid()
    from public.manual_payout_evidence e where id=p_evidence;
  return v_id;
end $$;

create function public.manual_payout_register_settlement_internal(p_contribution uuid, p_custody uuid,
  p_line uuid, p_settled bigint, p_evidence uuid,p_batch uuid default null,p_at timestamptz default null,
  p_allow_owner_solo boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.contributions; a public.manual_payout_custody; b public.manual_payout_statement_batches; prior_at timestamptz;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  perform public.manual_payout_evidence_require(p_evidence,'settlement',p_allow_owner_solo);
  select * into strict a from public.manual_payout_custody where id=p_custody for update;
  select * into strict b from public.manual_payout_statement_batches
    where custody_id=p_custody and (p_batch is null or id=p_batch) order by sequence desc limit 1;
  select statement_at into prior_at from public.manual_payout_statement_batches where id=b.previous_batch;
  select * into strict c from public.contributions where id=p_contribution for update;
  if c.payment_environment<>'live' or c.settlement_route<>'platform_wallet'
    or not c.verified_provider_payment or c.payment_status<>'paid' or c.provider_fee_pending
    or c.provider_fee_minor is null or c.provider_name is distinct from a.provider
    or c.currency<>a.currency or p_settled is null or p_settled<=0
    or p_settled<>c.net_paid_minor-c.provider_fee_minor or c.paid_at is null
    or p_at is null or p_at>b.statement_at or p_at<c.paid_at
    or (prior_at is not null and p_at<=prior_at) then
    raise exception 'Only provider-verified, fee-known, statement-backed custody entitlements qualify.';
  end if;
  if p_settled + coalesce((select sum(settled_minor) from public.manual_payout_settlements
      where batch_id=b.id),0)>(case when b.previous_batch is null then b.closing_minor::numeric+
        coalesce((select sum(prior.debit_minor) from (
          select line_reference,max(debit_minor) as debit_minor from public.manual_payout_source_allocations
            where reflected_batch=b.id and paid_debit group by line_reference) prior),0)
        else b.credit_minor end) then
    raise exception 'Statement envelope cannot be credited twice or overallocated.';
  end if;
  perform public.manual_payout_record_line(b.id,p_line,'contribution',p_contribution,p_settled,'credit',p_evidence);
  insert into public.manual_payout_settlements(contribution_id,custody_id,statement_line_reference,settled_minor,evidence_id,batch_id,settled_at)
    values(p_contribution,p_custody,p_line,p_settled,p_evidence,b.id,p_at);
  return true;
end $$;

-- Existing adjustment writers lock contribution BEFORE wedding. Match that order:
-- manual global lock -> custody -> sorted contributions -> wedding -> request/KYC.
create function public.manual_payout_lock(p_custody uuid, p_wedding uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.manual_payout_custody where id=p_custody for update;
  perform 1 from public.profiles where id in (
    select checked_by from public.manual_payout_evidence_checks
    union select requested_by from public.manual_payout_requests where wedding_id=p_wedding
    union select actor_id from public.manual_payout_events where state='approved'
  ) order by id for share;
  perform 1 from public.contributions where wedding_id=p_wedding order by id for update;
  perform 1 from public.weddings where id=p_wedding for update;
  perform 1 from public.wedding_kyc where wedding_id=p_wedding for share;
end $$;

create function public.manual_payout_state(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select state from public.manual_payout_events where payout_id=p_id order by id desc limit 1
$$;

create function public.manual_payout_hold_account(p_id uuid,p_evidence uuid,p_channel text,p_actor uuid,
  p_reference text default null,p_actual bigint default null,p_fee bigint default null,
  p_currency text default null,p_at timestamptz default null,
  p_journal uuid default null,p_journal_sha256 text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; actor_role public.platform_role; held uuid; original public.manual_payout_account_holds;
begin
  perform pg_advisory_xact_lock(71110001);
  select platform_role into actor_role from public.profiles where id=p_actor for share;
  -- A correlated service observation may freeze even a revoked policy actor's
  -- account. It cannot authorize money movement or pretend to be a human review.
  if actor_role is null or (auth.uid() is not null and
      (actor_role not in ('owner','superadmin') or auth.uid()<>p_actor))
    or (auth.uid() is null and (p_channel is distinct from 'automatic_b2c' or p_journal is null)) then
    raise exception 'Current authorized incident authority required.';
  end if;
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  if not exists(select 1 from public.manual_payout_claims where payout_id=p_id and execution_channel=p_channel)
    or not ((p_evidence is not null and p_journal is null and p_journal_sha256 is null
      and exists(select 1 from public.manual_payout_evidence where id=p_evidence and kind in ('receipt','reconciliation')))
      or (p_channel='automatic_b2c' and p_evidence is null and p_journal is not null
        and p_journal_sha256 is not null and p_journal_sha256 ~ '^[0-9a-f]{64}$')) then
    raise exception 'Claim channel and immutable outcome evidence required for custody hold.';
  end if;
  select * into original from public.manual_payout_account_holds where payout_id=p_id
    and (evidence_id=p_evidence or journal_reference=p_journal);
  if found then
    if (original.execution_channel,original.authority_actor_id,original.transaction_reference,original.actual_minor,
      original.actual_fee_minor,original.currency,original.observed_at,original.journal_sha256)
      is distinct from (p_channel,p_actor,upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_journal_sha256) then
      raise exception 'Incident evidence replay input conflict; original hold remains.';
    end if;
    return original.id;
  end if;
  insert into public.manual_payout_account_holds(custody_id,payout_id,evidence_id,execution_channel,authority_actor_id,
    authority_role_at_observation,journal_reference,journal_sha256,
    transaction_reference,actual_minor,actual_fee_minor,currency,observed_at)
    values(r.custody_id,p_id,p_evidence,p_channel,p_actor,actor_role,p_journal,p_journal_sha256,
      upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at)
    returning id into held;
  return held;
end $$;

create function public.manual_payout_check_amount(p_wedding uuid,p_currency text,p_amount bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare minimum bigint; maximum bigint;
begin
  perform 1 from public.platform_policies where id for share;
  select min_payout_minor,max_payout_minor into minimum,maximum from public.platform_policies where id;
  if not exists(select 1 from public.weddings where id=p_wedding and currency=p_currency) then
    raise exception 'Payout currency must match wedding currency.';
  end if;
  if p_amount is null or minimum is null or maximum is null or p_amount<minimum or p_amount>maximum then
    raise exception 'Payout amount outside configured minimum or maximum.';
  end if;
end $$;

create function public.manual_payout_eligible(p_wedding uuid, p_custody uuid, p_recipient uuid,
  p_currency text, p_required bigint, p_excluding uuid default null,p_owner_solo boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare v_funds numeric; v_reserved numeric; v_account_reserved numeric; a public.manual_payout_custody;
  v_source_wedding numeric; v_source_account numeric; snapshot jsonb;
begin
  select * into strict a from public.manual_payout_custody where id=p_custody;
  if not exists(select 1 from public.weddings where id=p_wedding and currency=p_currency) then
    raise exception 'Payout currency must match wedding currency.';
  end if;
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_accounts where id=a.account_reference),
    'account',p_owner_solo);
  snapshot:=public.manual_payout_custody_snapshot(p_custody,p_owner_solo);
  if snapshot is null then raise exception 'Accepted current custody statement required.'; end if;
  if exists(select 1 from public.manual_payout_account_holds where custody_id=p_custody) then
    raise exception 'Held custody account: contradictory outcome evidence requires separate incident review.';
  end if;
  if exists(select 1 from public.manual_payout_requests pending where pending.custody_id=p_custody
      and pending.id is distinct from p_excluding and public.manual_payout_state(pending.id) in ('uncertain','resolution_proposed')) then
    raise exception 'Uncertain outcome holds this custody account until evidenced resolution or exact receipt.';
  end if;
  perform public.manual_payout_evidence_require(a.evidence_id,'custody',p_owner_solo);
  perform public.manual_payout_evidence_require((select evidence_id from public.manual_payout_recipients where id=p_recipient),
    'recipient',p_owner_solo);
  if a.currency<>p_currency or p_required is null or p_required<=0 then raise exception 'Invalid amount or currency.'; end if;
  if not public.kyc_is_complete(p_wedding) or not exists(
    select 1 from public.manual_payout_recipients r join public.wedding_kyc k on k.wedding_id=r.wedding_id
    where r.id=p_recipient and r.wedding_id=p_wedding and r.provider=a.provider and r.currency=p_currency
      and r.kyc_snapshot_hash=encode(extensions.digest(to_jsonb(k)::text,'sha256'),'hex')
      and not exists(select 1 from public.manual_payout_recipients newer
        where newer.wedding_id=p_wedding and newer.provider=r.provider and newer.currency=r.currency and newer.revision>r.revision)
  ) then raise exception 'Recipient revision, KYC or consent changed; request a new revision.'; end if;
  select coalesce(sum(s.settled_minor),0) into v_funds
    from public.manual_payout_settlements s join public.contributions c on c.id=s.contribution_id
    where s.custody_id=p_custody and c.wedding_id=p_wedding and c.currency=p_currency
      and c.payment_environment='live' and c.settlement_route='platform_wallet'
      and c.payment_status='paid' and c.verified_provider_payment and not c.provider_fee_pending
      and (c.funds_available_at is null or c.funds_available_at<=now())
      and c.provider_name=a.provider and c.provider_fee_minor is not null
      and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',p_owner_solo)
      and s.settled_minor=c.net_paid_minor-c.provider_fee_minor;
  -- Unknown or stale account mappings hold the affected amounts, not all history.
  -- Reflected debits reduce wedding entitlement once, but are already in the bank
  -- available balance. Paid manual amounts remain reserved until explicitly included.
  with sources as (
    select s.*,m.custody_id as mapped_custody,m.reflected_batch
    from public.manual_payout_sources() s left join lateral (
      select x.* from public.manual_payout_source_allocations x
        where x.source_kind=s.kind and x.source_id=s.id and x.snapshot_hash=s.snapshot_hash
          and public.manual_payout_evidence_accepted(x.evidence_id,'commitment',p_owner_solo)
        order by x.id desc limit 1
    ) m on true where s.currency=p_currency
  )
  select coalesce(sum(debit_minor::numeric+hold_minor) filter(where wedding_id=p_wedding
      and (mapped_custody is null or mapped_custody=p_custody)),0),
    coalesce(sum(debit_minor::numeric+hold_minor) filter(where mapped_custody is null
      or (mapped_custody=p_custody and reflected_batch is null)),0)
    into v_source_wedding,v_source_account from sources;
  select coalesce(sum(amount_minor::numeric+fee_minor),0) into v_reserved
    from public.manual_payout_requests r where r.wedding_id=p_wedding and r.custody_id=p_custody and r.currency=p_currency
      and r.id is distinct from p_excluding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred');
  select coalesce(sum(amount_minor::numeric+fee_minor),0) into v_account_reserved
    from public.manual_payout_requests r where r.custody_id=p_custody and r.id is distinct from p_excluding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred')
      and not (public.manual_payout_state(r.id)='paid' and exists(
        select 1 from public.manual_payout_statement_debits d where d.payout_id=r.id
          and public.manual_payout_evidence_accepted(d.evidence_id,'statement',p_owner_solo)));
  if v_funds-v_reserved-v_source_wedding<p_required
      or (snapshot->>'available_minor')::numeric-v_account_reserved-v_source_account<p_required then
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
  -- Existing legacy RPCs may already hold a wedding lock. Never wait here in
  -- reverse order against a manual transaction: fail explicitly and retry.
  if not pg_try_advisory_xact_lock(71110001) then
    raise exception 'Payout accounting is busy; retry the commitment after review.';
  end if;
  if tg_op='UPDATE' and tg_table_name in ('expenses','payout_records') then
    if (new.wedding_id,new.amount_minor,new.currency,new.status,to_jsonb(new)->>'paid_at',to_jsonb(new)->>'confirmed_at')
      is distinct from (old.wedding_id,old.amount_minor,old.currency,old.status,to_jsonb(old)->>'paid_at',to_jsonb(old)->>'confirmed_at')
      and exists(select 1 from public.manual_payout_source_allocations
        where source_kind=case tg_table_name when 'expenses' then 'expense' else 'payout' end
          and source_id=old.id and paid_debit) then
      raise exception 'Recorded paid commitment is immutable; separate incident review required.';
    end if;
  end if;
  perform 1 from public.weddings where id=new.wedding_id for update;
  return new;
end $$;
create trigger manual_payout_guard_commitment before insert or update on public.expenses
  for each row execute function public.manual_payout_guard_commitment();
create trigger manual_payout_guard_commitment before insert or update on public.payout_records
  for each row execute function public.manual_payout_guard_commitment();
create trigger manual_payout_guard_commitment before insert or update on public.payment_adjustments
  for each row execute function public.manual_payout_guard_commitment();
create trigger manual_payout_guard_commitment before insert on public.financial_adjustment_ledger
  for each row execute function public.manual_payout_guard_commitment();

create function public.manual_payout_request(p_key uuid, p_wedding uuid, p_custody uuid,
  p_recipient uuid, p_amount bigint, p_fee bigint, p_currency text,p_owner_solo boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; v_id uuid;
begin
  perform public.manual_payout_require_enabled();
  if p_owner_solo is null or (p_owner_solo and public.current_platform_role()<>'owner') then
    raise exception 'Only protected Owner may explicitly request solo manual execution.';
  end if;
  select * into r from public.manual_payout_requests where request_key=p_key;
  if found then
    if (r.wedding_id,r.custody_id,r.recipient_revision,r.amount_minor,r.fee_minor,r.currency,r.requested_by,r.owner_solo)
      is distinct from (p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,auth.uid(),p_owner_solo) then
      raise exception 'Idempotency key input conflict.';
    end if;
    return r.id;
  end if;
  if p_amount is null or p_amount<=0 or p_fee is null or p_fee<0 then raise exception 'Invalid amount or fee.'; end if;
  perform public.manual_payout_lock(p_custody,p_wedding);
  perform public.manual_payout_check_amount(p_wedding,p_currency,p_amount);
  perform public.manual_payout_eligible(p_wedding,p_custody,p_recipient,p_currency,
    (p_amount::numeric+p_fee)::bigint,null,p_owner_solo);
  insert into public.manual_payout_requests(request_key,wedding_id,custody_id,recipient_revision,
    amount_minor,fee_minor,currency,requested_by,owner_solo)
    values(p_key,p_wedding,p_custody,p_recipient,p_amount,p_fee,p_currency,auth.uid(),p_owner_solo) returning id into v_id;
  insert into public.manual_payout_events(payout_id,state,actor_id,owner_solo) values(v_id,'requested',auth.uid(),p_owner_solo);
  return v_id;
end $$;

create function public.manual_payout_transition(p_id uuid, p_action text, p_key uuid default null,
  p_evidence uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; v_state text; v_checker uuid; v_sender uuid; v_solo boolean;
begin
  perform public.manual_payout_require_enabled();
  select * into strict r from public.manual_payout_requests where id=p_id;
  v_solo:=r.owner_solo and r.requested_by=auth.uid() and public.current_platform_role()='owner';
  if r.owner_solo and not v_solo then raise exception 'Protected Owner owns this explicitly solo manual request.'; end if;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  perform 1 from public.manual_payout_requests where id=p_id for update;
  v_state:=public.manual_payout_state(p_id);
  select actor_id into v_checker from public.manual_payout_events where payout_id=p_id and state='approved';
  select sender_id into v_sender from public.manual_payout_claims where payout_id=p_id;
  if exists(select 1 from public.manual_payout_claims where payout_id=p_id and execution_channel<>'manual_external') then
    raise exception 'Another execution channel owns this reservation; manual actions cannot resend or resolve it.';
  end if;
  if p_action='approved' and v_state='requested' then
    perform public.manual_payout_check_amount(r.wedding_id,r.currency,r.amount_minor);
    if not exists(select 1 from public.profiles where id=r.requested_by and platform_role in ('owner','superadmin')) then
      raise exception 'Requester authority was revoked; cancel before execution.';
    end if;
    if auth.uid()=r.requested_by and not v_solo then raise exception 'A different leader must approve.'; end if;
    perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
      (r.amount_minor::numeric+r.fee_minor)::bigint,r.id,v_solo);
  elsif p_action='executing' then
    if exists(select 1 from public.manual_payout_claims where payout_id=p_id) then
      raise exception 'Transfer already claimed. Inspect recorded outcome; replay is never permission to resend.';
    end if;
    if v_state<>'approved' or (auth.uid()=v_checker and not v_solo) or p_key is null then
      raise exception 'Independent sender and approved request required.';
    end if;
    perform public.manual_payout_check_amount(r.wedding_id,r.currency,r.amount_minor);
    if not exists(select 1 from public.profiles where id=v_checker and platform_role in ('owner','superadmin'))
      or not exists(select 1 from public.profiles where id=r.requested_by and platform_role in ('owner','superadmin')) then
      raise exception 'Approval or requester authority was revoked; do not execute.';
    end if;
    perform public.manual_payout_eligible(r.wedding_id,r.custody_id,r.recipient_revision,r.currency,
      (r.amount_minor::numeric+r.fee_minor)::bigint,r.id,v_solo);
    insert into public.manual_payout_claims(payout_id,claim_key,sender_id) values(p_id,p_key,auth.uid());
  elsif p_action='cancelled' and v_state in ('requested','approved') and v_sender is null then
    null;
  elsif p_action='uncertain' and v_state='executing' and auth.uid()=v_sender then
    null;
  elsif p_action='resolution_proposed' and v_state in ('executing','uncertain') then
    perform public.manual_payout_evidence_require(p_evidence,'no_transfer',v_solo);
  elsif p_action='not_transferred' and v_state='resolution_proposed' then
    if not v_solo and (auth.uid() in (v_sender,r.requested_by) or exists(select 1 from public.manual_payout_events
        where payout_id=p_id and state='resolution_proposed' and actor_id=auth.uid())) then
      raise exception 'Independent no-transfer resolution checker required.';
    end if;
    if p_evidence is distinct from (select evidence_id from public.manual_payout_events
        where payout_id=p_id and state='resolution_proposed') then raise exception 'Resolution evidence changed.'; end if;
    perform public.manual_payout_evidence_require(p_evidence,'no_transfer',v_solo);
  elsif p_action='paid' then
    raise exception 'Explicit statement reconciliation required; a receipt alone cannot declare payment.';
  else raise exception 'Invalid manual payout transition; reservations remain held.';
  end if;
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id,owner_solo)
    values(p_id,p_action,auth.uid(),p_evidence,v_solo);
  return true;
end $$;

create function public.manual_payout_finalize_reconciliation_internal(p_id uuid,p_channel text,p_provider text,p_account uuid,
  p_statement uuid,p_line uuid,p_reference text,p_actual bigint,p_fee bigint,p_currency text,p_at timestamptz,
  p_evidence uuid,p_allow_owner_solo boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; receipt public.manual_payout_receipts; sender uuid; solo boolean;
  b public.manual_payout_statement_batches; entry public.manual_payout_statement_debit_entries; a public.manual_payout_custody;
begin
  perform public.manual_payout_intake_authority(p_allow_owner_solo);
  select * into strict r from public.manual_payout_requests where id=p_id;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  solo:=p_channel='manual_external' and p_allow_owner_solo and r.owner_solo
    and r.requested_by=auth.uid() and public.current_platform_role()='owner';
  if r.owner_solo and not solo then raise exception 'Protected Owner owns this explicitly solo manual request.'; end if;
  select sender_id into sender from public.manual_payout_claims
    where payout_id=p_id and execution_channel=p_channel;
  if sender is null or public.manual_payout_state(p_id)<>'reported' then
    raise exception 'Reported claimed transfer for the exact channel required for reconciliation.';
  end if;
  if not solo and auth.uid() in (sender,r.requested_by) then raise exception 'Independent reconciler required.'; end if;
  select * into strict receipt from public.manual_payout_receipts where payout_id=p_id;
  perform public.manual_payout_evidence_require(receipt.evidence_id,'receipt',solo);
  perform public.manual_payout_evidence_require(p_evidence,'reconciliation',solo);
  if (p_provider,p_account,upper(btrim(p_reference)),p_actual,p_fee,p_currency) is distinct from
      (receipt.provider,receipt.account_reference,receipt.transaction_reference,receipt.actual_minor,receipt.actual_fee_minor,receipt.currency)
      or (receipt.actual_minor,receipt.actual_fee_minor,receipt.currency) is distinct from (r.amount_minor,r.fee_minor,r.currency)
      or p_at is null or p_at<receipt.transferred_at or p_at>clock_timestamp() then
    raise exception 'Statement debit/account/reference/amount/fee/currency/date mismatch; retain reservation.';
  end if;
  select * into strict a from public.manual_payout_custody where id=r.custody_id;
  select * into b from public.manual_payout_statement_batches
    where custody_id=r.custody_id and statement_reference=p_statement;
  if not found or b.previous_batch is null or (a.provider,a.account_reference,a.currency)
    is distinct from (p_provider,p_account,p_currency) then
    raise exception 'Registered statement batch for exact custody account/currency required.';
  end if;
  perform public.manual_payout_evidence_require(b.evidence_id,'statement',solo);
  select * into entry from public.manual_payout_statement_debit_entries
    where custody_id=r.custody_id and batch_id=b.id and line_reference=p_line;
  if not found or (entry.transaction_reference,entry.actual_minor,entry.actual_fee_minor,entry.currency,entry.booked_at)
    is distinct from (upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at)
    or p_at>b.statement_at or p_at<=(select statement_at from public.manual_payout_statement_batches where id=b.previous_batch) then
    raise exception 'Exact registered statement debit line/reference/amount/fee/currency/date required.';
  end if;
  perform public.manual_payout_evidence_require(entry.evidence_id,'statement',solo);
  if not exists(select 1 from public.manual_payout_statement_lines where custody_id=r.custody_id and batch_id=b.id
    and line_reference=p_line and source_kind='statement_debit' and source_id=entry.id and direction='debit'
    and amount_minor=p_actual::numeric+p_fee)
    or (select coalesce(sum(amount_minor),0) from public.manual_payout_statement_lines
      where batch_id=b.id and direction='debit')>b.debit_minor then
    raise exception 'Canonical statement debit line or capacity conflict.';
  end if;
  insert into public.manual_payout_reconciliations(payout_id,statement_entry_id,provider,account_reference,statement_reference,line_reference,
    transaction_reference,actual_minor,actual_fee_minor,currency,booked_at,evidence_id,reconciled_by,owner_solo)
    values(p_id,entry.id,p_provider,p_account,p_statement,p_line,upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_evidence,auth.uid(),solo);
  insert into public.manual_payout_statement_debits values(p_id,b.id,p_line,entry.evidence_id,auth.uid());
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id,owner_solo)
    values(p_id,'paid',auth.uid(),p_evidence,solo);
  return true;
end $$;

create function public.manual_payout_reconcile(p_id uuid,p_provider text,p_account uuid,p_statement uuid,p_line uuid,
  p_reference text,p_actual bigint,p_fee bigint,p_currency text,p_at timestamptz,p_evidence uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.manual_payout_require_enabled();
  return public.manual_payout_finalize_reconciliation_internal(p_id,'manual_external',p_provider,p_account,
    p_statement,p_line,p_reference,p_actual,p_fee,p_currency,p_at,p_evidence,public.current_platform_role()='owner');
end $$;

create function public.manual_payout_report(p_id uuid, p_reference text, p_actual bigint,
  p_fee bigint, p_currency text, p_at timestamptz, p_evidence uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.manual_payout_requests; a public.manual_payout_custody; v_state text;
begin
  perform public.manual_payout_require_enabled();
  select * into strict r from public.manual_payout_requests where id=p_id;
  if r.owner_solo and (r.requested_by<>auth.uid() or public.current_platform_role()<>'owner') then
    raise exception 'Protected Owner owns this explicitly solo manual request.';
  end if;
  perform public.manual_payout_lock(r.custody_id,r.wedding_id);
  if not exists(
    select 1 from public.manual_payout_claims where payout_id=p_id and sender_id=auth.uid() and execution_channel='manual_external'
  ) then raise exception 'Only the claimed sender can report an existing transfer.'; end if;
  if not exists(select 1 from public.manual_payout_evidence where id=p_evidence and kind='receipt'
      and submitted_by=auth.uid()) then raise exception 'Sender receipt/statement evidence required.'; end if;
  if p_actual is null or p_actual<=0 or p_fee is null or p_fee<0 or p_currency is null or p_currency !~ '^[A-Z]{3}$'
    or p_reference is null or upper(btrim(p_reference)) !~ '^[A-Z0-9][A-Z0-9._:-]{0,119}$' or p_at is null then
    raise exception 'Explicit valid actual receipt fields required.';
  end if;
  select * into strict a from public.manual_payout_custody where id=r.custody_id;
  v_state:=public.manual_payout_state(p_id);
  if exists(select 1 from public.manual_payout_receipts old where old.payout_id=p_id
    and (old.transaction_reference,old.actual_minor,old.actual_fee_minor,old.currency,old.transferred_at,old.evidence_id)
      is not distinct from (upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_evidence)) then return true; end if;
  -- Commit the hold instead of throwing (which would roll the safety record back).
  if p_actual is distinct from r.amount_minor or p_fee is distinct from r.fee_minor or p_currency is distinct from r.currency
    or p_at>clock_timestamp() or p_at<(select claimed_at from public.manual_payout_claims where payout_id=p_id)
    or v_state not in ('executing','uncertain','resolution_proposed')
    or exists(select 1 from public.manual_payout_receipts old where old.provider=a.provider
      and old.account_reference=a.account_reference and old.transaction_reference=upper(btrim(p_reference))) then
    perform public.manual_payout_hold_account(p_id,p_evidence,'manual_external',auth.uid(),
      p_reference,p_actual,p_fee,p_currency,p_at);
    return false;
  end if;
  insert into public.manual_payout_receipts values(p_id,a.provider,a.account_reference,
    upper(btrim(p_reference)),p_actual,p_fee,p_currency,p_at,p_evidence);
  insert into public.manual_payout_events(payout_id,state,actor_id,evidence_id,owner_solo)
    values(p_id,'reported',auth.uid(),p_evidence,r.owner_solo);
  return true;
end $$;

create function public.manual_payout_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_staff('superadmin');
  return jsonb_build_object('enabled',public.manual_payouts_enabled(),'automaticEnabled',public.live_payouts_enabled(),
    'heldAccounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'custody_id',custody_id,
      'payout_id',payout_id,'recorded_at',recorded_at)) from public.manual_payout_account_holds),'[]'::jsonb),
    'verification','Manual evidence attestation; not automatic provider verification',
    'blockers',jsonb_build_array('Separate live activation approval required','Approved secure evidence custody required',
      'Funded merchant-rail entitlement unconfirmed','Operational limits and fee/refund/hold policy unapproved'),
    'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'wedding_id',r.wedding_id,
      'amount_minor',r.amount_minor,'fee_minor',r.fee_minor,'currency',r.currency,'recipient_revision',r.recipient_revision,
      'state',public.manual_payout_state(r.id),'requested_at',r.requested_at,'owner_solo',r.owner_solo,
      'events',(select jsonb_agg(to_jsonb(e) order by e.id) from public.manual_payout_events e where e.payout_id=r.id)))
      from (select * from public.manual_payout_requests order by requested_at desc limit 100) r),'[]'::jsonb));
end $$;

create function public.manual_payout_history(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.weddings
      where id=p_wedding and client_owner_id=auth.uid()) then raise exception 'Access denied.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'amount_minor',r.amount_minor,
    'currency',r.currency,'status',public.manual_payout_state(r.id),'requested_at',r.requested_at,'owner_solo',r.owner_solo))
    from (select * from public.manual_payout_requests where wedding_id=p_wedding
      order by requested_at desc limit 100) r),'[]'::jsonb);
end $$;

create function public.manual_payout_balance(p_wedding uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare backing numeric; reserved numeric; spent numeric; obligations numeric; unknown_funds numeric; v_currency text;
begin
  select w.currency into v_currency from public.weddings w where id=p_wedding and client_owner_id=auth.uid();
  if auth.uid() is null or v_currency is null then raise exception 'Access denied.'; end if;
  select coalesce(sum(s.settled_minor),0) into backing
    from public.manual_payout_settlements s join public.contributions c on c.id=s.contribution_id
    where c.wedding_id=p_wedding and c.currency=v_currency and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.payment_status='paid' and c.verified_provider_payment
      and not c.provider_fee_pending and c.provider_fee_minor is not null
      and (c.funds_available_at is null or c.funds_available_at<=now())
      and s.settled_minor=c.net_paid_minor-c.provider_fee_minor
      and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',true);
  select coalesce(sum(r.amount_minor::numeric+r.fee_minor) filter(where public.manual_payout_state(r.id)<>'paid'),0),
    coalesce(sum(r.amount_minor::numeric+r.fee_minor) filter(where public.manual_payout_state(r.id)='paid'),0)
    into reserved,spent from public.manual_payout_requests r where r.wedding_id=p_wedding
      and public.manual_payout_state(r.id) not in ('cancelled','not_transferred');
  select coalesce(sum(s.debit_minor::numeric+s.hold_minor),0) into obligations
    from public.manual_payout_sources() s where s.wedding_id=p_wedding and s.currency=v_currency;
  select coalesce(sum(c.net_paid_minor),0) into unknown_funds from public.contributions c
    where c.wedding_id=p_wedding and c.currency=v_currency and c.payment_environment='live'
      and c.settlement_route='platform_wallet' and c.verified_provider_payment and c.payment_status='paid'
      and not exists(select 1 from public.manual_payout_settlements s where s.contribution_id=c.id
        and not c.provider_fee_pending and c.provider_fee_minor is not null
        and (c.funds_available_at is null or c.funds_available_at<=now())
        and public.manual_payout_evidence_accepted(s.evidence_id,'settlement',true));
  return jsonb_build_object('currency',v_currency,'enabled',public.manual_payouts_enabled(),
    'available_minor',0,'statement_backed_minor',backing,'reserved_minor',reserved,'spent_minor',spent,
    'known_obligations_minor',obligations,'unknown_or_held_minor',unknown_funds,
    'nonwithdrawable_estimate_minor',greatest(backing-reserved-spent-obligations,0),
    'status','OFF: no live activation path; estimate is not spendable or a transfer promise');
end $$;

-- No direct table access, even service_role. Only explicitly audited RPCs are callable.
-- Channel-neutral intake validators remain private. Public manual wrappers retain
-- their own OFF gate; a separately reviewed rail may reuse validators, never tables.
do $$
declare f record; arguments text; names text;
begin
  for f in select p.oid,p.proname,p.proargnames,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('manual_payout_recipient_internal','manual_payout_register_account_internal',
      'manual_payout_append_statement_internal','manual_payout_map_source_internal',
      'manual_payout_register_custody_internal','manual_payout_register_settlement_internal',
      'manual_payout_register_statement_debit_internal') loop
    arguments:=regexp_replace(pg_get_function_arguments(f.oid),', p_allow_owner_solo boolean DEFAULT false$','');
    if arguments=pg_get_function_arguments(f.oid) or f.proargnames[f.pronargs]<>'p_allow_owner_solo' then
      raise exception 'Unexpected shared intake signature: %',f.proname;
    end if;
    select string_agg(quote_ident(x),',' order by i) into names
      from unnest(f.proargnames[1:f.pronargs-1]) with ordinality a(x,i);
    execute format($wrapper$
      create function public.%I(%s) returns %s language plpgsql security definer set search_path = '' as $body$
      begin
        perform public.manual_payout_require_enabled();
        return public.%I(%s,public.current_platform_role()='owner');
      end $body$;
    $wrapper$,regexp_replace(f.proname,'_internal$',''),arguments,pg_get_function_result(f.oid),f.proname,names);
  end loop;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature, p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'manual_payout%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
    if f.proname in ('manual_payout_overview','manual_payout_history','manual_payout_balance','manual_payout_submit_evidence','manual_payout_check_evidence',
      'manual_payout_recipient','manual_payout_register_custody','manual_payout_register_settlement',
      'manual_payout_request','manual_payout_transition','manual_payout_report','manual_payout_reconcile',
      'manual_payout_register_account','manual_payout_append_statement','manual_payout_map_source',
      'manual_payout_register_statement_debit') then
      execute format('grant execute on function %s to authenticated',f.signature);
    end if;
  end loop;
end $$;
