-- Retryable referral and refund-review mutations acquire the accounting lock
-- before their source rows. Preserve the existing functions and permissions.
do $$
declare
  item record;
  original text;
  updated text;
begin
  for item in select * from (values
    ('public.referral_set_consent(boolean,text)',
      'if auth.uid() is null then raise exception ''Referral authentication required.''; end if;'),
    ('public.referral_capture(text)',
      'if auth.uid() is null then raise exception ''Referral authentication required.''; end if;'),
    ('public.referral_owner_policy(boolean,integer,uuid,boolean)',
      'perform public.require_staff(''owner'');'),
    ('public.admin_resolve_provider_refund(uuid,text,boolean)',
      'perform public.require_staff();'),
    ('public.admin_match_unresolved_refund(bigint,uuid,boolean)',
      'perform public.require_staff();'),
    ('public.admin_set_refund_policy(text,boolean)',
      'if public.current_platform_role() is distinct from ''owner'' then raise exception ''Only the protected Owner can change refund allocation.''; end if;'),
    ('public.admin_save_policies(jsonb)',
      'if public.current_platform_role() is distinct from ''owner'' then raise exception ''Only the protected Owner can change platform financial policies.''; end if;')
  ) as entries(signature, anchor)
  loop
    original:=pg_get_functiondef(item.signature::regprocedure);
    if (length(original)-length(replace(original,item.anchor,'')))/length(item.anchor) <> 1 then
      raise exception 'Unexpected source lock predecessor: %',item.signature;
    end if;
    updated:=replace(original,item.anchor,
      item.anchor || E'\n  perform pg_advisory_xact_lock(71110001);');
    execute updated;
  end loop;
end $$;
