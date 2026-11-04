-- Operator statement attestation only: no provider queries or financial fixtures.
create table public.owner_payment_fee_attestations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_key uuid not null unique,
  contribution_id uuid not null unique references public.contributions(id),
  fee_minor bigint not null check(fee_minor>=0),
  source_kind text not null check(source_kind in ('transaction','statement')),
  source_reference text not null check(source_reference ~ '^[A-Z][A-Z0-9._:-]{2,79}$'
    and source_reference ~ '[0-9]' and source_reference !~ '[0-9]{9}'),
  actual_zero_confirmed boolean not null,
  actor_id uuid not null references public.profiles(id),
  recorded_at timestamptz not null default clock_timestamp(),
  immutable_payment_sha256 text not null check(immutable_payment_sha256 ~ '^[a-f0-9]{64}$'),
  check(fee_minor<>0 or actual_zero_confirmed)
);
alter table public.owner_payment_fee_attestations enable row level security;
revoke all on public.owner_payment_fee_attestations from public,anon,authenticated,service_role;
create trigger owner_payment_fee_attestations_immutable before update or delete on public.owner_payment_fee_attestations
  for each row execute function public.manual_payout_immutable();

create function public.owner_record_payment_fee(p_key uuid,p_contribution uuid,p_fee bigint,
  p_source_kind text,p_reference text,p_actual_zero boolean,p_confirmed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare c public.contributions; prior public.owner_payment_fee_attestations; result uuid;
  reference text:=upper(btrim(p_reference)); fingerprint text;
begin
  perform pg_advisory_xact_lock(71110001);
  perform 1 from public.profiles where id=auth.uid() for share;
  if auth.uid() is null or public.current_platform_role() is distinct from 'owner' then
    raise exception 'PAYMENT_FEE: Protected Owner access required.'; end if;
  if p_key is null or p_contribution is null or p_fee is null or p_fee<0 or p_fee>9007199254740991
    or p_source_kind is null or p_source_kind not in ('transaction','statement')
    or reference is null or reference !~ '^[A-Z][A-Z0-9._:-]{2,79}$' or reference !~ '[0-9]'
    or reference ~ '[0-9]{9}' or p_actual_zero is null or p_confirmed is distinct from true
    or (p_fee=0 and not p_actual_zero) or (p_fee<>0 and p_actual_zero) then
    raise exception 'PAYMENT_FEE: Confirm the actual fee and non-sensitive official transaction or statement reference. Zero requires explicit actual-zero confirmation.'; end if;
  select * into prior from public.owner_payment_fee_attestations where request_key=p_key;
  if found then
    if (prior.contribution_id,prior.fee_minor,prior.source_kind,prior.source_reference,prior.actual_zero_confirmed,prior.actor_id)
      is distinct from (p_contribution,p_fee,p_source_kind,reference,p_actual_zero,auth.uid()) then
      raise exception 'PAYMENT_FEE: Retry changed. Refresh fee history; do not overwrite a known fee.'; end if;
    return prior.id;
  end if;
  select * into strict c from public.contributions where id=p_contribution for update;
  perform 1 from public.weddings where id=c.wedding_id for update;
  if c.provider_name is distinct from 'daraja' or c.payment_environment is distinct from 'live'
    or c.payment_status is distinct from 'paid' or c.verified_provider_payment is distinct from true
    or c.currency is distinct from 'KES' or c.settlement_route is distinct from 'platform_wallet'
    or c.provider_fee_minor is not null or c.provider_fee_pending is distinct from true
    or p_fee>c.paid_amount_minor or p_fee>c.net_paid_minor then
    raise exception 'PAYMENT_FEE: Select a verified live KES M-Pesa wallet payment with an unknown fee. Known fees cannot be overwritten; fee cannot exceed paid or net amount.'; end if;
  fingerprint:=encode(extensions.digest((to_jsonb(c)-array['provider_fee_minor','provider_fee_pending'])::text,'sha256'),'hex');
  insert into public.owner_payment_fee_attestations(request_key,contribution_id,fee_minor,source_kind,
    source_reference,actual_zero_confirmed,actor_id,immutable_payment_sha256)
    values(p_key,c.id,p_fee,p_source_kind,reference,p_actual_zero,auth.uid(),fingerprint) returning id into result;
  update public.contributions set provider_fee_minor=p_fee,provider_fee_pending=false where id=c.id;
  if fingerprint is distinct from (select encode(extensions.digest(
    (to_jsonb(x)-array['provider_fee_minor','provider_fee_pending'])::text,'sha256'),'hex') from public.contributions x where id=c.id) then
    raise exception 'PAYMENT_FEE: Immutable payment fields changed; no fee attestation was saved.'; end if;
  insert into public.audit_events(wedding_id,actor_id,source,action,table_name,record_id,changed_fields)
    values(c.wedding_id,auth.uid(),'user','payment_fee_operator_attested','contributions',c.id::text,
      array['provider_fee_minor','provider_fee_pending']);
  return result;
end $$;
revoke all on function public.owner_record_payment_fee(uuid,uuid,bigint,text,text,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.owner_record_payment_fee(uuid,uuid,bigint,text,text,boolean,boolean) to authenticated;

create function public.owner_payment_fee_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or public.current_platform_role() is distinct from 'owner' then
    raise exception 'PAYMENT_FEE: Protected Owner access required.'; end if;
  return jsonb_build_object('notice','Owner statement attestation, not provider API verification. This records an actual payment fee only; it sends nothing and never changes stored time holds.',
    'pending',coalesce((select jsonb_agg(x order by x.paid_at desc) from (
      select c.id,'WS-'||left(replace(c.id::text,'-',''),10) internal_reference,c.paid_at,c.paid_amount_minor,c.net_paid_minor,
        c.currency,c.funds_available_at,public.simple_payout_available(c.wedding_id) available_minor
      from public.contributions c where c.provider_name='daraja' and c.payment_environment='live'
        and c.payment_status='paid' and c.verified_provider_payment and c.currency='KES'
        and c.settlement_route='platform_wallet' and c.provider_fee_minor is null and c.provider_fee_pending
      order by c.paid_at desc,c.id limit 100) x),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(x order by x.recorded_at desc) from (
      select a.id,'WS-'||left(replace(a.contribution_id::text,'-',''),10) internal_reference,
        a.fee_minor,a.source_kind,a.source_reference,a.actor_id,a.recorded_at
      from public.owner_payment_fee_attestations a order by a.recorded_at desc,a.id limit 100) x),'[]'::jsonb));
end $$;
revoke all on function public.owner_payment_fee_workspace() from public,anon,authenticated,service_role;
grant execute on function public.owner_payment_fee_workspace() to authenticated;
