-- Retryable ownership/membership changes must not wait on the global lock
-- after locking their own row. Unrelated wedding edits need no accounting lock.
create function public.referral_link_try_lock() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare relevant boolean:=false;
begin
  if tg_table_name='weddings' then
    relevant:=new.client_owner_id is distinct from old.client_owner_id
      and exists(select 1 from public.referral_attributions
        where wedding_id=new.id and referrer_id=new.client_owner_id);
  elsif new.role='client' then
    if tg_op='INSERT' then
      relevant:=true;
    else
      relevant:=(new.wedding_id,new.user_id,new.role)
        is distinct from (old.wedding_id,old.user_id,old.role);
    end if;
    relevant:=relevant and exists(select 1 from public.referral_attributions
      where wedding_id=new.wedding_id and referrer_id=new.user_id);
  end if;
  if relevant and not pg_try_advisory_xact_lock(71110001) then
    raise exception 'REFERRAL_ACCOUNTING_BUSY: Retry this account link after accounting completes.';
  end if;
  return new;
end $$;
revoke all on function public.referral_link_try_lock() from public,anon,authenticated,service_role;
create trigger referral_owner_link_guard before update of client_owner_id on public.weddings
  for each row execute function public.referral_link_try_lock();
create trigger referral_client_link_guard before insert or update of wedding_id,user_id,role on public.wedding_memberships
  for each row execute function public.referral_link_try_lock();

create or replace function public.referral_account_link_changed() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare a public.referral_attributions; cid uuid;
begin
  if tg_table_name='weddings' then
    if new.client_owner_id is not distinct from old.client_owner_id then return new; end if;
    select * into a from public.referral_attributions where wedding_id=new.id and referrer_id=new.client_owner_id;
    if found then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(a.wedding_id,'owner_account',a.referrer_id) on conflict do nothing;
    end if;
  else
    if new.role<>'client' then return new; end if;
    if tg_op='UPDATE' and (new.wedding_id,new.user_id,new.role)
      is not distinct from (old.wedding_id,old.user_id,old.role) then return new; end if;
    select * into a from public.referral_attributions where wedding_id=new.wedding_id and referrer_id=new.user_id;
    if found then
      insert into public.referral_eligibility_events(wedding_id,reason,linked_user_id)
        values(a.wedding_id,'client_membership',a.referrer_id) on conflict do nothing;
    end if;
  end if;
  if a.wedding_id is not null then
    for cid in select contribution_id from public.referral_contribution_policy
      where wedding_id=a.wedding_id order by contribution_id loop
      perform public.referral_reconcile_estimate(cid);
    end loop;
  end if;
  return new;
end $$;
