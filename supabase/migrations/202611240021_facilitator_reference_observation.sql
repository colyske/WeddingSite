-- Route facilitator reference collisions through the existing durable
-- incident/hold branches before the defensive receipt triggers can reject.
do $$
declare
  item record;
  definition text;
  marker text;
  updated text;
begin
  for item in
    select * from (values
      ('public.simple_payout_action(uuid,uuid,text,text,bigint,text,boolean,boolean,boolean)',
       'c.provider', 'ref'),
      ('public.manual_payout_report(uuid,text,bigint,bigint,text,timestamptz,uuid)',
       'a.provider', 'upper(btrim(p_reference))'),
      ('public.b2c_reconcile(uuid,uuid,uuid,text,uuid,uuid,uuid,text,bigint,bigint,text,text,timestamptz,timestamptz)',
       'a.provider', 'upper(btrim(p_reference))')
    ) as targets(signature, provider_expression, reference_expression)
  loop
    definition := pg_get_functiondef(item.signature::regprocedure);
    marker := 'if exists(select 1 from public.simple_payout_receipts where provider=' || item.provider_expression;
    if length(definition) - length(replace(definition,marker,'')) <> length(marker) then
      raise exception 'Unexpected reference conflict branch: %', item.signature;
    end if;
    updated := replace(definition, marker,
      'if exists(select 1 from public.facilitator_manual_receipts where provider=' ||
      item.provider_expression || ' and transaction_reference=' || item.reference_expression || ') or ' ||
      substr(marker,4));
    execute updated;
  end loop;
end $$;
