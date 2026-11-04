-- Isolated synthetic confirmations only. No provider, external or linked calls.
begin;
create temporary table hold_ids(kind text,id uuid,hold_days integer,provider text,paid_at timestamptz);
do $$ declare client uuid:=extensions.gen_random_uuid(); wedding uuid:=extensions.gen_random_uuid();
  contribution uuid; provider text; days integer; at_time timestamptz:=now()-interval '1 minute';
  info jsonb; baseline bigint;
begin
  insert into auth.users(id) values(client);
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wedding,client,'Isolated hold policy fixture','KES',current_date+30);
  insert into hold_ids(kind,id) values('wedding',wedding);
  perform set_config('request.jwt.claim.sub',client::text,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  -- Synthetic persisted contexts, never live provider admission or requests.
  alter table public.contributions disable trigger guard_payment_environment;
  alter table public.contributions disable trigger guard_live_payment_context;
  alter table public.contributions disable trigger guard_paystack_context;
  foreach provider in array array['daraja','paystack'] loop
    foreach days in array array[0,1,7] loop
      update public.platform_policies set payout_hold_days=days where id=true;
      contribution:=extensions.gen_random_uuid();
      insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
        provider_name,payment_environment,provider_reference,platform_fee_basis_points,platform_fixed_fee_minor)
        values(contribution,wedding,'Isolated configured hold',10000,'KES','pending',provider,'live',contribution::text,0,0);
      if provider='daraja' then
        perform public.record_verified_payment(provider,contribution::text,contribution,10000,'KES',contribution::text,100,at_time);
      else
        perform public.record_verified_payment(provider,contribution::text,contribution,10000,'KES',contribution::text,100,at_time,contribution::text);
      end if;
      if not exists(select 1 from public.contributions where id=contribution and payment_status='paid'
        and verified_provider_payment and funds_available_at=at_time+make_interval(days=>days)
        and net_paid_minor=10000 and provider_fee_minor=100 and not provider_fee_pending) then
        raise exception 'Wrong configured hold for %/%',provider,days; end if;
      insert into hold_ids values('confirmed',contribution,days,provider,at_time);
    end loop;
  end loop;
  -- Changing policy and replaying confirmation never changes stored history.
  update public.platform_policies set payout_hold_days=0 where id=true;
  for contribution,provider,days in select id,h.provider,h.hold_days from hold_ids h where kind='confirmed' loop
    perform public.record_verified_payment(provider,contribution::text||'-retry',contribution,10000,'KES',contribution::text,100,now());
    if not exists(select 1 from public.contributions where id=contribution and funds_available_at=at_time+make_interval(days=>days)) then
      raise exception 'Policy edit/replay rewrote stored payment date'; end if;
  end loop;
  -- Two zero-day known-fee payments, four future ones. Not settlement evidence.
  if public.simple_payout_available(wedding)<>19800 then raise exception 'Zero/nonzero authoritative availability mismatch'; end if;
  info:=public.simple_payout_balance_details(wedding);
  if (info->>'time_held_minor')::bigint<>39600 or (info->>'configured_hold_days')::integer<>0 then
    raise exception 'Time hold summary disagrees'; end if;
  foreach provider in array array['daraja','paystack'] loop
    contribution:=extensions.gen_random_uuid();
    insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
      provider_name,payment_environment,provider_reference,platform_fee_basis_points,platform_fixed_fee_minor)
      values(contribution,wedding,'Isolated unknown fee',500,'KES','pending',provider,'live',contribution::text,0,0);
    perform public.record_verified_payment(provider,contribution::text,contribution,500,'KES',contribution::text,null,at_time);
    if not exists(select 1 from public.contributions where id=contribution and funds_available_at=at_time
      and provider_fee_pending and provider_fee_minor is null) then raise exception 'Zero hold invented fees'; end if;
  end loop;
  if public.simple_payout_available(wedding)<>19800 or
    (public.simple_payout_balance_details(wedding)->>'fee_pending_minor')::bigint<>1000 then
    raise exception 'Unknown-fee funds became available'; end if;
  insert into public.expenses(wedding_id,category,description,amount_minor,currency,status)
    values(wedding,'Fixture','Known obligation',800,'KES','approved');
  select id into contribution from hold_ids where kind='confirmed' and hold_days=0 limit 1;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values('paystack','dispute',extensions.gen_random_uuid()::text,
      contribution,wedding,1000,'KES','open',1000);
  if public.simple_payout_available(wedding)<>18000 or
    (public.simple_payout_balance_details(wedding)->>'obligations_minor')::bigint<>1800 then
    raise exception 'Zero time hold ignored expense/dispute obligations'; end if;
  -- Test and direct-settled money never become available due to policy=0.
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,net_paid_minor,
    platform_fee_minor,currency,payment_status,verified_provider_payment,provider_name,payment_environment,
    provider_fee_pending,provider_fee_minor,settlement_route,funds_available_at)
    values(wedding,'Isolated excluded test',1000,1000,1000,0,'KES','paid',true,'daraja','test',false,0,'platform_wallet',at_time),
      (wedding,'Isolated excluded direct',1000,1000,1000,0,'KES','paid',true,'paystack','live',false,0,'paystack_direct',at_time);
  if public.simple_payout_available(wedding)<>18000 then raise exception 'Excluded money credited'; end if;
  -- Nondefault fee snapshots, policy edits, and shared request bounds.
  contribution:=extensions.gen_random_uuid();
  update public.platform_policies set contribution_fee_basis_points=667,contribution_fixed_fee_minor=23,
    contribution_fixed_fee_currency='KES',min_payout_minor=4321,max_payout_minor=8765,max_contribution_minor=12345 where id=true;
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,payment_status,
    provider_name,payment_environment,provider_reference,platform_fee_basis_points,platform_fixed_fee_minor)
    values(contribution,wedding,'Isolated fee snapshot',10000,'KES','pending','daraja','test',contribution::text,667,23);
  -- Confirmation uses the payment's snapshot, never a later platform policy.
  update public.platform_policies set contribution_fee_basis_points=999,contribution_fixed_fee_minor=77 where id=true;
  perform public.record_verified_payment('daraja',contribution::text,contribution,10000,'KES',contribution::text,100,at_time);
  if not exists(select 1 from public.contributions where id=contribution and platform_fee_minor=690 and net_paid_minor=9310)
    then raise exception 'Nondefault snapshotted commission/fixed fee was overridden'; end if;
  perform public.manual_payout_check_amount(wedding,'KES',4321);
  perform public.manual_payout_check_amount(wedding,'KES',8765);
  begin
    perform public.manual_payout_check_amount(wedding,'KES',4320);
    raise exception 'Below minimum accepted';
  exception when raise_exception then if sqlerrm<>'Payout amount outside configured minimum or maximum.' then raise; end if; end;
  begin
    perform public.manual_payout_check_amount(wedding,'KES',8766);
    raise exception 'Above maximum accepted';
  exception when raise_exception then if sqlerrm<>'Payout amount outside configured minimum or maximum.' then raise; end if; end;
  if (public.simple_payout_status(wedding)->>'min_payout_minor')::bigint<>4321
    or public.simple_payout_available(wedding)<>18000 then raise exception 'Policy display or test-money exclusion inconsistent'; end if;
  set constraints all immediate;
  alter table public.contributions enable trigger guard_payment_environment;
  alter table public.contributions enable trigger guard_live_payment_context;
  alter table public.contributions enable trigger guard_paystack_context;
  if public.live_payouts_enabled() or public.manual_payouts_enabled() then raise exception 'Payout gate changed'; end if;
end $$;
rollback;
