-- Publication charges belong to the platform, never wedding contributions or payouts.
create table public.publication_checkouts (
  id uuid primary key default extensions.gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id),
  client_id uuid not null references public.profiles(id),
  idempotency_key uuid not null unique,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  quote_code text not null,
  provider text not null check (provider in ('stripe','paystack','daraja')),
  payment_mode text not null default 'test' check (payment_mode = 'test'),
  provider_reference text,
  initialization_started_at timestamptz,
  provider_event_id text,
  provider_fee_minor bigint check (provider_fee_minor >= 0),
  provider_result_code text,
  status text not null default 'pending' check (status in ('pending','paid','failed','review')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique(provider, provider_reference)
);
create unique index publication_one_active_checkout on public.publication_checkouts(wedding_id)
  where status in ('pending','review');
alter table public.publication_checkouts enable row level security;
revoke all on public.publication_checkouts from anon, authenticated;
grant select, insert, update on public.publication_checkouts to service_role;

alter table public.publication_fees drop constraint publication_fees_status_check;
alter table public.publication_fees add constraint publication_fees_status_check
  check (status in ('pending','paid','waived','test_paid'));

create or replace function public.publication_quote_internal(p_wedding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set row_security = off
as $$
declare w public.weddings; pp public.platform_policies; prior integer; fee_status text;
  fee bigint; code text; reason text;
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
    reason := 'Your wedding is more than ' || pp.far_future_months || ' months away, so the far-future fee applies.';
  elsif prior < pp.free_publications_per_client then
    fee := 0; code := 'free_allowance';
    reason := 'Your first ' || pp.free_publications_per_client || ' published wedding(s) are free. You have published ' || prior || ' so far.';
  else
    fee := pp.publication_fee_minor; code := 'per_wedding';
    reason := 'You have used your ' || pp.free_publications_per_client || ' free publication(s), so the per-wedding fee applies.';
  end if;
  return jsonb_build_object('fee_minor',fee,'currency',w.currency,'code',code,'reason',reason,
    'status',coalesce(fee_status,'none'),'prior_published',prior,'far_future_months',pp.far_future_months,
    'free_publications_per_client',pp.free_publications_per_client);
end $$;

create function public.begin_publication_checkout(
  p_wedding_id uuid, p_idempotency_key uuid, p_provider text, p_expected_amount bigint, p_expected_currency text
) returns public.publication_checkouts
language plpgsql security definer set search_path = '' set row_security = off as $$
declare w public.weddings; q jsonb; checkout public.publication_checkouts; enabled text[];
begin
  select * into w from public.weddings where id=p_wedding_id for update;
  if auth.uid() is null or w.client_owner_id is distinct from auth.uid() then raise exception 'Access denied.'; end if;
  -- Locking the policy serializes admission against provider/fee policy updates.
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
  q := public.publication_quote_internal(w.id);
  if (q->>'fee_minor')::bigint <= 0 or (q->>'fee_minor')::bigint is distinct from p_expected_amount
    or (q->>'currency') is distinct from p_expected_currency then
    raise exception 'Publication quote changed. Reload the current fee before paying.';
  end if;
  insert into public.publication_checkouts(wedding_id,client_id,idempotency_key,amount_minor,currency,quote_code,provider)
    values(w.id,auth.uid(),p_idempotency_key,(q->>'fee_minor')::bigint,w.currency,q->>'code',p_provider)
    returning * into checkout;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id)
    values(w.id,auth.uid(),'user','publication_test_checkout_started','publication_checkouts',checkout.id::text);
  return checkout;
end $$;
revoke all on function public.begin_publication_checkout(uuid,uuid,text,bigint,text) from public, anon;
grant execute on function public.begin_publication_checkout(uuid,uuid,text,bigint,text) to authenticated;

create function public.record_verified_publication_payment(
  p_checkout_id uuid, p_provider text, p_reference text, p_amount_minor bigint, p_currency text,
  p_event_id text, p_provider_fee_minor bigint default null
) returns boolean
language plpgsql security definer set search_path = '' set row_security = off as $$
declare checkout public.publication_checkouts; wedding public.weddings;
begin
  select * into checkout from public.publication_checkouts where id=p_checkout_id;
  if not found then raise exception 'Publication checkout not found.'; end if;
  -- Same wedding-first lock order as checkout admission and publication.
  select * into wedding from public.weddings where id=checkout.wedding_id for update;
  select * into checkout from public.publication_checkouts where id=p_checkout_id for update;
  if checkout.provider is distinct from p_provider or checkout.provider_reference is null
    or checkout.provider_reference is distinct from p_reference or checkout.amount_minor is distinct from p_amount_minor
    or checkout.currency::text is distinct from p_currency or nullif(p_event_id,'') is null then
    raise exception 'Verified publication payment does not match the stored checkout.';
  end if;
  if checkout.status='paid' then return true; end if;
  if wedding.currency is distinct from checkout.currency then
    if checkout.status='review' and checkout.provider_event_id=p_event_id then return false; end if;
    update public.publication_checkouts set status='review',provider_event_id=p_event_id,paid_at=now(),
      provider_fee_minor=p_provider_fee_minor where id=checkout.id;
    insert into public.audit_events(wedding_id,source,action,table_name,record_id)
      values(wedding.id,'provider','publication_test_payment_currency_review','publication_checkouts',checkout.id::text);
    return false;
  end if;
  update public.publication_checkouts set status='paid',paid_at=now(),provider_event_id=p_event_id,
    provider_fee_minor=p_provider_fee_minor where id=checkout.id;
  -- A staff waiver racing a genuine payment stays a waiver; never overwrite it.
  insert into public.publication_fees(wedding_id,amount_minor,currency,status,paid_at,provider,reason_code)
    values(wedding.id,checkout.amount_minor,checkout.currency,'test_paid',now(),checkout.provider || '-test',checkout.quote_code)
    on conflict(wedding_id) do update set amount_minor=excluded.amount_minor,currency=excluded.currency,
      status=excluded.status,paid_at=excluded.paid_at,provider=excluded.provider,reason_code=excluded.reason_code
      where public.publication_fees.status='pending';
  insert into public.audit_events(wedding_id,source,action,table_name,record_id)
    values(wedding.id,'provider','publication_test_payment_verified','publication_checkouts',checkout.id::text);
  return true;
end $$;
revoke all on function public.record_verified_publication_payment(uuid,text,text,bigint,text,text,bigint) from public, anon, authenticated;
grant execute on function public.record_verified_publication_payment(uuid,text,text,bigint,text,text,bigint) to service_role;
