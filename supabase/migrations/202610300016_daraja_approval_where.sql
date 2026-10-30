-- 015's owner_set_daraja_live_approval ran an UPDATE with no WHERE clause, which databases
-- running pg-safeupdate (e.g. Supabase production) reject. Replace it additively with the
-- same behaviour, a WHERE on the singleton key, and a hard failure if the row is missing.
create or replace function public.owner_set_daraja_live_approval(p_approved boolean, p_shortcode text default null)
returns boolean language plpgsql security definer set search_path = '' set row_security = off as $$
begin
  perform public.require_staff('owner');
  if p_approved is null then raise exception 'Choose approve or revoke.'; end if;
  if p_approved and (p_shortcode is null or p_shortcode !~ '^[0-9]{5,7}$') then
    raise exception 'Enter the production shortcode being approved.';
  end if;
  update public.daraja_live_approval set
    approved = p_approved,
    shortcode = case when p_approved then p_shortcode else null end,
    approved_by = case when p_approved then auth.uid() else null end,
    approved_at = case when p_approved then now() else null end
  where singleton = true;
  if not found then raise exception 'Daraja approval record is missing.'; end if;
  insert into public.audit_events(actor_id, source, action, table_name, record_id, changed_fields)
    values(auth.uid(), 'user', case when p_approved then 'daraja_live_approve' else 'daraja_live_revoke' end,
      'daraja_live_approval', 'singleton', array['approved']);
  return true;
end $$;

revoke all on function public.owner_set_daraja_live_approval(boolean, text) from public, anon;
grant execute on function public.owner_set_daraja_live_approval(boolean, text) to authenticated;
