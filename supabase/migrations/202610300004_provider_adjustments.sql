-- Verified provider refunds and disputes. No raw webhook bodies are retained.
-- Refunds default to a human-reviewed hold until the Owner chooses who absorbs
-- the original commission/provider fees. Every settlement journal row is immutable.

alter table public.platform_policies add column if not exists refund_fee_allocation text not null default 'manual_review'
  check (refund_fee_allocation in ('manual_review', 'couple', 'platform'));
alter table public.contributions add column if not exists provider_payment_reference text;
alter table public.contributions add column if not exists refund_fee_allocation text not null default 'manual_review'
  check (refund_fee_allocation in ('manual_review', 'couple', 'platform'));
create unique index if not exists contributions_provider_payment_reference_uidx
  on public.contributions (provider_name, provider_payment_reference)
  where provider_payment_reference is not null;

create or replace function public.snapshot_refund_policy()
returns trigger language plpgsql security definer set search_path = '' set row_security = off
as $$
begin
  select refund_fee_allocation into new.refund_fee_allocation
  from public.platform_policies where id;
  return new;
end $$;
drop trigger if exists snapshot_refund_policy on public.contributions;
create trigger snapshot_refund_policy before insert on public.contributions
  for each row execute function public.snapshot_refund_policy();

-- Preserve the payment-intent/transaction identity needed to correlate later
-- provider refund and dispute events with the original contribution.
drop function if exists public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz, text);
create function public.record_verified_payment(
  p_provider text, p_provider_event_id text, p_contribution_id uuid,
  p_amount_minor bigint, p_currency text, p_provider_reference text,
  p_provider_fee_minor bigint, p_provider_paid_at timestamptz,
  p_provider_payment_reference text
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare recorded boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider_payment_reference is not null and length(p_provider_payment_reference) not between 1 and 200 then
    raise exception 'Invalid provider payment reference.';
  end if;
  recorded := public.record_verified_payment(
    p_provider, p_provider_event_id, p_contribution_id, p_amount_minor,
    p_currency, p_provider_reference, p_provider_fee_minor, p_provider_paid_at
  );
  if p_provider_payment_reference is not null then
    update public.contributions set provider_payment_reference = p_provider_payment_reference
    where id = p_contribution_id and provider_name = p_provider
      and (provider_payment_reference is null or provider_payment_reference = p_provider_payment_reference);
    if not found then raise exception 'Provider payment reference conflicts with the verified payment.'; end if;
  end if;
  return recorded;
end $$;
revoke all on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, uuid, bigint, text, text, bigint, timestamptz, text) to service_role;

create table if not exists public.payment_adjustments (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'paystack')),
  adjustment_kind text not null check (adjustment_kind in ('refund', 'dispute')),
  provider_adjustment_id text not null check (length(provider_adjustment_id) between 1 and 200),
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending', 'processed', 'failed', 'open', 'lost', 'won', 'review')),
  hold_minor bigint not null default 0 check (hold_minor >= 0),
  refund_fee_allocation text check (refund_fee_allocation in ('manual_review', 'couple', 'platform')),
  last_event_at timestamptz,
  resolution_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, adjustment_kind, provider_adjustment_id)
);
alter table public.payment_adjustments enable row level security;
revoke all on public.payment_adjustments from public, anon, authenticated;
grant select on public.payment_adjustments to authenticated;
drop policy if exists payment_adjustment_workspace_read on public.payment_adjustments;
create policy payment_adjustment_workspace_read on public.payment_adjustments for select to authenticated
  using (public.can_access_wedding(wedding_id));

create table if not exists public.provider_adjustment_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('stripe', 'paystack')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  provider_adjustment_id text not null check (length(provider_adjustment_id) between 1 and 200),
  provider_payment_reference text check (provider_payment_reference is null or length(provider_payment_reference) <= 200),
  event_type text not null check (length(event_type) between 1 and 100),
  contribution_id uuid references public.contributions(id) on delete restrict,
  wedding_id uuid references public.weddings(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  provider_state text not null check (length(provider_state) between 1 and 40),
  occurred_at timestamptz,
  outcome text not null check (outcome in ('applied', 'held', 'duplicate', 'unmatched', 'out_of_order', 'rejected')),
  reason_code text,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
alter table public.provider_adjustment_events enable row level security;
revoke all on public.provider_adjustment_events from public, anon, authenticated;

create table if not exists public.financial_adjustment_ledger (
  id bigint generated always as identity primary key,
  adjustment_id uuid not null references public.payment_adjustments(id) on delete restrict,
  wedding_id uuid not null references public.weddings(id) on delete restrict,
  contribution_id uuid not null references public.contributions(id) on delete restrict,
  entry_type text not null check (entry_type in ('refund', 'refund_reviewed', 'dispute_debit', 'dispute_reversal')),
  couple_net_delta_minor bigint not null check (couple_net_delta_minor between -100000000000 and 100000000000),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  allocation text check (allocation in ('couple', 'platform', 'provider_verified')),
  provider text not null check (provider in ('stripe', 'paystack')),
  provider_adjustment_id text not null,
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (adjustment_id, entry_type)
);
alter table public.financial_adjustment_ledger enable row level security;
revoke all on public.financial_adjustment_ledger from public, anon, authenticated;
grant select on public.financial_adjustment_ledger to authenticated;
drop policy if exists financial_adjustment_workspace_read on public.financial_adjustment_ledger;
create policy financial_adjustment_workspace_read on public.financial_adjustment_ledger for select to authenticated
  using (public.can_access_wedding(wedding_id));

create or replace function public.prevent_financial_adjustment_ledger_mutation()
returns trigger language plpgsql set search_path = ''
as $$ begin raise exception 'Financial adjustment ledger entries are immutable.'; end $$;
drop trigger if exists financial_adjustment_ledger_immutable on public.financial_adjustment_ledger;
create trigger financial_adjustment_ledger_immutable before update or delete on public.financial_adjustment_ledger
  for each row execute function public.prevent_financial_adjustment_ledger_mutation();

create or replace function public.refund_couple_delta_minor(
  p_refund_minor bigint, p_paid_minor bigint, p_platform_fee_minor bigint,
  p_provider_fee_minor bigint, p_allocation text
) returns bigint language sql immutable set search_path = ''
as $$
  select case
    when p_refund_minor is null or p_paid_minor is null or p_paid_minor < 1
      or p_refund_minor < 1 or p_refund_minor > p_paid_minor
      or p_platform_fee_minor is null or p_provider_fee_minor is null
      or p_platform_fee_minor < 0 or p_provider_fee_minor < 0
      or p_allocation is null or p_allocation not in ('couple', 'platform') then null
    when p_allocation = 'couple' then -p_refund_minor
    else -p_refund_minor + least(p_refund_minor,
      floor((p_platform_fee_minor + p_provider_fee_minor)::numeric * p_refund_minor / p_paid_minor)::bigint)
  end
$$;
revoke all on function public.refund_couple_delta_minor(bigint, bigint, bigint, bigint, text) from public, anon, authenticated;

do $$
begin
  if public.refund_couple_delta_minor(5000, 10000, 500, 200, 'platform') <> -4650
      or public.refund_couple_delta_minor(10000, 10000, 500, 200, 'platform') <> -9300
      or public.refund_couple_delta_minor(5000, 10000, 500, 200, 'couple') <> -5000
      or public.refund_couple_delta_minor(5000, 10000, 500, 200, 'manual_review') is not null
      or public.refund_couple_delta_minor(11000, 10000, 500, 200, 'platform') is not null then
    raise exception 'Refund allocation amount/rounding contract failed.';
  end if;
end $$;

create or replace function public.record_provider_adjustment(
  p_provider text, p_provider_event_id text, p_event_type text,
  p_adjustment_id text, p_payment_reference text, p_amount_minor bigint,
  p_currency text, p_state text, p_occurred_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  c public.contributions;
  a public.payment_adjustments;
  v_kind text;
  v_status text;
  v_hold bigint := 0;
  v_reason text;
  v_delta bigint;
  v_recorded integer;
  v_prior_refunds bigint;
  v_prior_disputes bigint;
  v_review_id text;
  v_refund_allocation text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider is null or p_provider not in ('stripe', 'paystack') or length(coalesce(p_provider_event_id, '')) not between 1 and 200
      or length(coalesce(p_adjustment_id, '')) not between 1 and 200
      or length(coalesce(p_event_type, '')) not between 1 and 100
      or p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 100000000000
      or upper(coalesce(p_currency, '')) !~ '^[A-Z]{3}$'
      or p_state is null or p_state not in ('refund_pending', 'refund_processed', 'refund_failed', 'dispute_open',
        'dispute_withdrawn', 'dispute_reinstated', 'dispute_lost', 'dispute_won', 'review') then
    raise exception 'Invalid provider adjustment event.';
  end if;
  v_kind := case when p_event_type like 'refund.%' or p_event_type like 'charge.refund.%'
    or p_event_type = 'charge.refunded' then 'refund' else 'dispute' end;

  insert into public.provider_adjustment_events (
    provider, provider_event_id, provider_adjustment_id, provider_payment_reference, event_type, amount_minor,
    currency, provider_state, occurred_at, outcome, reason_code
  ) values (p_provider, p_provider_event_id, p_adjustment_id, p_payment_reference, p_event_type, p_amount_minor,
    upper(p_currency), p_state, p_occurred_at, 'rejected', 'processing')
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_recorded = row_count;
  if v_recorded = 0 then return false; end if;

  select * into c from public.contributions
  where provider_name = p_provider and verified_provider_payment and payment_status = 'paid'
    and (provider_payment_reference = p_payment_reference or provider_reference = p_payment_reference)
  order by paid_at desc limit 1 for update;
  if not found or p_payment_reference is null then
    update public.provider_adjustment_events set outcome = 'unmatched', reason_code = 'payment_reference_not_found'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return true;
  end if;
  perform 1 from public.weddings where id = c.wedding_id for update;
  if c.currency <> upper(p_currency) or p_amount_minor > c.paid_amount_minor then
    v_review_id := 'review:' || pg_catalog.encode(extensions.digest(p_provider || p_provider_event_id, 'sha256'), 'hex');
    insert into public.payment_adjustments (
      provider, adjustment_kind, provider_adjustment_id, contribution_id, wedding_id,
      amount_minor, currency, status, hold_minor, refund_fee_allocation, last_event_at, resolution_code
    ) values (p_provider, v_kind, v_review_id, c.id, c.wedding_id,
      c.paid_amount_minor, c.currency, 'review', c.paid_amount_minor,
      case when v_kind = 'refund' then c.refund_fee_allocation else null end,
      p_occurred_at, 'amount_or_currency_mismatch')
    on conflict (provider, adjustment_kind, provider_adjustment_id) do nothing;
    update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
      outcome = 'rejected', reason_code = 'amount_or_currency_mismatch'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return true;
  end if;
  if p_occurred_at is null then
    v_status := 'review'; v_hold := p_amount_minor; v_reason := 'provider_timestamp_missing';
  else
    v_status := case p_state
      when 'refund_pending' then 'pending'
      when 'refund_processed' then 'processed'
      when 'refund_failed' then 'failed'
      when 'dispute_open' then 'open'
      when 'dispute_withdrawn' then 'lost'
      when 'dispute_lost' then 'lost'
      when 'dispute_reinstated' then 'won'
      when 'dispute_won' then 'won'
      else 'review'
    end;
    v_hold := case when v_status in ('pending', 'open', 'review') then p_amount_minor else 0 end;
    v_reason := case when v_status = 'review' then 'provider_state_requires_review' else null end;
  end if;

  insert into public.payment_adjustments (
    provider, adjustment_kind, provider_adjustment_id, contribution_id, wedding_id,
    amount_minor, currency, status, hold_minor, refund_fee_allocation, last_event_at, resolution_code
  ) values (p_provider, v_kind, p_adjustment_id, c.id, c.wedding_id,
    p_amount_minor, upper(p_currency), v_status, v_hold,
    case when v_kind = 'refund' then c.refund_fee_allocation else null end,
    p_occurred_at, v_reason)
  on conflict (provider, adjustment_kind, provider_adjustment_id) do nothing;
  select * into a from public.payment_adjustments
    where provider = p_provider and adjustment_kind = v_kind and provider_adjustment_id = p_adjustment_id
    for update;
  if a.contribution_id <> c.id or a.amount_minor <> p_amount_minor or a.currency <> upper(p_currency) then
    update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
      outcome = 'rejected', reason_code = 'adjustment_identity_conflict'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return true;
  end if;
  v_refund_allocation := coalesce(a.refund_fee_allocation, c.refund_fee_allocation);
  if a.last_event_at is not null and p_occurred_at is not null and p_occurred_at < a.last_event_at then
    update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
      outcome = 'out_of_order', reason_code = 'older_than_latest_provider_event'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return true;
  end if;
  if (v_kind = 'refund' and a.status = 'processed' and p_state <> 'refund_processed')
      or (v_kind = 'dispute' and a.status = 'won' and p_state in ('dispute_withdrawn', 'dispute_lost'))
      or (v_kind = 'dispute' and a.status = 'lost' and p_state = 'dispute_open') then
    update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
      outcome = 'out_of_order', reason_code = 'terminal_adjustment_state'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return true;
  end if;
  if v_kind = 'dispute' and p_state in ('dispute_open', 'dispute_withdrawn', 'dispute_lost') then
    select coalesce(sum(amount_minor), 0) into v_prior_disputes
    from public.payment_adjustments
    where contribution_id = c.id and adjustment_kind = 'dispute'
      and status in ('open', 'lost', 'review') and id <> a.id;
    if v_prior_disputes + p_amount_minor > c.paid_amount_minor then
      update public.payment_adjustments set status = 'review', hold_minor = p_amount_minor,
        last_event_at = p_occurred_at, resolution_code = 'dispute_total_exceeds_verified_payment', updated_at = now()
      where id = a.id;
      update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
        outcome = 'held', reason_code = 'dispute_total_exceeds_verified_payment'
      where provider = p_provider and provider_event_id = p_provider_event_id;
      return true;
    end if;
  end if;

  if p_occurred_at is null or p_state = 'review' then
    v_status := 'review'; v_hold := greatest(a.hold_minor, p_amount_minor);
    v_reason := case when p_occurred_at is null then 'provider_timestamp_missing' else 'provider_state_requires_review' end;
  elsif v_kind = 'refund' and p_state = 'refund_processed' then
    select coalesce(sum(amount_minor), 0) into v_prior_refunds
    from public.payment_adjustments
    where contribution_id = c.id and adjustment_kind = 'refund'
      and status in ('pending', 'processed', 'review') and id <> a.id;
    if v_prior_refunds + p_amount_minor > c.paid_amount_minor then
      v_status := 'review'; v_hold := p_amount_minor; v_reason := 'refund_total_exceeds_verified_payment';
    elsif exists (select 1 from public.financial_adjustment_ledger
      where adjustment_id = a.id and entry_type in ('refund', 'refund_reviewed')) then
      v_status := 'processed'; v_hold := 0; v_reason := null;
    elsif c.provider_fee_pending or c.provider_fee_minor is null or v_refund_allocation = 'manual_review' then
      v_status := 'review'; v_hold := p_amount_minor;
      v_reason := case when c.provider_fee_pending or c.provider_fee_minor is null
        then 'provider_fee_unknown' else 'refund_allocation_requires_admin' end;
    else
      v_delta := public.refund_couple_delta_minor(p_amount_minor, c.paid_amount_minor,
        c.platform_fee_minor, c.provider_fee_minor, v_refund_allocation);
      insert into public.financial_adjustment_ledger (
        adjustment_id, wedding_id, contribution_id, entry_type, couple_net_delta_minor,
        currency, allocation, provider, provider_adjustment_id
      ) values (a.id, c.wedding_id, c.id, 'refund', v_delta, c.currency, v_refund_allocation, p_provider, p_adjustment_id)
      on conflict (adjustment_id, entry_type) do nothing;
      v_status := 'processed'; v_hold := 0; v_reason := null;
    end if;
  elsif v_kind = 'refund' and p_state = 'refund_pending' then
    v_status := 'pending'; v_hold := p_amount_minor; v_reason := null;
  elsif v_kind = 'refund' and p_state = 'refund_failed' then
    v_status := 'failed'; v_hold := 0; v_reason := null;
  elsif v_kind = 'dispute' and p_state = 'dispute_open' then
    v_status := 'open'; v_hold := p_amount_minor; v_reason := null;
  elsif v_kind = 'dispute' and p_state in ('dispute_withdrawn', 'dispute_lost') then
    insert into public.financial_adjustment_ledger (
      adjustment_id, wedding_id, contribution_id, entry_type, couple_net_delta_minor,
      currency, allocation, provider, provider_adjustment_id
    ) values (a.id, c.wedding_id, c.id, 'dispute_debit', -p_amount_minor, c.currency,
      'provider_verified', p_provider, p_adjustment_id)
    on conflict (adjustment_id, entry_type) do nothing;
    v_status := 'lost'; v_hold := 0; v_reason := null;
  elsif v_kind = 'dispute' and p_state in ('dispute_reinstated', 'dispute_won') then
    if exists (select 1 from public.financial_adjustment_ledger
      where adjustment_id = a.id and entry_type = 'dispute_debit') then
      insert into public.financial_adjustment_ledger (
        adjustment_id, wedding_id, contribution_id, entry_type, couple_net_delta_minor,
        currency, allocation, provider, provider_adjustment_id
      ) values (a.id, c.wedding_id, c.id, 'dispute_reversal', p_amount_minor, c.currency,
        'provider_verified', p_provider, p_adjustment_id)
      on conflict (adjustment_id, entry_type) do nothing;
    end if;
    v_status := 'won'; v_hold := 0; v_reason := null;
  else
    v_status := 'review'; v_hold := p_amount_minor; v_reason := 'provider_state_requires_review';
  end if;

  update public.payment_adjustments set status = v_status, hold_minor = v_hold,
    last_event_at = p_occurred_at, resolution_code = v_reason, updated_at = now()
  where id = a.id;
  update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
    outcome = case when v_status = 'review' then 'held' else 'applied' end, reason_code = v_reason
  where provider = p_provider and provider_event_id = p_provider_event_id;
  return true;
end $$;
revoke all on function public.record_provider_adjustment(text, text, text, text, text, bigint, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_provider_adjustment(text, text, text, text, text, bigint, text, text, timestamptz) to service_role;

create or replace function public.admin_get_refund_policy()
returns text language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare result text;
begin
  perform public.require_staff();
  select refund_fee_allocation into result from public.platform_policies where id;
  return result;
end $$;
revoke all on function public.admin_get_refund_policy() from public, anon;
grant execute on function public.admin_get_refund_policy() to authenticated;

create or replace function public.admin_set_refund_policy(p_allocation text, p_confirmed boolean)
returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare old_value text;
begin
  if public.current_platform_role() is distinct from 'owner' then raise exception 'Only the protected Owner can change refund allocation.'; end if;
  if not coalesce(p_confirmed, false) or p_allocation not in ('manual_review', 'couple', 'platform') then
    raise exception 'Choose a valid refund allocation and confirm the policy change.';
  end if;
  select refund_fee_allocation into old_value from public.platform_policies where id for update;
  update public.platform_policies set refund_fee_allocation = p_allocation,
    updated_by = auth.uid(), updated_at = now() where id;
  insert into public.platform_policy_history (changed_by, old_values, new_values)
    values (auth.uid(), jsonb_build_object('refund_fee_allocation', old_value),
      jsonb_build_object('refund_fee_allocation', p_allocation));
  insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
    values (auth.uid(), 'user', 'refund_allocation_policy_update', 'platform_policies', 'true', array['refund_fee_allocation']);
  return true;
end $$;
revoke all on function public.admin_set_refund_policy(text, boolean) from public, anon;
grant execute on function public.admin_set_refund_policy(text, boolean) to authenticated;

create or replace function public.admin_provider_adjustment_queue()
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare result jsonb;
begin
  perform public.require_staff();
  if public.current_platform_role() = 'owner' then
    return jsonb_build_object('count',
      (select count(*) from public.payment_adjustments where status in ('pending', 'open', 'review')) +
      (select count(*) from public.provider_adjustment_events where outcome in ('unmatched', 'out_of_order', 'rejected')));
  end if;
  select jsonb_build_object(
    'count', (select count(*) from public.payment_adjustments where status in ('pending', 'open', 'review')) +
      (select count(*) from public.provider_adjustment_events where outcome in ('unmatched', 'out_of_order', 'rejected')),
    'adjustments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at asc) from (
        select a.id, a.wedding_id, w.couple_names, a.provider, a.adjustment_kind, a.provider_adjustment_id,
          a.amount_minor, a.currency, a.status, a.hold_minor, a.resolution_code, a.created_at,
          a.refund_fee_allocation, a.last_event_at,
          (a.adjustment_kind = 'refund' and a.status = 'review'
            and a.resolution_code in ('refund_allocation_requires_admin', 'provider_fee_unknown')
            and not c.provider_fee_pending and c.provider_fee_minor is not null) as can_resolve
        from public.payment_adjustments a
        join public.weddings w on w.id = a.wedding_id
        join public.contributions c on c.id = a.contribution_id
        where a.status in ('pending', 'open', 'review')
        order by a.created_at asc limit 100
      ) x
    ), '[]'::jsonb),
    'unmatched_events', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.received_at asc) from (
        select e.id, e.provider, e.provider_adjustment_id, e.event_type, e.amount_minor, e.currency,
          e.provider_state, e.provider_payment_reference, e.outcome, e.reason_code, e.received_at,
          (e.outcome = 'unmatched' and e.provider_state = 'refund_processed'
            and e.provider_payment_reference is not null and e.occurred_at is not null
            and (e.event_type like 'refund.%' or e.event_type like 'charge.refund.%'
              or e.event_type = 'charge.refunded')) as can_match
        from public.provider_adjustment_events e
        where e.outcome in ('unmatched', 'out_of_order', 'rejected')
        order by e.received_at asc limit 100
      ) x
    ), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_provider_adjustment_queue() from public, anon;
grant execute on function public.admin_provider_adjustment_queue() to authenticated;

create or replace function public.admin_resolve_provider_refund(
  p_adjustment_id uuid, p_allocation text, p_confirmed boolean
) returns boolean language plpgsql security definer set search_path = '' set row_security = off
as $$
declare a public.payment_adjustments; c public.contributions; v_delta bigint; v_prior_refunds bigint;
begin
  perform public.require_staff();
  if not coalesce(p_confirmed, false) or p_allocation not in ('couple', 'platform') then
    raise exception 'Choose a refund allocation and confirm the resolution.';
  end if;
  select * into a from public.payment_adjustments where id = p_adjustment_id;
  if not found then
    raise exception 'This refund is not awaiting allocation review.';
  end if;
  select * into c from public.contributions where id = a.contribution_id for update;
  if not found then raise exception 'The contribution for this refund was not found.'; end if;
  perform 1 from public.weddings where id = c.wedding_id for update;
  select * into a from public.payment_adjustments where id = p_adjustment_id for update;
  if not found or a.contribution_id <> c.id or a.adjustment_kind <> 'refund' or a.status <> 'review' then
    raise exception 'This refund is not awaiting allocation review.';
  end if;
  if a.resolution_code not in ('refund_allocation_requires_admin', 'provider_fee_unknown') or not exists (
    select 1 from public.provider_adjustment_events e
    where e.provider = a.provider and e.provider_adjustment_id = a.provider_adjustment_id
      and e.provider_state = 'refund_processed' and e.outcome = 'held'
  ) then raise exception 'The provider has not confirmed a completed refund for this record.'; end if;
  if c.provider_fee_pending or c.provider_fee_minor is null then
    raise exception 'Provider fees are not verified; keep this refund on hold until reconciliation.';
  end if;
  if c.refund_fee_allocation <> 'manual_review' and p_allocation <> c.refund_fee_allocation then
    raise exception 'This payment uses its saved refund policy; a later policy change cannot reprice it.';
  end if;
  select coalesce(sum(prior.amount_minor), 0) into v_prior_refunds
    from public.payment_adjustments prior
    where prior.contribution_id = c.id and prior.adjustment_kind = 'refund'
      and prior.status in ('pending', 'processed', 'review') and prior.id <> a.id;
  if v_prior_refunds + a.amount_minor > c.paid_amount_minor then
    raise exception 'Refund total exceeds the verified payment; keep this case on hold.';
  end if;
  if exists (select 1 from public.financial_adjustment_ledger where adjustment_id = a.id and entry_type = 'refund') then
    raise exception 'This refund has already been accounted.';
  end if;
  v_delta := public.refund_couple_delta_minor(a.amount_minor, c.paid_amount_minor,
    c.platform_fee_minor, c.provider_fee_minor, p_allocation);
  insert into public.financial_adjustment_ledger (
    adjustment_id, wedding_id, contribution_id, entry_type, couple_net_delta_minor,
    currency, allocation, provider, provider_adjustment_id, recorded_by
  ) values (a.id, a.wedding_id, a.contribution_id, 'refund_reviewed', v_delta, a.currency,
    p_allocation, a.provider, a.provider_adjustment_id, auth.uid());
  update public.payment_adjustments set status = 'processed', hold_minor = 0,
    refund_fee_allocation = p_allocation, resolution_code = 'admin_allocated', updated_at = now()
  where id = a.id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (a.wedding_id, auth.uid(), 'user', 'provider_refund_allocated_' || p_allocation,
      'payment_adjustments', a.id::text, array['status', 'refund_fee_allocation']);
  return true;
end $$;
revoke all on function public.admin_resolve_provider_refund(uuid, text, boolean) from public, anon;
grant execute on function public.admin_resolve_provider_refund(uuid, text, boolean) to authenticated;

create or replace function public.admin_match_unresolved_refund(
  p_event_id bigint, p_contribution_id uuid, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = '' set row_security = off
as $$
declare e public.provider_adjustment_events; c public.contributions; result_id uuid; v_reason text;
begin
  perform public.require_staff();
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to match a provider event.'; end if;
  select * into e from public.provider_adjustment_events where id = p_event_id for update;
  if not found or e.outcome <> 'unmatched' or e.provider_state <> 'refund_processed'
      or e.event_type not like 'refund.%' and e.event_type not like 'charge.refund.%'
        and e.event_type <> 'charge.refunded'
      or e.occurred_at is null or e.provider_payment_reference is null then
    raise exception 'Only a timestamped, provider-confirmed unmatched refund can be matched.';
  end if;
  select * into c from public.contributions where id = p_contribution_id for update;
  if not found or c.provider_name <> e.provider or not c.verified_provider_payment
      or c.payment_status <> 'paid' or c.currency <> e.currency
      or e.amount_minor > c.paid_amount_minor
      or (c.provider_payment_reference is distinct from e.provider_payment_reference
        and c.provider_reference is distinct from e.provider_payment_reference) then
    raise exception 'The selected payment does not match the provider, reference, currency and amount.';
  end if;
  perform 1 from public.weddings where id = c.wedding_id for update;
  v_reason := case when c.provider_fee_pending or c.provider_fee_minor is null then 'provider_fee_unknown'
    else 'refund_allocation_requires_admin' end;
  insert into public.payment_adjustments (
    provider, adjustment_kind, provider_adjustment_id, contribution_id, wedding_id,
    amount_minor, currency, status, hold_minor, refund_fee_allocation, last_event_at, resolution_code
  ) values (e.provider, 'refund', e.provider_adjustment_id, c.id, c.wedding_id,
    e.amount_minor, e.currency, 'review', e.amount_minor, c.refund_fee_allocation,
    e.occurred_at, v_reason)
  returning id into result_id;
  update public.provider_adjustment_events set contribution_id = c.id, wedding_id = c.wedding_id,
    outcome = 'held', reason_code = 'admin_matched_requires_allocation'
  where id = e.id;
  insert into public.audit_events (wedding_id, actor_id, source, action, table_name, record_id, changed_fields)
    values (c.wedding_id, auth.uid(), 'user', 'provider_refund_matched', 'provider_adjustment_events',
      e.id::text, array['contribution_id', 'outcome']);
  return result_id;
end $$;
revoke all on function public.admin_match_unresolved_refund(bigint, uuid, boolean) from public, anon;
grant execute on function public.admin_match_unresolved_refund(bigint, uuid, boolean) to authenticated;

create or replace function public.withdrawable_balance(p_wedding_id uuid, p_currency text)
returns table (available_minor bigint, settling_minor bigint, held_minor bigint, next_available_at timestamptz)
language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare adjustment_delta bigint; adjustment_hold bigint; reserved_minor bigint; payout_reserve bigint; expense_reserve bigint;
begin
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  select coalesce(sum(c.net_paid_minor - c.provider_fee_minor)
      filter (where c.provider_fee_pending = false and (c.funds_available_at is null or c.funds_available_at <= now())), 0),
    min(c.funds_available_at) filter (where c.funds_available_at > now() and not c.provider_fee_pending)
  into reserved_minor, next_available_at
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment;
  select coalesce(sum(l.couple_net_delta_minor), 0) into adjustment_delta
    from public.financial_adjustment_ledger l where l.wedding_id = p_wedding_id and l.currency = upper(p_currency);
  select coalesce(sum(a.hold_minor), 0) into adjustment_hold
    from public.payment_adjustments a where a.wedding_id = p_wedding_id and a.currency = upper(p_currency);
  select coalesce(sum(c.net_paid_minor), 0) into held_minor
    from public.contributions c where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
      and c.payment_status = 'paid' and c.verified_provider_payment and c.provider_fee_pending;
  held_minor := held_minor + coalesce(adjustment_hold, 0);
  select coalesce(sum(p.amount_minor), 0) into payout_reserve
    from public.payout_records p where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
      and p.status in ('requested', 'approved', 'sent');
  select coalesce(sum(e.amount_minor), 0) into expense_reserve
    from public.expenses e where e.wedding_id = p_wedding_id and e.currency = upper(p_currency)
      and e.status in ('approved', 'paid');
  available_minor := greatest(reserved_minor + coalesce(adjustment_delta, 0)
    - coalesce(payout_reserve, 0) - coalesce(held_minor, 0) - coalesce(expense_reserve, 0), 0);
  select coalesce(sum(c.net_paid_minor - coalesce(c.provider_fee_minor, 0))
    filter (where c.provider_fee_pending = false and c.funds_available_at > now()), 0)
    into settling_minor
  from public.contributions c where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment;
  return next;
end $$;
revoke all on function public.withdrawable_balance(uuid, text) from public, anon;
grant execute on function public.withdrawable_balance(uuid, text) to authenticated;

create or replace function public.request_payout(
  p_wedding_id uuid, p_amount_minor bigint, p_currency text, p_note text, p_confirmed boolean
) returns uuid language plpgsql security definer set search_path = '' set row_security = off
as $$
declare result_id uuid; available_minor bigint; workspace_currency char(3); minimum_minor bigint; maximum_minor bigint;
begin
  if not coalesce(p_confirmed, false) then raise exception 'Explicit confirmation is required to request a payout.'; end if;
  if not public.has_wedding_role(p_wedding_id, array['client']::public.workspace_role[]) then
    raise exception 'Only the Client or protected Owner may request a payout.';
  end if;
  if p_amount_minor < 1 or p_amount_minor > 100000000000 or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid payout amount or currency.';
  end if;
  select currency into workspace_currency from public.weddings where id = p_wedding_id for update;
  if not found or workspace_currency <> upper(p_currency) then raise exception 'Payout currency must match the wedding currency.'; end if;
  select min_payout_minor, max_payout_minor into minimum_minor, maximum_minor from public.platform_policies where id;
  if p_amount_minor < minimum_minor or p_amount_minor > maximum_minor then
    raise exception 'Payout request is outside the configured minimum or maximum.';
  end if;
  select coalesce(sum(c.net_paid_minor - c.provider_fee_minor)
      filter (where c.provider_fee_pending = false and (c.funds_available_at is null or c.funds_available_at <= now())), 0)
    + coalesce((select sum(l.couple_net_delta_minor) from public.financial_adjustment_ledger l
      where l.wedding_id = p_wedding_id and l.currency = upper(p_currency)), 0)
    - coalesce((select sum(a.hold_minor) from public.payment_adjustments a
      where a.wedding_id = p_wedding_id and a.currency = upper(p_currency)), 0)
    - coalesce((select sum(p.amount_minor) from public.payout_records p
      where p.wedding_id = p_wedding_id and p.currency = upper(p_currency)
        and p.status in ('requested', 'approved', 'sent')), 0)
    - coalesce((select sum(e.amount_minor) from public.expenses e
      where e.wedding_id = p_wedding_id and e.currency = upper(p_currency) and e.status in ('approved', 'paid')), 0)
  into available_minor
  from public.contributions c
  where c.wedding_id = p_wedding_id and c.currency = upper(p_currency)
    and c.payment_status = 'paid' and c.verified_provider_payment;
  if p_amount_minor > greatest(available_minor, 0) then
    raise exception 'Payout exceeds the settled net balance after provider fees, refunds, disputes and holds.';
  end if;
  insert into public.payout_records (wedding_id, amount_minor, currency, requested_by, note)
    values (p_wedding_id, p_amount_minor, p_currency, auth.uid(), left(p_note, 240))
    returning id into result_id;
  return result_id;
end $$;
revoke all on function public.request_payout(uuid, bigint, text, text, boolean) from public, anon;
grant execute on function public.request_payout(uuid, bigint, text, text, boolean) to authenticated;

create or replace view public.finance_summary
with (security_invoker = true)
as
with currencies as (
  select id as wedding_id, currency from public.weddings
  union select wedding_id, currency from public.contributions
  union select wedding_id, currency from public.expenses
  union select wedding_id, currency from public.payout_records
  union select wedding_id, currency from public.budget_lines
)
select w.id as wedding_id, currencies.currency,
  0::bigint as pledged_minor,
  coalesce(c.paid_minor, 0) as paid_gross_minor,
  coalesce(c.fees_minor, 0) as platform_fees_minor,
  coalesce(c.net_minor, 0) as net_contributions_minor,
  coalesce(e.proposed_minor, 0) as proposed_expenses_minor,
  coalesce(e.approved_minor, 0) as approved_expenses_minor,
  coalesce(e.paid_minor, 0) as paid_expenses_minor,
  coalesce(p.requested_minor, 0) as requested_payouts_minor,
  coalesce(p.sent_minor, 0) as sent_payouts_minor,
  coalesce(c.net_minor, 0) - coalesce(c.provider_fees_minor, 0)
    - coalesce(c.provider_fee_hold_minor, 0) - coalesce(c.settling_minor, 0)
    + coalesce(a.adjustments_minor, 0) - coalesce(p.requested_minor, 0) - coalesce(p.sent_minor, 0)
    - coalesce(a.holds_minor, 0) - coalesce(e.approved_minor, 0) - coalesce(e.paid_minor, 0) as estimated_unallocated_net_minor,
  coalesce(b.planned_minor, 0) as planned_budget_minor,
  coalesce(b.actual_minor, 0) as actual_budget_minor,
  coalesce(c.provider_fees_minor, 0) as provider_fees_minor,
  coalesce(c.provider_fee_hold_minor, 0) as provider_fee_hold_minor,
  coalesce(c.pending_minor, 0) as pending_checkout_minor,
  coalesce(a.adjustments_minor, 0) as refund_dispute_adjustments_minor,
  coalesce(a.holds_minor, 0) as refund_dispute_holds_minor,
  coalesce(c.settling_minor, 0) as settling_minor
from public.weddings w
join currencies on currencies.wedding_id = w.id
left join lateral (
  select
    sum(paid_amount_minor) filter (where payment_status = 'paid' and verified_provider_payment) as paid_minor,
    sum(platform_fee_minor) filter (where payment_status = 'paid' and verified_provider_payment) as fees_minor,
    sum(net_paid_minor) filter (where payment_status = 'paid' and verified_provider_payment) as net_minor,
    sum(provider_fee_minor) filter (where payment_status = 'paid' and verified_provider_payment) as provider_fees_minor,
    sum(net_paid_minor) filter (where payment_status = 'paid' and verified_provider_payment and provider_fee_pending) as provider_fee_hold_minor,
    sum(net_paid_minor - provider_fee_minor) filter (where payment_status = 'paid' and verified_provider_payment
      and not provider_fee_pending and funds_available_at > now()) as settling_minor,
    sum(pledged_amount_minor) filter (where payment_status = 'pending') as pending_minor
  from public.contributions where wedding_id = w.id and currency = currencies.currency
) c on true
left join lateral (
  select sum(proposed_minor) as proposed_minor, sum(approved_minor) as approved_minor, sum(paid_minor) as paid_minor
  from (
    select sum(amount_minor) filter (where status = 'proposed') proposed_minor,
      sum(amount_minor) filter (where status = 'approved') approved_minor,
      sum(amount_minor) filter (where status = 'paid') paid_minor
    from public.expenses where wedding_id = w.id and currency = currencies.currency
  ) x
) e on true
left join lateral (
  select sum(amount_minor) filter (where status in ('requested', 'approved')) as requested_minor,
    sum(amount_minor) filter (where status = 'sent') as sent_minor
  from public.payout_records where wedding_id = w.id and currency = currencies.currency
) p on true
left join lateral (
  select sum(planned_minor) as planned_minor, sum(actual_minor) as actual_minor
  from public.budget_lines where wedding_id = w.id and currency = currencies.currency
) b on true
left join lateral (
  select (select sum(couple_net_delta_minor) from public.financial_adjustment_ledger
      where wedding_id = w.id and currency = currencies.currency) as adjustments_minor,
    (select sum(hold_minor) from public.payment_adjustments
      where wedding_id = w.id and currency = currencies.currency) as holds_minor
) a on true;
grant select on public.finance_summary to authenticated;

create or replace function public.admin_settlement_overview()
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  perform public.require_staff();
  return jsonb_build_object(
    'available_by_currency', coalesce((select jsonb_object_agg(currency, amount)
      from (select currency, sum(estimated_unallocated_net_minor) amount from public.finance_summary group by currency) x), '{}'::jsonb),
    'adjustments_by_currency', coalesce((select jsonb_object_agg(currency, amount)
      from (select currency, sum(couple_net_delta_minor) amount from public.financial_adjustment_ledger group by currency) x), '{}'::jsonb),
    'refund_dispute_holds_by_currency', coalesce((select jsonb_object_agg(currency, amount)
      from (select currency, sum(hold_minor) amount from public.payment_adjustments group by currency) x), '{}'::jsonb)
  );
end $$;
revoke all on function public.admin_settlement_overview() from public, anon;
grant execute on function public.admin_settlement_overview() to authenticated;

create or replace function public.get_wedding_financial_adjustments(p_wedding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
begin
  if not public.has_wedding_role(p_wedding_id, array['client', 'admin']::public.workspace_role[]) then
    raise exception 'Workspace access denied.';
  end if;
  return jsonb_build_object(
    'adjustments', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc)
      from (
        select id, provider, adjustment_kind, provider_adjustment_id, amount_minor, currency,
          status, hold_minor, resolution_code, created_at
        from public.payment_adjustments where wedding_id = p_wedding_id
        order by created_at desc limit 1000
      ) a
    ), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
      from (
        select id, contribution_id, entry_type, couple_net_delta_minor, currency, allocation,
          provider, provider_adjustment_id, created_at
        from public.financial_adjustment_ledger where wedding_id = p_wedding_id
        order by created_at desc limit 1000
      ) l
    ), '[]'::jsonb)
  );
end $$;
revoke all on function public.get_wedding_financial_adjustments(uuid) from public, anon;
grant execute on function public.get_wedding_financial_adjustments(uuid) to authenticated;
