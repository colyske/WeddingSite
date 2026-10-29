-- Additive, nullable suggestions only. No prices, fees, balances or existing choices change.
alter table public.weddings add column if not exists amount_presets jsonb;
grant update (amount_presets) on public.weddings to authenticated;

create or replace function public.guard_wedding_amount_presets() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare cap bigint; kind text; item jsonb; normalized jsonb; amounts jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.amount_presets is not distinct from old.amount_presets and new.currency = old.currency then
      return new;
    end if;
  end if;
  if new.amount_presets is null then return new; end if;
  if jsonb_typeof(new.amount_presets) <> 'object'
      or new.amount_presets->>'currency' is distinct from new.currency::text then
    raise exception 'Review suggested amounts in the selected wedding currency, or explicitly reset them.';
  end if;
  -- Same two-decimal accounting currencies as currencies.js; non-two-decimal ISO codes are display-only.
  if not (new.currency::text = any(string_to_array(
    'AED,AMD,ANG,AOA,ARS,AUD,AWG,AZN,BAM,BBD,BDT,BGN,BMD,BND,BOB,BRL,BSD,BTN,BWP,BYN,BZD,CAD,CDF,CHF,CNY,COP,CRC,CUC,CUP,CVE,CZK,DKK,DOP,DZD,EGP,ERN,ETB,EUR,FJD,FKP,GBP,GEL,GHS,GIP,GMD,GTQ,GYD,HKD,HNL,HRK,HTG,HUF,IDR,ILS,INR,JMD,KES,KGS,KHR,KYD,KZT,LKR,LRD,LSL,MAD,MDL,MKD,MNT,MOP,MRU,MUR,MVR,MWK,MXN,MYR,MZN,NAD,NGN,NIO,NOK,NPR,NZD,PAB,PEN,PGK,PHP,PKR,PLN,QAR,RON,RUB,SAR,SBD,SCR,SDG,SEK,SGD,SHP,SLE,SRD,SSP,STN,SVC,SZL,THB,TJS,TMT,TOP,TRY,TTD,TWD,TZS,UAH,USD,UYU,UZS,VES,WST,XCD,XCG,XDR,XSU,ZAR,ZMW,ZWG,ZWL', ','))) then
    raise exception 'Choose a supported two-decimal wedding currency.';
  end if;
  select max_contribution_minor into cap from public.platform_policies where id;
  if cap is null then raise exception 'Suggested amount checkout limit is unavailable.'; end if;
  normalized := jsonb_build_object('currency', new.currency);
  foreach kind in array array['song', 'gift'] loop
    amounts := new.amount_presets->kind;
    if jsonb_typeof(amounts) is distinct from 'array' then
      raise exception 'Suggested amounts must be arrays.';
    end if;
    if jsonb_array_length(amounts) not between 1 and 6 then
      raise exception 'Enter 1 to 6 suggested amounts per list.';
    end if;
    for item in select value from jsonb_array_elements(amounts) loop
      if jsonb_typeof(item) <> 'number' then raise exception 'Suggested amounts must be positive integer minor units.'; end if;
      if item::text::numeric <> trunc(item::text::numeric)
          or item::text::numeric < 100 or item::text::numeric > cap then
        raise exception 'Suggested amounts must be positive integer minor units within the checkout limit.';
      end if;
    end loop;
    select jsonb_agg(n order by n) into amounts
      from (select distinct value::text::numeric::bigint n from jsonb_array_elements(amounts)) x;
    normalized := normalized || jsonb_build_object(kind, amounts);
  end loop;
  new.amount_presets := normalized;
  return new;
end $$;
revoke all on function public.guard_wedding_amount_presets() from public, anon, authenticated;
drop trigger if exists guard_wedding_amount_presets on public.weddings;
create trigger guard_wedding_amount_presets before insert or update of amount_presets, currency
  on public.weddings for each row execute function public.guard_wedding_amount_presets();

-- Wrap the preceding public projection rather than re-copying its publication, moderation
-- and sandbox-fund filters. Keep the underlying function private.
do $$ begin
  if to_regprocedure('public.get_public_wedding_site_before_amount_presets(text)') is null then
    alter function public.get_public_wedding_site(text) rename to get_public_wedding_site_before_amount_presets;
  end if;
end $$;
revoke all on function public.get_public_wedding_site_before_amount_presets(text) from public, anon, authenticated;
create or replace function public.get_public_wedding_site(p_slug text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with site as materialized (select public.get_public_wedding_site_before_amount_presets(p_slug) payload)
  select site.payload || jsonb_build_object('amount_presets', w.amount_presets)
  from site join public.weddings w on w.id = (site.payload->>'id')::uuid;
$$;
revoke all on function public.get_public_wedding_site(text) from public;
grant execute on function public.get_public_wedding_site(text) to anon, authenticated;
