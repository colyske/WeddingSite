-- Retain the proposed link-order implementation as unattached prototypes.
-- It cannot establish complete historical eligibility and its lock ordering
-- is unsafe for live writers. The existing triggers keep their predecessors.
create table public.referral_link_history (
  wedding_id uuid not null,
  user_id uuid not null,
  reason text not null check (reason in ('owner_account','client_membership')),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (wedding_id,user_id,reason)
);
alter table public.referral_link_history enable row level security;
revoke all on public.referral_link_history from public,anon,authenticated,service_role;
create trigger immutable before update or delete on public.referral_link_history
  for each row execute function public.referral_immutable();

create function public.referral_link_try_lock_prototype() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare relevant boolean:=false; v_wedding uuid; touches boolean:=false;
begin
  if tg_table_name='weddings' then
    touches:=new.client_owner_id is distinct from old.client_owner_id;
    v_wedding:=new.id;
  else
    touches:=new.role='client' and (tg_op='INSERT'
      or (new.wedding_id,new.user_id,new.role) is distinct from (old.wedding_id,old.user_id,old.role));
    v_wedding:=new.wedding_id;
  end if;
  if touches then perform pg_advisory_xact_lock(71110003,hashtext(v_wedding::text)); end if;
  if tg_table_name='weddings' then
    relevant:=touches and exists(select 1 from public.referral_attributions
        where wedding_id=new.id and referrer_id=new.client_owner_id);
  else
    relevant:=touches and exists(select 1 from public.referral_attributions
      where wedding_id=new.wedding_id and referrer_id=new.user_id);
  end if;
  if relevant and not pg_try_advisory_xact_lock(71110001) then
    raise exception 'REFERRAL_ACCOUNTING_BUSY: Retry this account link after accounting completes.';
  end if;
  return new;
end $$;

create function public.referral_record_current_link_prototype() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare v_wedding_id uuid; v_user_id uuid; v_reason text;
begin
  if tg_table_name='weddings' then
    if new.client_owner_id is not distinct from old.client_owner_id then return new; end if;
    v_wedding_id:=new.id; v_user_id:=new.client_owner_id; v_reason:='owner_account';
  else
    if new.role<>'client' then return new; end if;
    if tg_op='UPDATE' and (new.wedding_id,new.user_id,new.role)
      is not distinct from (old.wedding_id,old.user_id,old.role) then return new; end if;
    v_wedding_id:=new.wedding_id; v_user_id:=new.user_id; v_reason:='client_membership';
  end if;
  if v_user_id is not null then
    insert into public.referral_link_history(wedding_id,user_id,reason)
      values(v_wedding_id,v_user_id,v_reason) on conflict do nothing;
  end if;
  if exists(select 1 from public.referral_attributions a
    where a.wedding_id=v_wedding_id and a.referrer_id=v_user_id) then
    if not pg_try_advisory_xact_lock(71110001) then
      raise exception 'REFERRAL_ACCOUNTING_BUSY: Retry this account link after accounting completes.';
    end if;
    insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
      values(v_wedding_id,v_reason,v_user_id) on conflict do nothing;
  end if;
  return new;
end $$;

create function public.referral_record_attribution_link_prototype() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare owner_link boolean; client_link boolean;
begin
  perform pg_advisory_xact_lock(71110003,hashtext(new.wedding_id::text));
  select coalesce(w.client_owner_id=new.referrer_id,false) into owner_link from public.weddings w where w.id=new.wedding_id;
  owner_link:=coalesce(owner_link,false) or exists(select 1 from public.referral_link_history h
    where h.wedding_id=new.wedding_id and h.user_id=new.referrer_id and h.reason='owner_account');
  client_link:=exists(select 1 from public.wedding_memberships m where m.wedding_id=new.wedding_id
    and m.user_id=new.referrer_id and m.role='client')
    or exists(select 1 from public.referral_link_history h
      where h.wedding_id=new.wedding_id and h.user_id=new.referrer_id and h.reason='client_membership');
  if owner_link or client_link then
    if not pg_try_advisory_xact_lock(71110001) then
      raise exception 'REFERRAL_ACCOUNTING_BUSY: Retry this attribution after accounting completes.';
    end if;
    if owner_link then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(new.wedding_id,'owner_account',new.referrer_id) on conflict do nothing;
    end if;
    if client_link then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(new.wedding_id,'client_membership',new.referrer_id) on conflict do nothing;
    end if;
  end if;
  return new;
end $$;

revoke all on function public.referral_link_try_lock_prototype(),
  public.referral_record_current_link_prototype(),public.referral_record_attribution_link_prototype()
  from public,anon,authenticated,service_role;

-- A separate hard hold prevents a later manual-gate change from treating
-- unproven attribution history as payable. Review requires a new migration.
create function public.facilitator_manual_attribution_proven() returns boolean
language sql immutable set search_path='' as $$ select false $$;
revoke all on function public.facilitator_manual_attribution_proven() from public,anon,authenticated,service_role;

do $$
declare definition text; marker text:='  select * into c from public.contributions where id=p_contribution;';
begin
  definition:=pg_get_functiondef('public.facilitator_manual_source_cap(uuid,uuid,text)'::regprocedure);
  if length(definition)-length(replace(definition,marker,''))<>length(marker) then
    raise exception 'Unexpected facilitator source cap predecessor';
  end if;
  execute replace(definition,marker,
    '  if not public.facilitator_manual_attribution_proven() then
    raise exception ''FACILITATOR_MANUAL_HOLD: Attribution history has not been substantiated.'';
  end if;' || E'\n' || marker);
end $$;
