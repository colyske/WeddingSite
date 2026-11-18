-- Prefer a starter's goal only in its own currency; preserve the existing KES fallback.
create or replace function public.interactive_fund_preset(p_currency text,p_setup jsonb) returns bigint
language plpgsql immutable set search_path = ''
as $$
begin
  if p_setup->>'currency'=p_currency and p_setup#>>'{campaigns,0,goalMinor}' is not null then
    return public.starter_minor(p_setup#>'{campaigns,0,goalMinor}',1,100000000000);
  end if;
  if p_currency='KES' then return 50000000; end if;
  return null;
end $$;
