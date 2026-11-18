-- Normalized verified adjustments only. The caller verifies the signature and,
-- for live Paystack, independently verifies the admitted payment before staging.
-- No raw webhook, customer details, provider secret or signature is stored.
create table public.verified_adjustment_inbox (
  id uuid primary key default extensions.gen_random_uuid(),
  provider text not null check (provider in ('stripe','paystack')),
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (length(event_type) between 1 and 100),
  adjustment_id text not null check (length(adjustment_id) between 1 and 200),
  payment_reference text check (payment_reference is null or length(payment_reference)<=200),
  amount_minor bigint not null check (amount_minor between 1 and 100000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_state text not null check (provider_state in ('refund_pending','refund_processed',
    'refund_failed','dispute_open','dispute_withdrawn','dispute_reinstated','dispute_lost','dispute_won','review')),
  occurred_at timestamptz,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  unique(provider,event_id)
);
create table public.verified_adjustment_inbox_conflicts (
  inbox_id uuid not null references public.verified_adjustment_inbox(id),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_type text not null,
  adjustment_id text not null,
  payment_reference text,
  amount_minor bigint not null,
  currency text not null,
  provider_state text not null,
  occurred_at timestamptz,
  conflict_kind text not null check (conflict_kind in
    ('changed_delivery','legacy_event_mismatch','adjustment_identity_mismatch')),
  observed_at timestamptz not null default clock_timestamp(),
  primary key(inbox_id,payload_sha256,conflict_kind)
);
create table public.verified_adjustment_inbox_processed (
  inbox_id uuid primary key references public.verified_adjustment_inbox(id),
  processed_at timestamptz not null default clock_timestamp()
);
create table public.verified_adjustment_inbox_attempts (
  id bigint generated always as identity primary key,
  inbox_id uuid not null references public.verified_adjustment_inbox(id),
  attempted_at timestamptz not null default clock_timestamp()
);
do $$ declare name text; begin
  foreach name in array array['verified_adjustment_inbox','verified_adjustment_inbox_conflicts',
    'verified_adjustment_inbox_processed','verified_adjustment_inbox_attempts'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);
    execute format('create trigger verified_adjustment_inbox_immutable before update or delete on public.%I
      for each row execute function public.referral_immutable()',name);
  end loop;
end $$;

create function public.stage_verified_adjustment(
  p_provider text,p_event_id text,p_event_type text,p_adjustment_id text,p_payment_reference text,
  p_amount_minor bigint,p_currency text,p_state text,p_occurred_at timestamptz,p_payload_sha256 text
) returns jsonb language plpgsql security definer set search_path='' set row_security=off as $$
declare item public.verified_adjustment_inbox;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  if p_provider is null or p_provider not in ('stripe','paystack')
    or length(coalesce(p_event_id,'')) not between 1 and 200
    or length(coalesce(p_event_type,'')) not between 1 and 100
    or length(coalesce(p_adjustment_id,'')) not between 1 and 200
    or length(coalesce(p_payment_reference,''))>200 or p_amount_minor is null
    or p_amount_minor not between 1 and 100000000000
    or coalesce(p_currency,'') !~ '^[A-Z]{3}$'
    or p_state is null or p_state not in ('refund_pending','refund_processed','refund_failed',
      'dispute_open','dispute_withdrawn','dispute_reinstated','dispute_lost','dispute_won','review')
    or coalesce(p_payload_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'ADJUSTMENT_INBOX: Invalid verified observation.';
  end if;
  -- Intake uses only the inbox lock, never the accounting lock or source rows.
  perform pg_advisory_xact_lock(71110002);
  insert into public.verified_adjustment_inbox(provider,event_id,event_type,adjustment_id,
    payment_reference,amount_minor,currency,provider_state,occurred_at,payload_sha256)
    values(p_provider,p_event_id,p_event_type,p_adjustment_id,p_payment_reference,
      p_amount_minor,p_currency,p_state,p_occurred_at,p_payload_sha256)
    on conflict(provider,event_id) do nothing;
  select * into strict item from public.verified_adjustment_inbox
    where provider=p_provider and event_id=p_event_id for update;
  if (item.event_type,item.adjustment_id,item.payment_reference,item.amount_minor,item.currency,
      item.provider_state,item.occurred_at,item.payload_sha256)
    is distinct from (p_event_type,p_adjustment_id,p_payment_reference,p_amount_minor,p_currency,
      p_state,p_occurred_at,p_payload_sha256) then
    insert into public.verified_adjustment_inbox_conflicts(inbox_id,payload_sha256,event_type,
      adjustment_id,payment_reference,amount_minor,currency,provider_state,occurred_at,conflict_kind)
      values(item.id,p_payload_sha256,p_event_type,p_adjustment_id,p_payment_reference,
        p_amount_minor,p_currency,p_state,p_occurred_at,'changed_delivery') on conflict do nothing;
  end if;
  return jsonb_build_object('id',item.id,'conflict',exists(
    select 1 from public.verified_adjustment_inbox_conflicts where inbox_id=item.id));
end $$;

create function public.process_verified_adjustment(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
declare item public.verified_adjustment_inbox; previous public.provider_adjustment_events;
  other public.verified_adjustment_inbox;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  select * into item from public.verified_adjustment_inbox where id=p_id for update;
  if not found then raise exception 'ADJUSTMENT_INBOX: Observation not found.'; end if;
  if exists(select 1 from public.verified_adjustment_inbox_conflicts where inbox_id=item.id) then
    return jsonb_build_object('processed',false,'conflict',true);
  end if;
  if exists(select 1 from public.verified_adjustment_inbox_processed where inbox_id=item.id) then
    return jsonb_build_object('processed',true,'replayed',true);
  end if;
  select * into previous from public.provider_adjustment_events
    where provider=item.provider and provider_event_id=item.event_id;
  if found and (previous.event_type,previous.provider_adjustment_id,previous.provider_payment_reference,
    previous.amount_minor,previous.currency::text,previous.provider_state,previous.occurred_at)
    is distinct from (item.event_type,item.adjustment_id,item.payment_reference,
      item.amount_minor,item.currency,item.provider_state,item.occurred_at) then
    insert into public.verified_adjustment_inbox_conflicts(inbox_id,payload_sha256,event_type,
      adjustment_id,payment_reference,amount_minor,currency,provider_state,occurred_at,conflict_kind)
      values(item.id,item.payload_sha256,previous.event_type,previous.provider_adjustment_id,
        previous.provider_payment_reference,previous.amount_minor,previous.currency,
        previous.provider_state,previous.occurred_at,'legacy_event_mismatch') on conflict do nothing;
    return jsonb_build_object('processed',false,'conflict',true);
  end if;
  -- Paystack event IDs are raw-payload digests. Different lifecycle events may
  -- share an adjustment ID, but must not change its amount, currency or payment.
  select * into other from public.verified_adjustment_inbox candidate
    where candidate.id<>item.id and candidate.provider=item.provider
      and candidate.adjustment_id=item.adjustment_id
      and (candidate.event_type like 'refund.%' or candidate.event_type like 'charge.refund.%'
        or candidate.event_type='charge.refunded')
        = (item.event_type like 'refund.%' or item.event_type like 'charge.refund.%'
          or item.event_type='charge.refunded')
      and (candidate.payment_reference,candidate.amount_minor,candidate.currency)
        is distinct from (item.payment_reference,item.amount_minor,item.currency)
    order by candidate.received_at,candidate.id limit 1;
  if found then
    insert into public.verified_adjustment_inbox_conflicts(inbox_id,payload_sha256,event_type,
      adjustment_id,payment_reference,amount_minor,currency,provider_state,occurred_at,conflict_kind)
      values(item.id,other.payload_sha256,other.event_type,other.adjustment_id,other.payment_reference,
        other.amount_minor,other.currency,other.provider_state,other.occurred_at,'adjustment_identity_mismatch')
      on conflict do nothing;
    return jsonb_build_object('processed',false,'conflict',true);
  end if;
  select * into previous from public.provider_adjustment_events event
    where event.provider=item.provider and event.provider_adjustment_id=item.adjustment_id
      and (event.event_type like 'refund.%' or event.event_type like 'charge.refund.%'
        or event.event_type='charge.refunded')
        = (item.event_type like 'refund.%' or item.event_type like 'charge.refund.%'
          or item.event_type='charge.refunded')
      and (event.provider_payment_reference,event.amount_minor,event.currency::text)
        is distinct from (item.payment_reference,item.amount_minor,item.currency)
    order by event.received_at,event.id limit 1;
  if found then
    insert into public.verified_adjustment_inbox_conflicts(inbox_id,payload_sha256,event_type,
      adjustment_id,payment_reference,amount_minor,currency,provider_state,occurred_at,conflict_kind)
      values(item.id,item.payload_sha256,previous.event_type,previous.provider_adjustment_id,
        previous.provider_payment_reference,previous.amount_minor,previous.currency,previous.provider_state,
        previous.occurred_at,'adjustment_identity_mismatch') on conflict do nothing;
    return jsonb_build_object('processed',false,'conflict',true);
  end if;
  perform public.record_provider_adjustment(item.provider,item.event_id,item.event_type,item.adjustment_id,
    item.payment_reference,item.amount_minor,item.currency,item.provider_state,item.occurred_at);
  insert into public.verified_adjustment_inbox_processed(inbox_id) values(item.id);
  return jsonb_build_object('processed',true,'replayed',false);
end $$;

-- A later facilitator payout implementation must hold both locks, in this
-- order, while checking this function and creating any financial exposure.
create function public.verified_adjustment_inbox_clear_for_payout() returns boolean
language sql stable security definer set search_path='' set row_security=off as $$
  select not exists(select 1 from public.verified_adjustment_inbox_conflicts)
    and not exists(select 1 from public.verified_adjustment_inbox i
      where not exists(select 1 from public.verified_adjustment_inbox_processed p where p.inbox_id=i.id))
$$;

create function public.admin_verified_adjustment_conflicts() returns jsonb
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  perform public.require_staff('superadmin');
  insert into public.audit_events(actor_id,source,action,table_name,record_id)
    values(auth.uid(),'user','verified_adjustment_conflicts_read','verified_adjustment_inbox_conflicts','queue');
  return coalesce((select jsonb_agg(to_jsonb(rowdata) order by rowdata.observed_at desc) from (
    select i.id,i.provider,i.event_id,i.event_type as original_event_type,
      i.adjustment_id as original_adjustment_id,i.payment_reference as original_payment_reference,
      i.amount_minor::text as original_amount_minor,i.currency as original_currency,
      i.provider_state as original_state,i.occurred_at as original_occurred_at,
      i.payload_sha256 as original_payload_sha256,c.event_type,c.adjustment_id,c.payment_reference,
      c.amount_minor::text as amount_minor,c.currency,c.provider_state,c.occurred_at,
      c.payload_sha256,c.conflict_kind,c.observed_at,
      exists(select 1 from public.verified_adjustment_inbox_processed p where p.inbox_id=i.id) as previously_processed
    from public.verified_adjustment_inbox_conflicts c
    join public.verified_adjustment_inbox i on i.id=c.inbox_id
    order by c.observed_at desc limit 100
  ) rowdata),'[]'::jsonb);
end $$;

create function public.note_verified_adjustment_failure(p_id uuid) returns void
language plpgsql security definer set search_path='' set row_security=off as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  insert into public.verified_adjustment_inbox_attempts(inbox_id) values(p_id);
end $$;

create function public.pending_verified_adjustments() returns jsonb
language plpgsql stable security definer set search_path='' set row_security=off as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required.'; end if;
  return jsonb_build_object('conflicts',(select count(distinct inbox_id)
    from public.verified_adjustment_inbox_conflicts),
    'ids',coalesce((select jsonb_agg(id order by last_attempt,id) from (
    select i.id,coalesce((select max(a.attempted_at) from public.verified_adjustment_inbox_attempts a
      where a.inbox_id=i.id),i.received_at) as last_attempt from public.verified_adjustment_inbox i
    where not exists(select 1 from public.verified_adjustment_inbox_processed p where p.inbox_id=i.id)
      and not exists(select 1 from public.verified_adjustment_inbox_conflicts c where c.inbox_id=i.id)
    order by last_attempt,i.id limit 100
  ) pending),'[]'::jsonb));
end $$;

revoke all on function public.stage_verified_adjustment(text,text,text,text,text,bigint,text,text,timestamptz,text),
  public.process_verified_adjustment(uuid),public.note_verified_adjustment_failure(uuid),public.pending_verified_adjustments(),
  public.verified_adjustment_inbox_clear_for_payout(),public.admin_verified_adjustment_conflicts()
  from public,anon,authenticated,service_role;
grant execute on function public.stage_verified_adjustment(text,text,text,text,text,bigint,text,text,timestamptz,text),
  public.process_verified_adjustment(uuid),public.note_verified_adjustment_failure(uuid),public.pending_verified_adjustments() to service_role;
grant execute on function public.admin_verified_adjustment_conflicts() to authenticated;
