-- Isolated PostgreSQL only. Synthetic provider evidence, no provider/network calls.
begin;
create function pg_temp.must_reject(query text) returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin execute query; exception when others then rejected:=true; end;
  if not rejected then raise exception 'Expected rejection: %',query; end if;
end $$;
do $$
declare owner_id uuid:=extensions.gen_random_uuid(); client_id uuid:=extensions.gen_random_uuid();
  member_id uuid:=extensions.gen_random_uuid();
  wid uuid:=extensions.gen_random_uuid(); contribution_id uuid:=extensions.gen_random_uuid();
  request_id uuid:=extensions.gen_random_uuid(); quote jsonb; stale jsonb; destination_revision uuid;
  amount bigint:=100005; couple bigint; fee bigint; pub public.publication_checkouts;
  wallet_id uuid:=extensions.gen_random_uuid(); account_id uuid:=extensions.gen_random_uuid();
  account_key uuid:=extensions.gen_random_uuid();
  draft_id uuid:=extensions.gen_random_uuid(); pub_key uuid:=extensions.gen_random_uuid();
begin
  insert into auth.users(id,email,email_confirmed_at)
    select owner_id,owner_email,now() from public.protected_platform_owner where singleton;
  perform public.bootstrap_protected_owner(owner_id);
  insert into auth.users(id) values(client_id),(member_id);
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date,slug,published_at)
    values(wid,client_id,'Synthetic split fixture','KES',current_date+30,'synthetic-split',now());
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,client_id,'client');
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,member_id,'admin');
  if (select approved or split_enabled or publication_enabled from public.paystack_live_policy where singleton) then
    raise exception 'Paystack must default OFF.';
  end if;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.must_reject($q$select public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"KE","currency":"KES"}]',true,true,'subaccount',true)$q$);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"KE","currency":"KES"}]',true,true,'subaccount',true);
  perform public.owner_verify_paystack_destination(wid,jsonb_build_object(
    'subaccount_code','ACCT_fixture','subaccount_id','456','merchant_id','123','environment','live',
    'currency','KES','credential_fingerprint',repeat('a',64),'destination_fingerprint',repeat('b',64)),true);
  select revision into destination_revision from public.paystack_destinations where wedding_id=wid;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.must_reject(format('select public.consent_paystack_destination(%L,%L,true)',wid,destination_revision));
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner2_legal_name,
    partner1_id_type,partner2_id_type,partner1_id_number,partner2_id_number,
    partner1_nationality,partner2_nationality,partner1_phone,partner2_phone,partner1_email,partner2_email,consent_at)
    values(wid,'Fixture One','Fixture Two','passport','passport','TEST1111','TEST2222',
      'Fixture','Fixture','254700000001','254700000002','one@example.test','two@example.test',now());
  perform public.consent_paystack_destination(wid,destination_revision,true);
  update public.platform_policies set contribution_fixed_fee_minor=101,contribution_fixed_fee_currency='USD',
    contribution_fee_basis_points=500 where id;
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now()-interval '36 hours 1 second','{"USD":1,"KES":129.832372}');
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,100005,''KES'',''KE'')',wid));
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now()+interval '5 minutes 1 second','{"USD":1,"KES":129.832372}');
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,100005,''KES'',''KE'')',wid));
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now()-interval '36 hours','{"USD":1,"KES":129.832372}');
  perform public.paystack_contribution_quote(wid,amount,'KES','KE');
  insert into public.publication_fx_snapshots(source,published_at,rates)
    values('https://open.er-api.com/v6/latest/USD',now(),'{"USD":1,"KES":129.832372}');
  quote:=public.paystack_contribution_quote(wid,amount,'KES','KE');
  fee:=(quote->>'platform_fee_minor')::bigint;
  if (quote->>'fixed_fee_minor')::bigint<>13114 or fee<>18114 then
    raise exception 'USD FX and basis-point rounding must be exact: %',quote;
  end if;
  if (public.paystack_contribution_quote(wid,100010,'KES','KE')->>'platform_fee_minor')::bigint<>18115 then
    raise exception 'Percentage fees must round a half minor unit upward.';
  end if;
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,100005,''KES'',''NG'')',wid));
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,100005,''USD'',''KE'')',wid));
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,1,''KES'',''KE'')',wid));
  stale:=quote;
  update public.platform_policies set contribution_fee_basis_points=501 where id;
  perform pg_temp.must_reject(format($q$insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,currency,
    provider_name,payment_environment,settlement_route,paystack_context,provider_reference,checkout_idempotency_key,
    platform_fixed_fee_minor,platform_fee_basis_points) values(%L,'Stale quote',100005,'KES','paystack','live',
    'paystack_direct',%L::jsonb,%L,%L,13114,500)$q$,wid,stale,request_id,request_id));
  update public.platform_policies set contribution_fee_basis_points=500 where id;
  quote:=public.paystack_contribution_quote(wid,amount,'KES','KE');
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,provider_name,payment_environment,
    settlement_route,paystack_context,provider_reference,checkout_idempotency_key,platform_fixed_fee_minor,platform_fee_basis_points,
    purchase_action,purchase_data,action_idempotency_key)
    values(contribution_id,wid,'Direct split',amount,'KES','paystack','live','paystack_direct',quote,
      request_id::text,request_id,13114,500,'song_bid','{"songTitle":"Synthetic split song","artist":"Fixture artist"}',request_id);
  perform pg_temp.must_reject(format($q$select public.record_verified_payment('paystack','forged',%L,100005,'KES',%L,100,now())$q$,
    contribution_id,request_id));
  perform pg_temp.must_reject(format('update public.contributions set settlement_route=''platform_wallet'' where id=%L',contribution_id));
  perform pg_temp.must_reject(format('update public.contributions set paystack_context=''{}'' where id=%L',contribution_id));
  perform pg_temp.must_reject(format('delete from public.contributions where id=%L',contribution_id));
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_verify_paystack_destination(wid,jsonb_build_object(
    'subaccount_code','ACCT_fixtureNew','subaccount_id','457','merchant_id','123','environment','live',
    'currency','KES','credential_fingerprint',repeat('a',64),'destination_fingerprint',repeat('d',64)),true);
  if public.paystack_destination_status(wid)->>'consented'<>'false' then
    raise exception 'Destination changes must reset consent.';
  end if;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.must_reject(format('select public.consent_paystack_destination(%L,%L,true)',wid,destination_revision));
  perform pg_temp.must_reject(format('select public.paystack_contribution_quote(%L,100005,''KES'',''KE'')',wid));
  select revision into destination_revision from public.paystack_destinations where wedding_id=wid;
  perform public.consent_paystack_destination(wid,destination_revision,true);
  -- Revoking admission does not prevent already-bound payments from reconciliation.
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_set_paystack_policy(false,null,null,'[]',false,false,'subaccount',true);
  couple:=amount-fee-100;
  if not public.record_verified_paystack_payment(contribution_id,'verified:789',request_id::text,amount,'KES',100,now(),'789',
    jsonb_build_object('couple_minor',couple,'platform_minor',fee,'provider_fee_minor',100)) then
    raise exception 'Bound payment must settle after admission revocation.';
  end if;
  if public.record_verified_paystack_payment(contribution_id,'verified:789',request_id::text,amount,'KES',100,now(),'789',
    jsonb_build_object('couple_minor',couple,'platform_minor',fee,'provider_fee_minor',100)) then
    raise exception 'Duplicate callback must not settle twice.';
  end if;
  if (select count(*) from public.dj_song_bids where wedding_id=wid
    and song_title='Synthetic split song' and payment_status='paid')<>1 then
    raise exception 'A direct split song must be fulfilled exactly once.';
  end if;
  perform pg_temp.must_reject(format($q$select public.record_verified_paystack_payment(%L,'changed',%L,100005,'KES',101,
    now(),'789','{"couple_minor":81790,"platform_minor":18114,"provider_fee_minor":101}')$q$,contribution_id,request_id));
  update public.contributions set funds_available_at=now()-interval '10 days' where id=contribution_id;
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  if (select available_minor from public.withdrawable_balance(wid,'KES'))<>0 then
    raise exception 'Direct couple funds must never become withdrawable.';
  end if;
  if (select estimated_unallocated_net_minor from public.finance_summary where wedding_id=wid and currency='KES')<>0 then
    raise exception 'Finance summary must not report a direct settlement as wallet funds.';
  end if;
  perform pg_temp.must_reject(format('select public.request_payout(%L,1000,''KES'',''Double payout'',true)',wid));
  perform set_config('request.jwt.claim.sub',member_id::text,true);
  if jsonb_array_length(public.paystack_finance_summary(wid))<>1 then
    raise exception 'Authorized wedding finance members must retain access to safe direct allocations.';
  end if;
  perform pg_temp.must_reject(format('select public.consent_paystack_destination(%L,%L,true)',wid,destination_revision));
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,provider_fee_minor,provider_fee_pending,funds_available_at,
    currency,payment_status,verified_provider_payment)
    values(wallet_id,wid,'Synthetic historical wallet',1000,1000,100,900,0,false,now()-interval '10 days',
      'KES','paid',true);
  -- Signed refunds/disputes affect their journal, not the already-routed wallet asset.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.record_provider_adjustment('paystack','refund-fixture','refund.processed','refund-1',request_id::text,
    5000,'KES','refund_processed',now());
  if (select estimated_unallocated_net_minor from public.finance_summary where wedding_id=wid and currency='KES')<>900 then
    raise exception 'Direct refund holds must not debit another wallet.';
  end if;
  -- Publication uses the same live merchant gate but never a subaccount.
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_set_paystack_policy(true,'123',repeat('a',64),
    '[{"market":"KE","currency":"KES"}]',true,true,'account',true);
  perform set_config('request.jwt.claim.role','service_role',true);
  quote:=public.paystack_contribution_quote(wid,amount,'KES','KE');
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,currency,provider_name,payment_environment,
    settlement_route,paystack_context,provider_reference,checkout_idempotency_key,platform_fixed_fee_minor,platform_fee_basis_points)
    values(account_id,wid,'Platform bears fee',amount,'KES','paystack','live','paystack_direct',quote,
      account_key::text,account_key,13114,500);
  perform public.record_verified_paystack_payment(account_id,'verified:790',account_key::text,amount,'KES',100,now(),'790',
    jsonb_build_object('couple_minor',amount-fee,'platform_minor',fee-100,'provider_fee_minor',100));
  if (select e.platform_minor from public.paystack_payment_evidence e where e.contribution_id=account_id)<>fee-100
    or (select estimated_unallocated_net_minor from public.finance_summary where wedding_id=wid and currency='KES')<>900 then
    raise exception 'Platform fee bearer must not create another wallet asset.';
  end if;
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date,slug)
    values(draft_id,client_id,'Synthetic publication','KES',current_date+800,'synthetic-publication');
  insert into public.venues(wedding_id,name,event_date,event_time,kind) values(draft_id,'Fixture event',current_date+800,'12:00','main');
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  quote:=public.publication_quote_internal(draft_id);
  pub:=public.begin_live_paystack_publication(draft_id,pub_key,(quote->>'fee_minor')::bigint,'KES',
    (quote->>'usd_amount_minor')::bigint,(quote->>'fx_snapshot_id')::uuid,'123',repeat('a',64));
  if pub.payment_mode<>'live' or pub.paystack_context->>'kind'<>'publication'
    or pub.paystack_context ? 'subaccount_code' then raise exception 'Live publication must be platform-only.'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.record_verified_publication_payment(pub.id,'paystack',pub_key::text,pub.amount_minor,'KES','pub-live',100);
  if (select status from public.publication_fees where wedding_id=draft_id)<>'paid' then
    raise exception 'Live publication must be revenue, not test_paid.';
  end if;
  if exists(select 1 from public.contributions where wedding_id=draft_id) then
    raise exception 'Publication fees must not create wedding contributions.';
  end if;
  perform public.record_paystack_publication_adjustment(pub.id,repeat('c',64),'refund_processed','pub-refund',100,'KES',now());
  perform pg_temp.must_reject(format('select public.publication_quote_internal(%L)',draft_id));
  perform set_config('request.jwt.claim.sub',client_id::text,true);
  perform pg_temp.must_reject(format('select public.owner_resolve_paystack_publication(%L,''waive'',''Fixture review waiver'',true)',repeat('c',64)));
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.owner_resolve_paystack_publication(repeat('c',64),'waive','Fixture review waiver',true);
  if (public.publication_quote_internal(draft_id)->>'fee_minor')::bigint<>0 then raise exception 'Owner waiver must resolve entitlement.'; end if;
end $$;
-- Actual database privileges, not only role predicates.
set local role authenticated;
select pg_temp.must_reject('select * from public.paystack_live_policy');
select pg_temp.must_reject('select * from public.paystack_destinations');
select pg_temp.must_reject('select * from public.paystack_payment_evidence');
select pg_temp.must_reject($q$select public.record_verified_paystack_payment(null,'e','r',1,'KES',0,now(),'p','{}')$q$);
reset role;
rollback;
