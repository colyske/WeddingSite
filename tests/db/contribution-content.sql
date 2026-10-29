-- Local isolated database only; every fixture is rolled back.
begin;
do $$
declare client_id uuid := extensions.gen_random_uuid(); staff_id uuid := extensions.gen_random_uuid(); wedding_id uuid := extensions.gen_random_uuid();
  payment_id uuid := extensions.gen_random_uuid(); blocked boolean; row_count integer; amount bigint; person text; kind text;
begin
  if not public.free_text_has_contact('email name [at] example [dot] com')
    or not public.free_text_has_contact('call +254 700 000 001')
    or not public.free_text_has_contact('call zero seven zero zero zero zero zero zero zero one')
    or public.free_text_has_contact('Celebrate on 2099-08-16 with KES 2,500 and 150 guests') then
    raise exception 'Contact detection or date/amount exemption failed';
  end if;
  if public.content_has_contact('{"phone":"254700000001","email":"sample@example.com","socialLinks":{"instagram":"https://instagram.com/sample"}}')
    or not public.content_has_contact('{"story":"email sample@example.com"}') then
    raise exception 'Designated fields must remain exempt; free text must be checked';
  end if;
  insert into auth.users (id) values (client_id), (staff_id);
  update public.profiles set platform_role = 'superadmin' where id = staff_id;
  perform set_config('request.jwt.claim.sub', client_id::text, true);
  blocked := false;
  begin
    perform public.admin_set_payment_controls(array['daraja'], true);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Clients must not control platform payment methods'; end if;
  perform set_config('request.jwt.claim.sub', staff_id::text, true);
  perform public.admin_set_payment_controls(array['daraja'], true);
  if public.admin_get_payment_controls() <> array['daraja'] then raise exception 'SuperAdmin must independently enable M-Pesa'; end if;
  insert into public.weddings (id, client_owner_id, couple_names, wedding_date, currency, published_at)
    values (wedding_id, client_id, 'Local sample couple', current_date + 30, 'KES', now());
  blocked := false;
  begin
    insert into public.contributions (wedding_id, stream_name, pledged_amount_minor, currency, payment_status, provider_name)
      values (wedding_id, 'Local disabled provider check', 100, 'KES', 'pending', 'paystack');
  exception when check_violation then blocked := true; end;
  if not blocked then raise exception 'Disabled provider must block new intents at the database boundary'; end if;
  perform public.admin_set_payment_controls(array['paystack'], true);
  if public.admin_get_payment_controls() <> array['paystack'] then raise exception 'Admin must independently enable Card'; end if;
  perform public.admin_set_payment_controls(array[]::text[], true);
  if cardinality(public.admin_get_payment_controls()) <> 0 then raise exception 'Admin can disable all new payments'; end if;
  perform public.admin_set_payment_controls(array['stripe','paystack','daraja'], true);
  blocked := false;
  begin
    update public.weddings set welcome_story = 'Call +254700000001' where id = wedding_id;
  exception when check_violation then blocked := true; end;
  if not blocked then raise exception 'Direct content writes must reject contact details'; end if;
  blocked := false;
  begin
    update public.weddings set slug = 'showcase-wedding' where id = wedding_id;
  exception when check_violation then blocked := true; end;
  if not blocked then raise exception 'Virtual showcase slug must be reserved'; end if;
  insert into public.contributions (id, wedding_id, stream_name, pledged_amount_minor, paid_amount_minor,
    platform_fee_minor, net_paid_minor, currency, payment_status, display_name, visibility, public_consent_at,
    verified_provider_payment, purchase_action, purchase_data)
    values (payment_id, wedding_id, 'Song support', 250000, 250000, 20000, 230000, 'KES', 'paid',
      'Private sample name', 'anonymous', now(), true, 'song_bid', '{"socialLinks":{"instagram":"https://instagram.com/example"}}');
  select count(*), max(paid_amount_minor), max(guest_display_name), max(contribution_type)
    into row_count, amount, person, kind from public.get_published_contributions_page(wedding_id);
  if row_count <> 1 or amount <> 250000 or person <> 'Anonymous' or kind <> 'Song bid' then
    raise exception 'Confirmed public ledger must preserve amount, type and anonymity';
  end if;
  update public.contributions set visibility = 'hidden', public_consent_at = null where id = payment_id;
  if exists (select 1 from public.get_published_contributions_page(wedding_id)) then
    raise exception 'Hidden contributions must never be published';
  end if;
  insert into public.sponsors (wedding_id, company_name, amount_minor, contribution_id)
    values (wedding_id, 'Local sample sponsor', 250000, payment_id);
  if not exists (select 1 from public.sponsors where contribution_id = payment_id
    and social_links->>'instagram' = 'https://instagram.com/example') then
    raise exception 'Verified sponsor purchase social links must be copied';
  end if;
end $$;
rollback;
