-- Runs only in the isolated local/CI database; all fixture writes roll back.
begin;
insert into auth.users(id,email,email_confirmed_at) values
  ('79000000-0000-4000-8000-000000000011','colyske@gmail.com',now()),
  ('79000000-0000-4000-8000-000000000012','currency-client@example.test',now());
select public.bootstrap_protected_owner('79000000-0000-4000-8000-000000000011');
insert into public.weddings(id,client_owner_id,slug,couple_names,wedding_date,currency)
  values('79000000-0000-4000-8000-000000000013','79000000-0000-4000-8000-000000000011',
    'currency-policy-existing','Existing wedding',current_date+200,'USD');
select set_config('request.jwt.claim.sub','79000000-0000-4000-8000-000000000011',true);
create temporary table currency_policy_before as
  select to_jsonb(pp) - array['default_currency','updated_by','updated_at'] as policy
  from public.platform_policies pp where pp.id;
create temporary table currency_wedding_before as
  select to_jsonb(w) as wedding from public.weddings w
  where w.id='79000000-0000-4000-8000-000000000013';
create temporary table currency_quote_before as
  select public.publication_quote('79000000-0000-4000-8000-000000000013') as quote;
create temporary table currency_history_before as
  select count(*) as count from public.platform_policy_history;
create temporary table currency_history_rows_before as
  select id,to_jsonb(h) as row from public.platform_policy_history h;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','79000000-0000-4000-8000-000000000011',true);
do $$
declare saved jsonb; repeated jsonb;
begin
  saved := public.owner_set_default_currency(' KES ',true);
  if saved->>'default_currency' <> 'KES' or saved->>'changed' <> 'true' then
    raise exception 'Owner default currency was not normalized and saved';
  end if;
  repeated := public.owner_set_default_currency('KES',true);
  if repeated->>'changed' <> 'false' then raise exception 'No-op setting should not create a policy revision'; end if;
end $$;
select set_config('request.jwt.claim.sub','79000000-0000-4000-8000-000000000012',true);
do $$
declare blocked boolean := false;
begin
  begin perform public.owner_set_default_currency('EUR',true);
  exception when raise_exception then blocked := sqlerrm like 'Only the protected Owner%'; end;
  if not blocked then raise exception 'Non-owner changed the platform default currency'; end if;
end $$;
select set_config('request.jwt.claim.sub','79000000-0000-4000-8000-000000000011',true);
do $$
declare blocked boolean := false; cleared jsonb;
begin
  begin
    perform public.owner_set_default_currency('EUR',false);
    raise exception 'Unconfirmed Owner setting was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Confirmation is required%' then raise; end if;
  end;
  begin
    perform public.owner_set_default_currency('US$',true);
  exception when check_violation then blocked := true;
    when raise_exception then blocked := sqlerrm like 'Default currency must be%'; end;
  if not blocked then raise exception 'Invalid currency code was accepted'; end if;
  cleared := public.owner_set_default_currency(null,true);
  if cleared->>'default_currency' is not null or cleared->>'changed' <> 'true' then
    raise exception 'Owner could not clear the default currency';
  end if;
end $$;
reset role;

do $$
declare q jsonb;
begin
  if (select count(*) from public.platform_policy_history) <>
      (select count+2 from currency_history_before) then
    raise exception 'Currency changes did not create exactly two audited revisions';
  end if;
  if exists(select 1 from currency_history_rows_before b left join public.platform_policy_history h on h.id=b.id
      where h.id is null or to_jsonb(h) is distinct from b.row) then
    raise exception 'An existing platform policy history record changed';
  end if;
  if not exists(select 1 from public.platform_policy_history h
      where h.new_values->>'default_currency'='KES' and h.old_values->>'default_currency' is null) or
      not exists(select 1 from public.platform_policy_history h
        where h.old_values->>'default_currency'='KES' and h.new_values->>'default_currency' is null) then
    raise exception 'Old/new default currency values were not audited';
  end if;
  if (select count(*) from public.audit_events a
      where a.actor_id='79000000-0000-4000-8000-000000000011'
        and a.action='policy_update' and a.table_name='platform_policies'
        and a.changed_fields=array['default_currency']) <> 2 then
    raise exception 'Owner currency changes were not recorded in the audit log';
  end if;
  if (select to_jsonb(pp) - array['default_currency','updated_by','updated_at']
        from public.platform_policies pp where pp.id) is distinct from
      (select policy from currency_policy_before) then
    raise exception 'Changing the default currency altered financial policy';
  end if;
  if (select default_currency from public.platform_policies where id) is not null then
    raise exception 'Clearing the default left a configured currency';
  end if;
  if (select to_jsonb(w) from public.weddings w
        where w.id='79000000-0000-4000-8000-000000000013') is distinct from
      (select wedding from currency_wedding_before) then
    raise exception 'Changing the default currency altered an existing wedding';
  end if;
  q := public.publication_quote('79000000-0000-4000-8000-000000000013');
  if (select quote->>'fee_minor' from currency_quote_before) is distinct from q->>'fee_minor'
      or (select quote->>'usd_amount_minor' from currency_quote_before) is distinct from q->>'usd_amount_minor'
      or (select quote->>'currency' from currency_quote_before) is distinct from q->>'currency' then
    raise exception 'Default currency changed an existing USD publication quote';
  end if;
end $$;
rollback;
