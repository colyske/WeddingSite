-- Isolated local CI only; every fixture is rolled back. No provider is contacted.
begin;
do $$
declare cid uuid := extensions.gen_random_uuid(); wid uuid := extensions.gen_random_uuid();
  uwid uuid := extensions.gen_random_uuid(); pid uuid; fx uuid; usd_min bigint;
  d jsonb := '{"custom":true,"customMinimumMinor":500000,"companyName":"Sample Sponsor Co","website":"https://example.com"}';
begin
  insert into auth.users(id) values(cid);
  insert into public.weddings(id,client_owner_id,slug,couple_names,welcome_story,cover_image_url,
      guest_instructions,currency,wedding_date)
    values(wid,cid,'custom-sponsor-sample','Custom sponsor sample','A local celebration sample.',
        'https://example.test/cover.jpg','Please reply before the celebration.','KES',current_date+30),
      (uwid,cid,'custom-sponsor-usd-sample','Custom sponsor USD sample','A local celebration sample.',
        'https://example.test/cover.jpg','Please reply before the celebration.','USD',current_date+30);
  insert into public.venues(wedding_id,name,event_date,event_time,address)
    values(wid,'Local event',current_date+30,'12:00','Local street'),
      (uwid,'Local event',current_date+30,'12:00','Local street');
  insert into public.wedding_collection_capabilities(wedding_id,provider,currency,market)
    values(wid,'daraja','KES','KE'),(uwid,'stripe','USD','US');
  update public.weddings set published_at=now() where id in (wid,uwid);

  -- Exact KES floor completes once, with no package and no review.
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,purchase_action,purchase_data)
    values(wid,'Sponsor: custom sponsorship',500000,'KES','pending','sponsor',d) returning id into pid;
  update public.contributions set payment_status='paid',paid_amount_minor=500000,net_paid_minor=500000,verified_provider_payment=true,paid_at=now() where id=pid;
  if not exists(select 1 from public.contributions where id=pid and action_completed_at is not null
      and action_result->>'custom'='true') then
    raise exception 'Custom sponsorship at the KES 5000 floor must complete';
  end if;
  if (select count(*) from public.sponsors where contribution_id=pid and tier_id is null and amount_minor=500000) <> 1
      or exists(select 1 from public.payment_action_reviews where contribution_id=pid) then
    raise exception 'Custom sponsorship must create exactly one package-free sponsor and no review';
  end if;
  update public.contributions set payment_status='paid' where id=pid;
  if (select count(*) from public.sponsors where contribution_id=pid) <> 1 then
    raise exception 'Repeated paid update must not duplicate the sponsor';
  end if;

  -- Below floor (even if the client tampered with the quoted minimum) is held for review.
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,purchase_action,purchase_data)
    values(wid,'Sponsor: custom sponsorship',499900,'KES','pending','sponsor',d || '{"customMinimumMinor":499900}') returning id into pid;
  update public.contributions set payment_status='paid',paid_amount_minor=499900,net_paid_minor=499900,verified_provider_payment=true,paid_at=now() where id=pid;
  if exists(select 1 from public.sponsors where contribution_id=pid)
      or not exists(select 1 from public.payment_action_reviews where contribution_id=pid)
      or (select payment_status::text from public.contributions where id=pid) <> 'paid' then
    raise exception 'Below-floor custom sponsorship must keep the payment and require review';
  end if;

  -- Once the couple adds a package, custom sponsorship no longer auto-completes.
  insert into public.sponsor_tiers(wedding_id,name,min_amount_minor,perks) values(wid,'Gold',800000,'Recognised as a supporter');
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,purchase_action,purchase_data)
    values(wid,'Sponsor: custom sponsorship',500000,'KES','pending','sponsor',d) returning id into pid;
  update public.contributions set payment_status='paid',paid_amount_minor=500000,net_paid_minor=500000,verified_provider_payment=true,paid_at=now() where id=pid;
  if exists(select 1 from public.sponsors where contribution_id=pid)
      or not exists(select 1 from public.payment_action_reviews where contribution_id=pid) then
    raise exception 'Custom sponsorship must not bypass couple-defined packages';
  end if;

  -- Non-KES floors use a timestamped snapshot, rounded up to a whole unit (5000 * 1 / 129.5 = 38.61 -> 39).
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now()-interval '1 hour','{"USD":1,"KES":129.5}') returning id into fx;
  usd_min := public.custom_sponsor_minimum_minor('USD',fx,now());
  if usd_min <> 3900 or public.custom_sponsor_minimum_minor('EUR',fx,now()) is not null
      or public.custom_sponsor_minimum_minor('USD',fx,now()+interval '2 days') is not null
      or public.custom_sponsor_minimum_minor('USD',null,now()) is not null then
    raise exception 'FX floor must convert exactly and fail closed when stale or unquoted (%)', usd_min;
  end if;
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,payment_status,purchase_action,purchase_data)
    values(uwid,'Sponsor: custom sponsorship',3900,'USD','pending','sponsor',
      jsonb_build_object('custom',true,'customMinimumMinor',3900,'fxSnapshotId',fx,'companyName','USD Sponsor')) returning id into pid;
  update public.contributions set payment_status='paid',paid_amount_minor=3900,net_paid_minor=3900,verified_provider_payment=true,paid_at=now() where id=pid;
  if not exists(select 1 from public.sponsors where contribution_id=pid and tier_id is null) then
    raise exception 'Converted floor custom sponsorship must complete';
  end if;
end $$;
rollback;
