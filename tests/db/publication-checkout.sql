-- Isolated CI database only; never run against Production.
begin;
do $$
declare client_id uuid := extensions.gen_random_uuid(); stranger_id uuid := extensions.gen_random_uuid();
  wedding_id uuid := extensions.gen_random_uuid(); checkout public.publication_checkouts; other public.publication_checkouts;
  blocked boolean; q jsonb; contributions_before bigint; audits_before bigint;
begin
  insert into auth.users(id) values(client_id),(stranger_id);
  update public.platform_policies set publication_fee_minor=2500,far_future_fee_minor=5000,
    far_future_months=18,free_publications_per_client=1,enabled_payment_providers=array['daraja','paystack'];
  insert into public.weddings(id,client_owner_id,slug,couple_names,wedding_date,currency)
    values(wedding_id,client_id,'publication-local-check','Local publication sample',current_date+800,'KES');
  insert into public.venues(wedding_id,name,event_date,event_time)
    values(wedding_id,'Sample venue',current_date+800,'12:00');
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  q := public.publication_quote(wedding_id);
  if (q->>'fee_minor')::bigint <> 5000 or q->>'code' <> 'far_future' then
    raise exception 'Far-future fee must take precedence over free allowance'; end if;
  blocked := false;
  begin perform public.publish_wedding_with_fee(wedding_id,true);
  exception when raise_exception then blocked := sqlerrm like 'PAYMENT_REQUIRED%'; end;
  if not blocked or (select published_at is not null from public.weddings where id=wedding_id) then
    raise exception 'Unpaid publication must fail closed'; end if;
  perform set_config('request.jwt.claim.sub',stranger_id::text,true);
  blocked := false;
  begin perform public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'daraja',5000,'KES');
  exception when raise_exception then blocked := sqlerrm like 'Access denied%'; end;
  if not blocked then raise exception 'Checkout must enforce wedding ownership'; end if;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  blocked := false;
  begin perform public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'stripe',5000,'KES');
  exception when raise_exception then blocked := sqlerrm like 'Payment method disabled%'; end;
  if not blocked then raise exception 'Disabled provider must fail closed'; end if;
  blocked := false;
  begin perform public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'daraja',2500,'KES');
  exception when raise_exception then blocked := sqlerrm like 'Publication quote changed%'; end;
  if not blocked then raise exception 'Stale quote must not initiate checkout'; end if;
  checkout := public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'daraja',5000,'KES');
  other := public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'paystack',5000,'KES');
  if other.id <> checkout.id then raise exception 'Cross-tab retry must reuse unresolved checkout'; end if;
  update public.publication_checkouts set provider_reference='local-stk-reference' where id=checkout.id;
  update public.platform_policies set far_future_fee_minor=9000,enabled_payment_providers=array[]::text[];
  blocked := false;
  begin perform public.record_verified_publication_payment(checkout.id,'daraja','wrong-reference',5000,'KES','local-event');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Mismatched reference must never settle'; end if;
  blocked := false;
  begin perform public.record_verified_publication_payment(checkout.id,'daraja','local-stk-reference',9000,'KES','local-event');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Mismatched amount must never settle'; end if;
  select count(*) into contributions_before from public.contributions;
  if not public.record_verified_publication_payment(checkout.id,'daraja','local-stk-reference',5000,'KES','local-event') then
    raise exception 'Immutable admitted quote must settle even after policy/provider changes'; end if;
  select count(*) into audits_before from public.audit_events where record_id=checkout.id::text;
  perform public.record_verified_publication_payment(checkout.id,'daraja','local-stk-reference',5000,'KES','duplicate-event');
  if (select count(*) from public.audit_events where record_id=checkout.id::text) <> audits_before then
    raise exception 'Duplicate callbacks must be idempotent'; end if;
  if (select count(*) from public.contributions) <> contributions_before then
    raise exception 'Publication settlement must never credit wedding contributions'; end if;
  if not exists(select 1 from public.publication_fees pf where pf.wedding_id=checkout.wedding_id
    and status='test_paid' and amount_minor=5000 and provider='daraja-test') then
    raise exception 'Test settlement must not be marked real paid revenue'; end if;
  perform public.publish_wedding_with_fee(wedding_id,true);
  if not exists(select 1 from public.weddings where id=wedding_id and published_at is not null) then
    raise exception 'Verified fee must permit explicit publishing without KYC'; end if;
  -- Staff waiver races must not be overwritten by a late provider confirmation.
  update public.weddings set published_at=null where id=wedding_id;
  update public.publication_fees pf set status='pending' where pf.wedding_id=checkout.wedding_id;
  update public.platform_policies set enabled_payment_providers=array['daraja'];
  other := public.begin_publication_checkout(wedding_id,extensions.gen_random_uuid(),'daraja',9000,'KES');
  update public.publication_checkouts set provider_reference='local-second-stk' where id=other.id;
  update public.publication_fees pf set status='waived',provider='staff-waiver' where pf.wedding_id=checkout.wedding_id;
  perform public.record_verified_publication_payment(other.id,'daraja','local-second-stk',9000,'KES','local-second-event');
  if not exists(select 1 from public.publication_fees pf where pf.wedding_id=checkout.wedding_id and status='waived') then
    raise exception 'Late verified payment must preserve a staff waiver'; end if;
  if has_table_privilege('authenticated','public.publication_checkouts','INSERT') or
    has_function_privilege('authenticated','public.record_verified_publication_payment(uuid,text,text,bigint,text,text,bigint)','EXECUTE') then
    raise exception 'Clients must never write settlement records'; end if;
end $$;
rollback;
