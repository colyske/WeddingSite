-- An INSERT ... ON CONFLICT UPDATE fires the insert trigger even when the
-- existing membership remains unchanged. The update trigger still guards any
-- concurrent or actual change after PostgreSQL locks the conflicting row.
create or replace function public.referral_link_try_lock() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare relevant boolean:=false;
begin
  if tg_table_name='weddings' then
    relevant:=new.client_owner_id is distinct from old.client_owner_id
      and exists(select 1 from public.referral_attributions
        where wedding_id=new.id and referrer_id=new.client_owner_id);
  elsif new.role='client' then
    if tg_op='INSERT' then
      perform 1 from public.wedding_memberships
        where wedding_id=new.wedding_id and user_id=new.user_id and role=new.role
        for update;
      relevant:=not found;
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
