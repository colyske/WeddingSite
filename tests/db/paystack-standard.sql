-- Isolated Supabase CI only: all fixtures roll back; no provider is contacted.
begin;
create function pg_temp.standard_must_reject(statement text) returns void language plpgsql as $$
begin
  begin execute statement; exception when others then return; end;
  raise exception 'Expected rejection: %',statement;
end $$;
do $$
declare owner_id uuid:=extensions.gen_random_uuid(); client_id uuid:=extensions.gen_random_uuid();
  admin_id uuid:=extensions.gen_random_uuid(); leadership_id uuid:=extensions.gen_random_uuid();
  wid uuid:=extensions.gen_random_uuid(); cid uuid:=extensions.gen_random_uuid(); key uuid:=extensions.gen_random_uuid();
  fx_id uuid:=extensions.gen_random_uuid(); old_revision uuid; revision uuid; quote jsonb;
  gross bigint:=10010; fee bigint:=632; provider_fee bigint:=100;
begin
  if exists(select 1 from public.paystack_live_policy where approved or standard_enabled or split_enabled
    or publication_enabled or split_contract_ready or settlement_mode<>'standard') then
    raise exception 'Standard mode must default selected but every live scope OFF.';
  end if;
  insert into auth.users(id,email,email_confirmed_at) values(owner_id,'colyske@gmail.com',now());
  perform public.bootstrap_protected_owner(owner_id);
  insert into auth.users(id) values(client_id),(admin_id),(leadership_id);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.assign_platform_role(admin_id,'admin');
  perform public.assign_platform_role(leadership_id,'superadmin');
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date,published_at,slug)
    values(wid,client_id,'Standard fixture','KES',current_date+800,now(),'synthetic-standard');
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,client_id,'client') on conflict do nothing;
  update public.platform_policies set enabled_payment_providers=array['paystack','daraja'],
    contribution_fee_basis_points=500,contribution_fixed_fee_minor=1,contribution_fixed_fee_currency='USD';
  insert into public.publication_fx_snapshots(id,source,published_at,rates)
    values(fx_id,'https://open.er-api.com/v6/latest/USD',now(),'{"USD":1,"KES":130.01}');
  select p.revision into revision from public.paystack_live_policy p where singleton;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.standard_must_reject(format('select public.paystack_contribution_quote(%L,10010,''KES'',''KE'')',wid));
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform pg_temp.standard_must_reject(format('select public.owner_set_paystack_settlement_mode(''standard'',%L,true)',revision));
  perform set_config('request.jwt.claim.sub',leadership_id::text,true);
  perform pg_temp.standard_must_reject(format('select public.owner_set_paystack_settlement_mode(''standard'',%L,true)',revision));
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  old_revision:=revision;
  perform pg_temp.standard_must_reject(format($q$select public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"JP","currency":"JPY"}]',false,true,'subaccount',true,true,%L)$q$,revision));
  perform pg_temp.standard_must_reject(format($q$select public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"KE","currency":"KES","unknown":true}]',false,true,'subaccount',true,true,%L)$q$,revision));
  perform pg_temp.standard_must_reject($q$select public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"KE","currency":"KES"}]',false,true,'subaccount',true,true,null)$q$);
  perform public.owner_set_paystack_policy(true,'123',repeat('a',64),'[{"market":"KE","currency":"KES"}]',
    false,true,'subaccount',true,true,revision);
  select p.revision into revision from public.paystack_live_policy p where singleton;
  perform pg_temp.standard_must_reject(format('select public.owner_set_paystack_settlement_mode(''standard'',%L,true)',old_revision));
  perform pg_temp.standard_must_reject(format('select public.owner_set_paystack_settlement_mode(''split'',%L,true)',revision));
  perform pg_temp.standard_must_reject('update public.paystack_live_policy set split_contract_ready=true');
  perform pg_temp.standard_must_reject(format('select public.owner_set_paystack_settlement_mode(''unknown'',%L,true)',revision));
  perform set_config('request.jwt.claim.role','service_role',true);
  quote:=public.paystack_contribution_quote(wid,gross,'KES','KE');
  if public.kyc_is_complete(wid) or quote ? 'subaccount_code' or quote ? 'destination_revision'
    or quote->>'settlement_mode'<>'standard' or quote->>'settlement_route'<>'platform_wallet'
    or quote->>'fee_bearer'<>'couple_wallet' or (quote->>'platform_fee_minor')::bigint<>fee
    or (quote->>'fixed_fee_minor')::bigint<>131 or quote->>'fx_snapshot_id'<>fx_id::text then
    raise exception 'Standard collection must need no split/KYC onboarding and preserve exact USD/FX rounding.';
  end if;
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_set_paystack_settlement_mode('standard',revision,true);
  if not exists(select 1 from public.audit_events where actor_id=owner_id and action='paystack_mode_standard_to_standard') then
    raise exception 'Mode changes must be audited.';
  end if;
  -- The old quote is stale even if the selected mode has not changed.
  perform pg_temp.standard_must_reject(format($q$insert into public.contributions(id,wedding_id,stream_name,
    pledged_amount_minor,currency,provider_name,payment_environment,settlement_route,paystack_context,
    provider_reference,checkout_idempotency_key,platform_fixed_fee_minor,platform_fee_basis_points)
    values(%L,%L,'Stale standard',10010,'KES','paystack','live','platform_wallet',%L,%L,%L,131,500)$q$,
    cid,wid,quote,key::text,key));
  quote:=public.paystack_contribution_quote(wid,gross,'KES','KE');
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,provider_name,
    payment_environment,settlement_route,paystack_context,provider_reference,checkout_idempotency_key,
    platform_fixed_fee_minor,platform_fee_basis_points)
    values(cid,wid,'Standard collection',gross,'KES','paystack','live','platform_wallet',quote,key::text,key,131,500);
  insert into public.contribution_line_items(contribution_id,wedding_id,action,amount_minor,currency,metadata)
    values(cid,wid,'song_bid',gross,'KES','{"song_title":"Synthetic standard song","artist":"Fixture"}');
  perform pg_temp.standard_must_reject(format('update public.contributions set payment_status=''paid'' where id=%L',cid));
  perform pg_temp.standard_must_reject(format('update public.contributions set settlement_route=''paystack_direct'' where id=%L',cid));
  perform pg_temp.standard_must_reject(format('update public.contributions set payment_environment=''test'' where id=%L',cid));
  perform pg_temp.standard_must_reject(format('update public.contributions set paystack_context=jsonb_set(paystack_context,''{settlement_mode}'',''"split"'') where id=%L',cid));
  -- Future-contract simulation is confined to this rollback fixture; the real gate was proved above.
  alter table public.paystack_live_policy drop constraint paystack_split_contract_unverified;
  update public.paystack_live_policy set split_contract_ready=true;
  perform public.owner_set_paystack_policy(true,'123',repeat('a',64),'[{"market":"KE","currency":"KES"}]',
    true,true,'subaccount',true,true,(select p.revision from public.paystack_live_policy p where singleton));
  perform public.owner_set_paystack_settlement_mode('split',(select p.revision from public.paystack_live_policy p where singleton),true);
  if (select paystack_context from public.contributions where id=cid) is distinct from quote then
    raise exception 'A later mode toggle must not rewrite standard financial context.';
  end if;
  perform pg_temp.standard_must_reject(format('select public.paystack_contribution_quote(%L,10010,''KES'',''KE'')',wid));
  -- Revoke new collection without stranding the immutable standard payment.
  perform public.owner_set_paystack_policy(false,null,null,'[]',false,false,'account',true,false,
    (select p.revision from public.paystack_live_policy p where singleton));
  perform pg_temp.standard_must_reject(format('select public.paystack_contribution_quote(%L,10010,''KES'',''KE'')',wid));
  perform pg_temp.standard_must_reject(format($q$select public.record_verified_paystack_payment(%L,'bad',%L,10010,'KES',100,
    now(),'standard-provider','{"couple_minor":9274,"platform_minor":631,"provider_fee_minor":100}')$q$,cid,key));
  if not public.record_verified_paystack_payment(cid,'verified:standard',key::text,gross,'KES',provider_fee,now(),
    'standard-provider',jsonb_build_object('couple_minor',gross-fee-provider_fee,'platform_minor',fee,'provider_fee_minor',provider_fee)) then
    raise exception 'Admitted standard payment must settle after admission revocation.';
  end if;
  if public.record_verified_paystack_payment(cid,'verified:standard',key::text,gross,'KES',provider_fee,now(),
    'standard-provider',jsonb_build_object('couple_minor',gross-fee-provider_fee,'platform_minor',fee,'provider_fee_minor',provider_fee)) then
    raise exception 'Duplicate standard callback must not credit twice.';
  end if;
  if (select count(*) from public.dj_song_bids where wedding_id=wid and song_title='Synthetic standard song'
    and payment_status='paid')<>1 then raise exception 'Standard song fulfillment must be exactly once.'; end if;
  if (select net_paid_minor from public.contributions where id=cid)<>gross-fee
    or (select couple_minor from public.paystack_payment_evidence where contribution_id=cid)<>gross-fee-provider_fee
    or (select provider_fee_pending from public.contributions where id=cid) then
    raise exception 'Standard immutable evidence and existing wallet fee allocation disagree.';
  end if;
  update public.contributions set funds_available_at=now()-interval '10 days' where id=cid;
  perform public.record_provider_adjustment('paystack','standard-refund-event','refund.processed','standard-refund',
    key::text,100,'KES','refund_processed',now());
  if (select estimated_unallocated_net_minor from public.finance_summary where wedding_id=wid and currency='KES')
    <>gross-fee-provider_fee-100 then raise exception 'Standard refund must debit only its platform wallet.'; end if;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  if public.live_payouts_enabled() then raise exception 'Paystack collection must not activate payouts.'; end if;
  perform pg_temp.standard_must_reject(format('select public.request_payout(%L,1000,''KES'',''Held payout'',true)',wid));
end $$;
set local role authenticated;
select pg_temp.standard_must_reject('update public.paystack_live_policy set settlement_mode=''split''');
select pg_temp.standard_must_reject('insert into public.paystack_payment_evidence(contribution_id) values(null)');
select pg_temp.standard_must_reject('select public.paystack_contribution_quote(null,10005,''KES'',''KE'')');
reset role;
rollback;
