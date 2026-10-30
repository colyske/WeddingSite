-- Isolated local CI only; every fixture is rolled back. No provider is contacted.
begin;
do $$
declare oid uuid := extensions.gen_random_uuid(); cid uuid := extensions.gen_random_uuid();
  wid uuid := extensions.gen_random_uuid(); lid uuid; blocked boolean; paid_rows integer;
begin
  insert into auth.users(id, email, email_confirmed_at) values(oid, 'colyske@gmail.com', now());
  perform public.bootstrap_protected_owner(oid);
  insert into auth.users(id) values(cid);
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wid,cid,'Live guard sample','KES',current_date+30);
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,cid,'client')
    on conflict do nothing;

  if (select approved or payouts_enabled from public.daraja_live_approval) then
    raise exception 'Live approval and payouts must default OFF';
  end if;

  -- Not approved: a live row cannot be admitted.
  blocked := false;
  begin insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,daraja_shortcode)
    values(wid,'Live',10000,'KES','pending','daraja','live','174379');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Live admission must require Owner approval'; end if;

  -- Non-Owner cannot approve; Owner can.
  perform set_config('request.jwt.claim.sub', cid::text, true);
  blocked := false;
  begin perform public.owner_set_daraja_live_approval(true,'174379');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'Only the Owner may approve live Daraja'; end if;
  perform set_config('request.jwt.claim.sub', oid::text, true);
  perform public.owner_set_daraja_live_approval(true,'174379');

  -- Wrong shortcode, non-KES, pre-set reference, pre-paid are all rejected.
  blocked := false;
  begin insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,daraja_shortcode)
    values(wid,'Live',10000,'KES','pending','daraja','live','999999');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Shortcode mismatch must be rejected'; end if;
  blocked := false;
  begin insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,currency,
      payment_status,provider_name,payment_environment,daraja_shortcode,verified_provider_payment)
    values(wid,'Live',10000,10000,'KES','paid','daraja','live','174379',true);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Live rows must not be admitted as paid'; end if;
  blocked := false;
  begin insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,daraja_shortcode)
    values(wid,'Live',10000,'USD','pending','daraja','live','174379');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Live rows must be KES'; end if;
  blocked := false;
  begin insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,daraja_shortcode)
    values(wid,'Live',10000,'KES','pending','stripe','live','174379');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Only Daraja may be live'; end if;

  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,daraja_shortcode)
    values(wid,'Live',10000,'KES','pending','daraja','live','174379') returning id into lid;

  -- Direct status update without persisted context is blocked.
  blocked := false;
  begin update public.contributions set payment_status='paid', paid_amount_minor=10000,
      verified_provider_payment=true where id=lid;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Direct paid update without context must fail'; end if;

  -- Generic service-role RPC cannot settle a row with null stored reference (the guard, not the role check, must fire).
  perform set_config('request.jwt.claim.role','service_role',true);
  blocked := false;
  begin perform public.record_verified_payment('daraja','evt-live-1',lid,10000,'KES','ws_CO_FAKE',null,null);
  exception when raise_exception then
    blocked := true;
    if sqlerrm not like 'Live payment cannot settle%' then raise exception 'Wrong rejection: %', sqlerrm; end if;
  end;
  if not blocked then raise exception 'Generic RPC must not settle live without persisted reference'; end if;
  blocked := false;
  perform set_config('request.jwt.claim.role','authenticated',true);
  begin perform public.record_verified_payment('daraja','evt-live-x',lid,10000,'KES','ws_CO_FAKE',null,null);
  exception when raise_exception then blocked := sqlerrm = 'Service role required.'; end;
  if not blocked then raise exception 'Non-service callers must be rejected'; end if;

  -- Persist context, then context becomes immutable.
  update public.contributions set provider_reference='ws_CO_FAKE', daraja_merchant_request_id='MR-1' where id=lid;
  blocked := false;
  begin update public.contributions set provider_reference='ws_CO_OTHER' where id=lid;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Provider reference must be immutable'; end if;
  blocked := false;
  begin update public.contributions set payment_environment='test' where id=lid;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Environment must be immutable'; end if;

  -- With persisted context the service RPC settles once (idempotent), fee stays pending.
  perform set_config('request.jwt.claim.role','service_role',true);
  if not public.record_verified_payment('daraja','evt-live-1',lid,10000,'KES','ws_CO_FAKE',null,null) then
    raise exception 'Live settlement with persisted context should succeed';
  end if;
  if public.record_verified_payment('daraja','evt-live-1',lid,10000,'KES','ws_CO_FAKE',null,null) then
    raise exception 'Repeated live event must be idempotent';
  end if;
  if not exists(select 1 from public.contributions where id=lid and payment_status='paid'
      and provider_fee_pending and verified_provider_payment) then
    raise exception 'Live settlement must hold funds with provider fee pending';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub', cid::text, true);
  update public.contributions set funds_available_at=now()-interval '10 days' where id=lid;
  if (select available_minor from public.withdrawable_balance(wid,'KES')) <> 0 then
    raise exception 'Live funds must stay unwithdrawable while the payout gate is off';
  end if;
  blocked := false;
  begin insert into public.payout_records(wedding_id,amount_minor,currency,requested_by)
    values(wid,1000,'KES',cid);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Admitted live rows must not unlock direct payouts'; end if;
  blocked := false;
  begin insert into public.payout_records(wedding_id,amount_minor,currency,requested_by,status)
    values(wid,1000,'KES',cid,'sent');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Direct sent payout must be blocked'; end if;

  -- Payout gate cannot be turned on by this migration's schema.
  blocked := false;
  begin update public.daraja_live_approval set payouts_enabled=true;
  exception when others then blocked := true; end;
  if not blocked then raise exception 'payouts_enabled must be constrained to false'; end if;
end $$;

-- Real GRANT/RLS coverage as the authenticated and anon roles.
do $$
declare cid uuid := (select id from auth.users where email is null order by created_at desc limit 1);
  blocked boolean;
begin
  perform set_config('request.jwt.claim.sub', cid::text, true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  set local role authenticated;
  blocked := false;
  begin perform 1 from public.daraja_live_approval;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Approval table must not be readable by authenticated'; end if;
  blocked := false;
  begin update public.daraja_live_approval set approved=false;
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Approval table must not be writable by authenticated'; end if;
  blocked := false;
  begin perform public.owner_set_daraja_live_approval(true,'174379');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Non-Owner approval RPC must fail'; end if;
  blocked := false;
  begin perform public.record_verified_payment('daraja','e',extensions.gen_random_uuid(),10000,'KES','r',null,null);
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Authenticated must not execute the settlement RPC'; end if;
  set local role anon;
  blocked := false;
  begin perform public.owner_get_daraja_live_approval();
  exception when insufficient_privilege then blocked := true; end;
  if not blocked then raise exception 'Anon must not execute the approval RPC'; end if;
  reset role;
end $$;
rollback;
