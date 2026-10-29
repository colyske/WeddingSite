-- Numeric publication policies are USD cents, not repeated in each wedding currency.
alter table public.platform_policies add column publication_fee_currency text not null default 'USD'
  check (publication_fee_currency = 'USD');

create table public.publication_fx_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  source text not null check (source = 'https://open.er-api.com/v6/latest/USD'),
  published_at timestamptz not null unique,
  fetched_at timestamptz not null default now(),
  rates jsonb not null check (jsonb_typeof(rates) = 'object' and rates->>'USD' = '1')
);
alter table public.publication_fx_snapshots enable row level security;
revoke all on public.publication_fx_snapshots from public, anon, authenticated;
grant select, insert on public.publication_fx_snapshots to service_role;

alter table public.publication_checkouts
  add column usd_amount_minor bigint check (usd_amount_minor > 0),
  add column fx_snapshot_id uuid references public.publication_fx_snapshots(id),
  add column fx_rate numeric check (fx_rate > 0),
  add column fx_published_at timestamptz,
  add column fx_source text,
  add column payment_unit_minor integer check (payment_unit_minor in (1,100));

create function public.guard_publication_quote_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'publication_fx_snapshots' then
    raise exception 'Publication FX snapshots are immutable.';
  end if;
  if (to_jsonb(new) - array['status','provider_reference','initialization_started_at','provider_event_id',
      'provider_fee_minor','provider_result_code','paid_at']) is distinct from
     (to_jsonb(old) - array['status','provider_reference','initialization_started_at','provider_event_id',
      'provider_fee_minor','provider_result_code','paid_at']) then
    raise exception 'An admitted publication quote is immutable.';
  end if;
  return new;
end $$;
create trigger publication_fx_immutable before update or delete on public.publication_fx_snapshots
  for each row execute function public.guard_publication_quote_immutable();
create trigger publication_checkout_quote_immutable before update on public.publication_checkouts
  for each row execute function public.guard_publication_quote_immutable();

create or replace function public.publication_quote_internal(p_wedding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; pp public.platform_policies; prior integer; fee_status text;
  fee bigint; code text; reason text; local_fee bigint; rate numeric := 1;
  fx public.publication_fx_snapshots;
begin
  select * into w from public.weddings where id = p_wedding_id;
  if not found then raise exception 'Wedding not found.'; end if;
  select * into pp from public.platform_policies where id;
  select count(*) into prior from public.weddings x
    where x.client_owner_id = w.client_owner_id and x.id <> w.id and x.first_published_at is not null;
  select status into fee_status from public.publication_fees where wedding_id = p_wedding_id;
  if fee_status in ('paid','waived','test_paid') then
    fee := 0; code := 'settled';
    reason := case when fee_status = 'test_paid' then 'Publication fee verified in test mode; this is not collected revenue.'
      else 'The publication fee for this wedding is already ' || fee_status || '.' end;
  elsif w.wedding_date is not null and w.wedding_date > (current_date + make_interval(months => pp.far_future_months))::date then
    fee := pp.far_future_fee_minor; code := 'far_future';
    reason := 'Your wedding is more than ' || pp.far_future_months || ' months away, so the far-future USD fee applies.';
  elsif prior < pp.free_publications_per_client then
    fee := 0; code := 'free_allowance';
    reason := 'Your first ' || pp.free_publications_per_client || ' published wedding(s) are free. You have published ' || prior || ' so far.';
  else
    fee := pp.publication_fee_minor; code := 'per_wedding';
    reason := 'You have used your ' || pp.free_publications_per_client || ' free publication(s), so the per-wedding USD fee applies.';
  end if;
  if fee > 0 and w.currency <> 'USD' then
    select * into fx from public.publication_fx_snapshots
      where published_at >= now() - interval '36 hours' and published_at <= now() + interval '5 minutes'
        and (rates->>w.currency) is not null order by published_at desc limit 1;
    if not found then raise exception 'FX_UNAVAILABLE: A publication rate no older than 36 hours is required.'; end if;
    rate := (fx.rates->>w.currency)::numeric;
    if rate <= 0 or rate > 1000000000000 then raise exception 'FX_UNAVAILABLE: Invalid publication rate.'; end if;
  end if;
  local_fee := ceil(fee::numeric * rate)::bigint;
  return jsonb_build_object('fee_minor',local_fee,'currency',w.currency,'usd_amount_minor',fee,
    'base_currency','USD','fx_snapshot_id',fx.id,'fx_rate',rate,'fx_published_at',fx.published_at,
    'fx_fetched_at',fx.fetched_at,'fx_source',case when fx.id is null then null else fx.source end,
    'code',code,'reason',reason,'status',coalesce(fee_status,'none'),'prior_published',prior,
    'far_future_months',pp.far_future_months,'free_publications_per_client',pp.free_publications_per_client);
end $$;

drop function public.begin_publication_checkout(uuid,uuid,text,bigint,text);
create function public.begin_publication_checkout(
  p_wedding_id uuid, p_idempotency_key uuid, p_provider text, p_expected_amount bigint, p_expected_currency text,
  p_expected_usd_amount bigint, p_expected_fx_id uuid
) returns public.publication_checkouts
language plpgsql security definer set search_path = '' set row_security = off as $$
declare w public.weddings; q jsonb; checkout public.publication_checkouts; enabled text[]; unit integer; local_fee bigint;
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if auth.uid() is null or w.client_owner_id is distinct from auth.uid() then raise exception 'Access denied.'; end if;
  select enabled_payment_providers into enabled from public.platform_policies where id for share;
  select * into checkout from public.publication_checkouts
    where wedding_id=p_wedding_id and (status in ('pending','review') or idempotency_key=p_idempotency_key)
    order by created_at desc limit 1;
  if found then return checkout; end if;
  if w.archived_at is not null or w.published_at is not null or w.lifecycle_admin_restricted then
    raise exception 'Publication checkout requires an unrestricted, unarchived draft.';
  end if;
  if w.slug is null or w.wedding_date is null or not exists(select 1 from public.venues
    where wedding_id=w.id and event_time is not null and event_date is not null) then
    raise exception 'Complete the wedding address, date and event before publication checkout.';
  end if;
  if enabled is null or not coalesce(p_provider=any(enabled),false) then raise exception 'Payment method disabled.'; end if;
  if p_provider='daraja' and w.currency<>'KES' then raise exception 'M-Pesa publication requires KES.'; end if;
  q := public.publication_quote_internal(w.id);
  unit := case when p_provider='daraja' then 100 else 1 end;
  local_fee := ceil((q->>'fee_minor')::numeric / unit)::bigint * unit;
  if local_fee <= 0 or local_fee is distinct from p_expected_amount
    or (q->>'currency') is distinct from p_expected_currency
    or (q->>'usd_amount_minor')::bigint is distinct from p_expected_usd_amount
    or nullif(q->>'fx_snapshot_id','')::uuid is distinct from p_expected_fx_id then
    raise exception 'Publication quote changed. Reload the current fee before paying.';
  end if;
  insert into public.publication_checkouts(wedding_id,client_id,idempotency_key,amount_minor,currency,quote_code,provider,
      usd_amount_minor,fx_snapshot_id,fx_rate,fx_published_at,fx_source,payment_unit_minor)
    values(w.id,auth.uid(),p_idempotency_key,local_fee,w.currency,q->>'code',p_provider,
      (q->>'usd_amount_minor')::bigint,p_expected_fx_id,(q->>'fx_rate')::numeric,
      (q->>'fx_published_at')::timestamptz,q->>'fx_source',unit)
    returning * into checkout;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    values(w.id,auth.uid(),'user','publication_test_checkout_started','publication_checkouts',checkout.id::text);
  return checkout;
end $$;
revoke all on function public.begin_publication_checkout(uuid,uuid,text,bigint,text,bigint,uuid) from public, anon;
grant execute on function public.begin_publication_checkout(uuid,uuid,text,bigint,text,bigint,uuid) to authenticated;
