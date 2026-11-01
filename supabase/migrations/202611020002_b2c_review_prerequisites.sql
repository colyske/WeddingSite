-- Account review is not destination ownership verification. No production activation.
alter table public.b2c_recipients
  add column account_review_confirmed_by uuid references public.profiles(id),
  add column account_review_confirmed_at timestamptz;
alter table public.b2c_recipients add constraint b2c_distinct_account_reviewers
  check (account_review_confirmed_by is null or account_review_confirmed_by <> reviewed_by);

-- No documented destination-ownership integration exists in this repository.
-- A future reviewed migration must implement this from independently verified evidence.
create function public.b2c_destination_ownership_verified(p_wedding uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select false $$;
revoke all on function public.b2c_destination_ownership_verified(uuid) from public,anon,authenticated,service_role;

create function public.staff_confirm_b2c_account_review(p_wedding uuid, p_reference text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.b2c_recipients;
begin
  perform public.require_staff('superadmin');
  if public.current_platform_role() <> 'superadmin' then
    raise exception 'B2C: A different SuperAdmin user must confirm the Owner account review.';
  end if;
  perform 1 from public.weddings where id=p_wedding for update;
  select * into r from public.b2c_recipients where wedding_id=p_wedding and not revoked for update;
  if r.wedding_id is null or r.reviewed_by=auth.uid()
    or not exists(select 1 from public.profiles where id=r.reviewed_by and platform_role='owner')
    or p_reference is distinct from r.statement_reference then
    raise exception 'B2C: Distinct Owner and SuperAdmin user ids and matching documented account-review evidence required.';
  end if;
  update public.b2c_recipients set account_review_confirmed_by=auth.uid(),
    account_review_confirmed_at=now() where wedding_id=p_wedding;
  perform public.b2c_audit(p_wedding,p_wedding::text,'documented_account_review_confirmed');
  return true;
end $$;
revoke all on function public.staff_confirm_b2c_account_review(uuid,text) from public,anon;
grant execute on function public.staff_confirm_b2c_account_review(uuid,text) to authenticated;

create function public.invalidate_b2c_account_review() returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new)-array['account_review_confirmed_by','account_review_confirmed_at']) is distinct from
    (to_jsonb(old)-array['account_review_confirmed_by','account_review_confirmed_at']) then
    new.account_review_confirmed_by:=null;
    new.account_review_confirmed_at:=null;
  end if;
  return new;
end $$;
create trigger invalidate_b2c_account_review before update on public.b2c_recipients
  for each row execute function public.invalidate_b2c_account_review();

alter function public.b2c_reserve(uuid,uuid,uuid,text,text,text,boolean) rename to b2c_reserve_reviewed_internal;
revoke all on function public.b2c_reserve_reviewed_internal(uuid,uuid,uuid,text,text,text,boolean)
  from public,anon,authenticated,service_role;
create function public.b2c_reserve(p_payout uuid,p_key uuid,p_originator uuid,p_callback_hash text,
  p_shortcode text,p_command text,p_allow_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.b2c_recipients; wid uuid;
begin
  if auth.role() is distinct from 'service_role' then perform public.require_staff('superadmin'); end if;
  -- Same lock order as reservation and settlement.
  perform 1 from public.b2c_policy where singleton for update;
  select wedding_id into wid from public.payout_records where id=p_payout;
  perform 1 from public.weddings where id=wid for update;
  select * into r from public.b2c_recipients where wedding_id=wid and not revoked for share;
  if not public.b2c_destination_ownership_verified(wid) then
    raise exception 'B2C: Verified destination-ownership process is not implemented; account-review evidence cannot authorize dispatch.';
  end if;
  if r.account_review_confirmed_by is null or r.account_review_confirmed_by=r.reviewed_by
    or not exists(select 1 from public.profiles where id=r.reviewed_by and platform_role='owner')
    or not exists(select 1 from public.profiles where id=r.account_review_confirmed_by and platform_role='superadmin') then
    raise exception 'B2C: Distinct Owner and SuperAdmin account reviewers required.';
  end if;
  return public.b2c_reserve_reviewed_internal(p_payout,p_key,p_originator,p_callback_hash,p_shortcode,p_command,p_allow_auto);
end $$;
revoke all on function public.b2c_reserve(uuid,uuid,uuid,text,text,text,boolean) from public,anon;
grant execute on function public.b2c_reserve(uuid,uuid,uuid,text,text,text,boolean) to authenticated,service_role;

alter function public.staff_reconcile_b2c(uuid,text,text,text,text,bigint) rename to b2c_reconcile_reviewed_internal;
revoke all on function public.b2c_reconcile_reviewed_internal(uuid,text,text,text,text,bigint)
  from public,anon,authenticated,service_role;
create function public.staff_reconcile_b2c(p_dispatch uuid,p_reference text,p_outcome text,
  p_transaction text,p_msisdn text,p_amount bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare d public.b2c_dispatches; initiator_role public.platform_role;
begin
  perform public.require_staff('superadmin');
  select * into d from public.b2c_dispatches where id=p_dispatch;
  select platform_role into initiator_role from public.profiles where id=d.initiated_by;
  if d.id is null or d.initiated_by=auth.uid()
    or (d.initiated_by is not null and not (
      initiator_role='owner' and public.current_platform_role()='superadmin'
      or initiator_role='superadmin' and public.current_platform_role()='owner'))
    or (d.initiated_by is null and public.current_platform_role()<>'superadmin') then
    raise exception 'B2C: Independent reconciliation requires a different Owner/SuperAdmin user id in the opposite role.';
  end if;
  return public.b2c_reconcile_reviewed_internal(p_dispatch,p_reference,p_outcome,p_transaction,p_msisdn,p_amount);
end $$;
revoke all on function public.staff_reconcile_b2c(uuid,text,text,text,text,bigint) from public,anon;
grant execute on function public.staff_reconcile_b2c(uuid,text,text,text,text,bigint) to authenticated;

-- A failed principal does not establish zero provider fee. Keep outbound fee held
-- until a future independently evidenced fee-reconciliation mechanism exists.
do $$
declare sig text; definition text;
begin
  foreach sig in array array['public.b2c_available_minor(uuid,uuid)',
    'public.withdrawable_balance(uuid,text)','public.request_payout(uuid,bigint,text,text,boolean)'] loop
    definition:=pg_get_functiondef(sig::regprocedure);
    definition:=replace(definition,'and d.state<>''failed''','');
    execute definition;
  end loop;
end $$;
