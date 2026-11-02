-- Owner-selected default currency for new weddings and public sample pricing displays.
-- Null keeps legacy behavior. Existing weddings, transactions, fee policy (USD) and
-- provider availability are untouched; supported-currency checks happen at read time.
alter table public.platform_policies add column if not exists default_currency text
  check (default_currency is null or default_currency ~ '^[A-Z]{3}$');

create or replace function public.owner_set_default_currency(p_currency text, p_confirmed boolean)
returns jsonb
language plpgsql security definer set search_path = '' set row_security = off
as $$
declare
  current_policy public.platform_policies;
  next_currency text := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  next_values jsonb;
begin
  if public.current_platform_role() is distinct from 'owner' then
    raise exception 'Only the protected Owner can change the platform default currency.';
  end if;
  if p_confirmed is not true then
    raise exception 'Confirmation is required to change the platform default currency.';
  end if;
  if next_currency is not null and next_currency !~ '^[A-Z]{3}$' then
    raise exception 'Default currency must be a three-letter ISO code.';
  end if;
  select * into current_policy from public.platform_policies where id for update;
  if current_policy.default_currency is not distinct from next_currency then
    return jsonb_build_object('default_currency', next_currency, 'changed', false);
  end if;
  update public.platform_policies
    set default_currency = next_currency, updated_by = auth.uid(), updated_at = now()
    where id;
  select to_jsonb(pp) - 'updated_by' into next_values from public.platform_policies pp where pp.id;
  insert into public.platform_policy_history (changed_by, old_values, new_values)
    values (auth.uid(), to_jsonb(current_policy) - 'updated_by', next_values);
  insert into public.audit_events (actor_id, source, action, table_name, record_id, changed_fields)
    values (auth.uid(), 'user', 'policy_update', 'platform_policies', 'true', array['default_currency']);
  return jsonb_build_object('default_currency', next_currency, 'changed', true);
end $$;
revoke all on function public.owner_set_default_currency(text, boolean) from public, anon;
grant execute on function public.owner_set_default_currency(text, boolean) to authenticated;
