-- Retryable legacy finance RPCs must enter the accounting lock before their
-- role check and any wedding, commitment or budget row lock. Existing
-- nonblocking row-trigger guards remain in place for other writers.
do $$
declare item record; original text; anchor text; updated text;
begin
  for item in select * from (values
    ('public.record_expense(uuid,text,text,bigint,text,date,boolean)'),
    ('public.record_reconciliation(uuid,text,text,bigint,bigint,text,text,boolean)'),
    ('public.save_budget_line(uuid,text,bigint,bigint,text,boolean)'),
    ('public.request_payout(uuid,bigint,text,text,boolean)')
  ) as entries(signature)
  loop
    original:=pg_get_functiondef(item.signature::regprocedure);
    anchor:='if not public.has_wedding_role(p_wedding_id,';
    if (length(original)-length(replace(original,anchor,'')))/length(anchor) <> 1 then
      raise exception 'Unexpected finance lock predecessor: %',item.signature;
    end if;
    updated:=replace(original,anchor,
      'perform pg_advisory_xact_lock(71110001);' || E'\n  ' || anchor);
    execute updated;
  end loop;
end $$;
