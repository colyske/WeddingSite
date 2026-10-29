-- Isolated rollback-only CI database, never Production.
begin;
do $$
declare client_id uuid := extensions.gen_random_uuid(); wid uuid := extensions.gen_random_uuid();
  fx_id uuid := extensions.gen_random_uuid(); q jsonb; checkout public.publication_checkouts; blocked boolean;
begin
  insert into auth.users(id) values(client_id);
  update public.platform_policies set publication_fee_minor=2500,far_future_fee_minor=5000,
    free_publications_per_client=0,enabled_payment_providers=array['daraja','paystack'];
  insert into public.weddings(id,client_owner_id,slug,couple_names,wedding_date,currency)
    values(wid,client_id,'fx-local-only','Fictional FX sample',current_date+200,'KES');
  insert into public.venues(wedding_id,name,event_date,event_time) values(wid,'Sample',current_date+200,'12:00');
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  blocked := false;
  begin perform public.publication_quote(wid);
  exception when raise_exception then blocked := sqlerrm like 'FX_UNAVAILABLE%'; end;
  if not blocked then raise exception 'Missing FX must fail closed'; end if;
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now()-interval '37 hours','{"USD":1,"KES":129.832372}');
  blocked := false;
  begin perform public.publication_quote(wid);
  exception when raise_exception then blocked := sqlerrm like 'FX_UNAVAILABLE%'; end;
  if not blocked then raise exception 'Stale FX must fail closed'; end if;
  insert into public.publication_fx_snapshots(id,source,published_at,rates)
    values(fx_id,'https://open.er-api.com/v6/latest/USD',now(),'{"USD":1,"KES":129.832372,"EUR":0.897215}');
  q := public.publication_quote(wid);
  if (q->>'fee_minor')::bigint <> 324581 or (q->>'usd_amount_minor')::bigint <> 2500 then
    raise exception 'USD25 must convert to KES3245.81, not KES25'; end if;
  blocked := false;
  begin perform public.begin_publication_checkout(wid,extensions.gen_random_uuid(),'daraja',324581,'KES',2500,fx_id);
  exception when raise_exception then blocked := sqlerrm like 'Publication quote changed%'; end;
  if not blocked then raise exception 'M-Pesa quote must round up to whole KES'; end if;
  blocked := false;
  begin perform public.begin_publication_checkout(wid,extensions.gen_random_uuid(),'daraja',324600,'KES',5000,fx_id);
  exception when raise_exception then blocked := sqlerrm like 'Publication quote changed%'; end;
  if not blocked then raise exception 'Changed USD policy quote must fail closed'; end if;
  checkout := public.begin_publication_checkout(wid,extensions.gen_random_uuid(),'daraja',324600,'KES',2500,fx_id);
  if checkout.usd_amount_minor<>2500 or checkout.fx_rate<>129.832372 or checkout.fx_snapshot_id<>fx_id
    or checkout.payment_unit_minor<>100 or checkout.fx_published_at is null then
    raise exception 'Admitted quote must retain immutable USD and rate provenance'; end if;
  blocked := false;
  begin update public.publication_checkouts set fx_rate=1 where id=checkout.id;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Checkout FX evidence must be immutable'; end if;
  blocked := false;
  begin update public.publication_fx_snapshots set rates='{"USD":1,"KES":1}' where id=fx_id;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Rate snapshots must be immutable'; end if;
  update public.publication_checkouts set provider_reference='fixture-fx-reference' where id=checkout.id;
  update public.platform_policies set publication_fee_minor=9000;
  perform public.record_verified_publication_payment(checkout.id,'daraja','fixture-fx-reference',324600,'KES','fixture-fx-event');
  if not exists(select 1 from public.publication_fees where wedding_id=wid and amount_minor=324600 and status='test_paid') then
    raise exception 'Admitted converted amount must not reprice after policy changes'; end if;
  update public.weddings set currency='USD' where id=wid;
  q := public.publication_quote(wid);
  if q->>'code'<>'settled' then raise exception 'Settled legacy/converted fees must remain settled'; end if;
  if has_table_privilege('authenticated','public.publication_fx_snapshots','INSERT') then
    raise exception 'Clients must not supply authoritative FX rates'; end if;
end $$;
rollback;
