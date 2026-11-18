-- Verify the retryable entry points take the shared lock before source rows.
begin;
do $$
declare
  item record;
  definition text;
  lock_at integer;
begin
  for item in select * from (values
    ('public.referral_set_consent(boolean,text)','insert into public.referral_accounts'),
    ('public.referral_capture(text)','from public.profiles'),
    ('public.referral_owner_policy(boolean,integer,uuid,boolean)','from public.referral_policy where singleton for update'),
    ('public.admin_resolve_provider_refund(uuid,text,boolean)','from public.contributions where id = a.contribution_id for update'),
    ('public.admin_match_unresolved_refund(bigint,uuid,boolean)','from public.provider_adjustment_events where id = p_event_id for update'),
    ('public.admin_set_refund_policy(text,boolean)','from public.platform_policies where id for update'),
    ('public.admin_save_policies(jsonb)','from public.platform_policies where id for update')
  ) as entries(signature, first_source_lock)
  loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    lock_at:=strpos(definition,'perform pg_advisory_xact_lock(71110001);');
    if lock_at=0 or strpos(definition,item.first_source_lock)=0
      or lock_at>=strpos(definition,item.first_source_lock) then
      raise exception 'Missing or late accounting lock: %',item.signature;
    end if;
    if has_function_privilege('anon',item.signature,'execute')
      or not has_function_privilege('authenticated',item.signature,'execute') then
      raise exception 'Changed authenticated entry point permissions: %',item.signature;
    end if;
  end loop;
  for item in select * from (values
    ('public.record_expense(uuid,text,text,bigint,text,date,boolean)','insert into public.expenses'),
    ('public.record_reconciliation(uuid,text,text,bigint,bigint,text,text,boolean)','insert into public.reconciliation_records'),
    ('public.save_budget_line(uuid,text,bigint,bigint,text,boolean)','insert into public.budget_lines'),
    ('public.request_payout(uuid,bigint,text,text,boolean)','from public.weddings where id = p_wedding_id for update')
  ) as entries(signature,first_source_lock)
  loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    lock_at:=strpos(definition,'perform pg_advisory_xact_lock(71110001);');
    if lock_at=0 or strpos(definition,'if not public.has_wedding_role(p_wedding_id,')>=lock_at
      or strpos(substr(definition,lock_at),'if not public.has_wedding_role(p_wedding_id,')=0
      or strpos(definition,item.first_source_lock)=0 or lock_at>=strpos(definition,item.first_source_lock)
      or has_function_privilege('anon',item.signature,'execute')
      or not has_function_privilege('authenticated',item.signature,'execute') then
      raise exception 'Missing finance authorization or lock ordering: %',item.signature;
    end if;
  end loop;
end $$;
rollback;
