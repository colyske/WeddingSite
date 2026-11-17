-- Keep the KES creation default aligned with the fictional showcase target of 1.4M.
-- Other currencies use a starter goal only when it matches their configured currency.
create or replace function public.interactive_fund_preset(p_currency text,p_setup jsonb) returns bigint
language plpgsql immutable set search_path = ''
as $$
begin
  if p_currency='KES' then return 140000000; end if;
  if p_setup->>'currency'=p_currency and p_setup#>>'{campaigns,0,goalMinor}' is not null then
    return public.starter_minor(p_setup#>'{campaigns,0,goalMinor}',1,100000000000);
  end if;
  return null;
end $$;
revoke all on function public.interactive_fund_preset(text,jsonb) from public,anon,authenticated;
