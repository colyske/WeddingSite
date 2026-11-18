-- Record actual links after the row change succeeds, without waiting until
-- deferred reconciliation. This makes link-then-unlink visible to accounting
-- in the same transaction. The existing deferred triggers still reconcile.
create function public.referral_record_current_link() returns trigger
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
revoke all on function public.referral_record_current_link() from public,anon,authenticated,service_role;
create trigger referral_owner_link_immediate after update of client_owner_id on public.weddings
  for each row execute function public.referral_record_current_link();
create trigger referral_client_link_immediate after insert or update of wedding_id,user_id,role on public.wedding_memberships
  for each row execute function public.referral_record_current_link();

-- An attribution can be inserted after an existing link in the same transaction.
-- Detect that actual link without a blocking advisory lock after the row write.
create function public.referral_record_attribution_link() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare owner_link boolean; client_link boolean;
begin
  select w.client_owner_id=new.referrer_id into owner_link from public.weddings w where w.id=new.wedding_id;
  select exists(select 1 from public.wedding_memberships m where m.wedding_id=new.wedding_id
    and m.user_id=new.referrer_id and m.role='client') into client_link;
  if coalesce(owner_link,false) or client_link then
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
revoke all on function public.referral_record_attribution_link() from public,anon,authenticated,service_role;
create trigger referral_attribution_link_immediate after insert on public.referral_attributions
  for each row execute function public.referral_record_attribution_link();
