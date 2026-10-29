-- Isolated local/CI database only. Fixtures and changes are rolled back.
begin;
do $$
declare owner_id uuid := extensions.gen_random_uuid(); wedding_id uuid := extensions.gen_random_uuid();
  actual jsonb; candidate jsonb; blocked boolean;
begin
  insert into auth.users(id) values(owner_id);
  insert into public.weddings(id,client_owner_id,slug,couple_names,wedding_date,currency)
    values(wedding_id,owner_id,'amount-presets-local','Local amount sample',current_date+90,'KES');
  perform set_config('qa.amount_wedding_id',wedding_id::text,true);
  perform set_config('qa.amount_owner_id',owner_id::text,true);
  if (select amount_presets from public.weddings where id=wedding_id) is not null then
    raise exception 'Existing/unset defaults must remain unset'; end if;
  update public.platform_policies set max_contribution_minor=500000;
  update public.weddings set amount_presets='{"currency":"KES","song":[50000,10000,50000],"gift":[500000,50000]}'
    where id=wedding_id;
  select amount_presets into actual from public.weddings where id=wedding_id;
  if actual <> '{"currency":"KES","song":[10000,50000],"gift":[50000,500000]}'::jsonb then
    raise exception 'Presets must roundtrip sorted and deduplicated'; end if;
  blocked := false;
  begin update public.weddings set currency='USD' where id=wedding_id;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Currency changes must not reinterpret saved presets'; end if;
  foreach candidate in array array[
    '{"currency":"USD","song":[100],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[0],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[99],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[-1],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[1.5],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[500001],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":["100"],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[1,2,3,4,5,6,7],"gift":[100]}'::jsonb,
    '{"currency":"KES","song":[100]}'::jsonb
  ] loop
    blocked := false;
    begin update public.weddings set amount_presets=candidate where id=wedding_id;
    exception when raise_exception then blocked := true; end;
    if not blocked then raise exception 'Invalid suggestion list was accepted: %', candidate; end if;
  end loop;
  update public.weddings set currency='USD',amount_presets='{"currency":"USD","song":[500,1000],"gift":[1000,2500]}'
    where id=wedding_id;
  -- Unrelated edits do not rewrite choices, even if a policy cap later falls.
  update public.platform_policies set max_contribution_minor=100;
  update public.weddings set welcome_story='Unrelated edit',currency='USD' where id=wedding_id;
  if (select amount_presets->'song' from public.weddings where id=wedding_id) <> '[500,1000]'::jsonb then
    raise exception 'Unrelated edits must preserve saved selections'; end if;
  if public.get_public_wedding_site('amount-presets-local') is not null then
    raise exception 'Unpublished wedding must remain private'; end if;
  update public.weddings set published_at=now() where id=wedding_id;
  if public.get_public_wedding_site('amount-presets-local')->'amount_presets'
      <> '{"currency":"USD","song":[500,1000],"gift":[1000,2500]}'::jsonb then
    raise exception 'Public wedding JSON must include saved presets'; end if;
  update public.weddings set archived_at=now() where id=wedding_id;
  if public.get_public_wedding_site('amount-presets-local') is not null then
    raise exception 'Archived wedding must remain private'; end if;
  update public.weddings set currency='KES',amount_presets=null where id=wedding_id;
  blocked := false;
  begin update public.weddings set currency='JPY', amount_presets='{"currency":"JPY","song":[1],"gift":[1]}' where id=wedding_id;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Non-two-decimal accounting must be rejected'; end if;
  update public.platform_policies set max_contribution_minor=500000;
end $$;
-- Column permission does not broaden row ownership.
set local role authenticated;
select set_config('request.jwt.claim.sub',extensions.gen_random_uuid()::text,true);
do $$
declare affected integer;
begin
  update public.weddings set amount_presets='{"currency":"KES","song":[100],"gift":[100]}'
    where id=current_setting('qa.amount_wedding_id')::uuid;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Another organizer must not edit presets'; end if;
end $$;
select set_config('request.jwt.claim.sub',current_setting('qa.amount_owner_id'),true);
do $$
declare affected integer;
begin
  update public.weddings set amount_presets='{"currency":"KES","song":[100],"gift":[100]}'
    where id=current_setting('qa.amount_wedding_id')::uuid;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Owner must be able to edit presets with existing RLS'; end if;
end $$;
reset role;
rollback;
