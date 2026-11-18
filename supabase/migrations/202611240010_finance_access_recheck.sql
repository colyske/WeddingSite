-- Reject unauthorized callers before they can queue on the shared accounting
-- lock. Repeat the same check after waiting; membership changes are not
-- universally serialized by this lock.
do $$
declare item record; definition text; anchor text; start_at integer; end_at integer;
  role_check text; replacement text;
begin
  for item in select * from (values
    ('public.record_expense(uuid,text,text,bigint,text,date,boolean)'),
    ('public.record_reconciliation(uuid,text,text,bigint,bigint,text,text,boolean)'),
    ('public.save_budget_line(uuid,text,bigint,bigint,text,boolean)'),
    ('public.request_payout(uuid,bigint,text,text,boolean)')
  ) as entries(signature)
  loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    anchor:='perform pg_advisory_xact_lock(71110001);' || E'\n  ' ||
      'if not public.has_wedding_role(p_wedding_id,';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
      raise exception 'Unexpected finance authorization predecessor: %',item.signature;
    end if;
    start_at:=strpos(definition,anchor)+length('perform pg_advisory_xact_lock(71110001);' || E'\n  ');
    end_at:=strpos(substr(definition,start_at),'end if;');
    if end_at=0 then raise exception 'Missing finance authorization boundary: %',item.signature; end if;
    role_check:=substr(definition,start_at,end_at+length('end if;')-1);
    replacement:=role_check || E'\n  perform pg_advisory_xact_lock(71110001);\n  ' || role_check;
    definition:=replace(definition,'perform pg_advisory_xact_lock(71110001);' || E'\n  ' || role_check,replacement);
    execute definition;
  end loop;
end $$;
