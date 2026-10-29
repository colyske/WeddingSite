-- Isolated local CI database only. All fixtures and effects are rolled back.
begin;
-- Model future real funds only for this isolated KYC regression. The separate
-- support-boundaries regression verifies the production live-settlement guard.
alter table public.contributions disable trigger guard_payment_environment;

do $$
<<payout_kyc_test>>
declare
  client_id uuid := extensions.gen_random_uuid();
  staff_id uuid := extensions.gen_random_uuid();
  wedding_id uuid := extensions.gen_random_uuid();
  payout_id uuid;
  cancel_id uuid;
  blocked boolean;
begin
  insert into auth.users (id) values (client_id), (staff_id);
  update public.profiles set platform_role = 'admin' where id = staff_id;
  insert into public.weddings (id, couple_names, client_owner_id, currency, wedding_date)
    values (wedding_id, 'Local KYC test couple', client_id, 'KES', current_date + 30);
  insert into public.wedding_memberships (wedding_id, user_id, role) values (wedding_id, client_id, 'client');
  perform set_config('request.jwt.claim.sub', client_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  blocked := false;
  begin
    perform public.request_payout(wedding_id, 1000, 'KES', null, true);
  exception when raise_exception then
    if sqlerrm not like 'PAYOUT_KYC_REQUIRED:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'Missing KYC must block payout requests'; end if;

  insert into public.wedding_kyc (wedding_id, partner1_legal_name, partner1_id_type, partner1_id_number,
    partner1_nationality, partner1_phone, partner1_email, consent_at)
  values (wedding_id, 'Test Partner One', 'passport', 'TEST1234', 'Kenyan', '254700000001', 'one@example.test', now());
  blocked := false;
  begin
    perform public.request_payout(wedding_id, 1000, 'KES', null, true);
  exception when raise_exception then
    if sqlerrm not like 'PAYOUT_KYC_REQUIRED:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'Partner two missing must block payout requests'; end if;

  update public.wedding_kyc set partner2_legal_name = 'Test Partner Two', partner2_id_type = 'passport',
    partner2_id_number = 'TEST5678', partner2_nationality = 'Kenyan', partner2_phone = '254700000002',
    partner2_email = 'two@example.test', consent_at = null where public.wedding_kyc.wedding_id = payout_kyc_test.wedding_id;
  blocked := false;
  begin
    perform public.request_payout(wedding_id, 1000, 'KES', null, true);
  exception when raise_exception then
    if sqlerrm not like 'PAYOUT_KYC_REQUIRED:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'Missing consent must block payout requests'; end if;

  update public.wedding_kyc k set consent_at = now() where k.wedding_id = payout_kyc_test.wedding_id;
  insert into public.contributions (wedding_id, stream_name, pledged_amount_minor, paid_amount_minor,
    platform_fee_minor, net_paid_minor, currency, payment_status, verified_provider_payment, provider_fee_pending, provider_fee_minor, payment_environment)
  values (wedding_id, 'Local future live-funds fixture', 100000, 100000, 0, 100000, 'KES', 'paid', true, false, 0, 'live');
  payout_id := public.request_payout(wedding_id, 1000, 'KES', 'Local test', true);
  if payout_id is null then raise exception 'Complete KYC and funds must allow payout request'; end if;
  cancel_id := public.request_payout(wedding_id, 1000, 'KES', 'Local cancellation test', true);

  -- Existing requests must be rechecked if identity details become incomplete.
  update public.wedding_kyc k set partner2_id_number = null where k.wedding_id = payout_kyc_test.wedding_id;
  perform set_config('request.jwt.claim.sub', staff_id::text, true);
  blocked := false;
  begin
    perform public.admin_set_payout_status(payout_id, 'approved');
  exception when raise_exception then
    if sqlerrm not like 'PAYOUT_KYC_REQUIRED:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'Incomplete KYC must block payout approval'; end if;
  if (select status from public.payout_records where id = payout_id) <> 'requested' then
    raise exception 'Blocked approval must not change the payout';
  end if;
  perform public.admin_set_payout_status(cancel_id, 'cancelled');

  update public.wedding_kyc k set partner2_id_number = 'TEST5678' where k.wedding_id = payout_kyc_test.wedding_id;
  perform public.admin_set_payout_status(payout_id, 'approved');
  update public.wedding_kyc k set consent_at = null where k.wedding_id = payout_kyc_test.wedding_id;
  blocked := false;
  begin
    perform public.admin_set_payout_status(payout_id, 'sent');
  exception when raise_exception then
    if sqlerrm not like 'PAYOUT_KYC_REQUIRED:%' then raise; end if;
    blocked := true;
  end;
  if not blocked then raise exception 'Incomplete KYC must block marking a payout sent'; end if;
  if (select status from public.payout_records where id = payout_id) <> 'approved' then
    raise exception 'Blocked sent transition must not change the payout';
  end if;
  update public.wedding_kyc k set consent_at = now() where k.wedding_id = payout_kyc_test.wedding_id;
  perform public.admin_set_payout_status(payout_id, 'sent');
  if (select status from public.payout_records where id = payout_id) <> 'sent' then
    raise exception 'Complete KYC must allow the normal approved-to-sent transition';
  end if;

  if position('kyc' in lower(pg_get_functiondef('public.publish_wedding_with_fee(uuid,boolean)'::regprocedure))) > 0 then
    raise exception 'Publishing must remain independent of KYC';
  end if;
end $$;

rollback;
