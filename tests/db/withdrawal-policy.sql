-- Isolated readiness fixture extension; all synthetic policies/payments roll back.
create function pg_temp.withdrawal_wedding(amount bigint,provider_cost bigint default null,time_held boolean default false,p_provider text default 'daraja') returns uuid
language plpgsql as $$
declare w uuid:=extensions.gen_random_uuid(); begin
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(w,(select id from mr_ids where key='client'),'Isolated withdrawal fee','KES',current_date+30);
  insert into public.wedding_kyc(wedding_id,partner1_legal_name,partner1_id_type,partner1_id_number,
    partner1_nationality,partner1_phone,partner1_email,partner2_legal_name,partner2_id_type,partner2_id_number,
    partner2_nationality,partner2_phone,partner2_email,consent_at)
    select w,partner1_legal_name,partner1_id_type,partner1_id_number,partner1_nationality,partner1_phone,partner1_email,
      partner2_legal_name,partner2_id_type,partner2_id_number,partner2_nationality,partner2_phone,partner2_email,consent_at
    from public.wedding_kyc where wedding_id=(select id from mr_ids where key='wedding');
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,
    currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,
    provider_name,paid_at,funds_available_at,settlement_route)
    values(w,'Isolated company overhead',amount+100,amount+100,100,amount,'KES','paid',true,provider_cost is null,provider_cost,
      'live',p_provider,now()-interval '4 days',case when time_held then now()+interval '3 days' else now()-interval '1 day' end,'platform_wallet');
  return w;
end $$;
create function pg_temp.withdrawal(w uuid,amount bigint,k uuid default extensions.gen_random_uuid()) returns uuid language plpgsql as $$
declare fee bigint; revision bigint; begin
  select withdrawal_processing_fee_minor,withdrawal_policy_revision into fee,revision from public.platform_policies where id=true;
  perform pg_temp.actor('client');
  return public.simple_payout_submit(k,w,amount,1,true,fee,revision);
end $$;
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
alter table public.contributions disable trigger guard_paystack_context;
do $$ declare w uuid; known uuid; held uuid; p uuid; key uuid; revision bigint; available bigint; fingerprint text; source uuid;
begin
  perform pg_temp.actor('maker');
  perform pg_temp.reject('select public.admin_save_policies(''{"withdrawal_processing_fee_minor":100}'')','protected Owner');
  perform pg_temp.actor('owner');
  perform pg_temp.reject('select public.admin_save_policies(''{"withdrawal_processing_fee_minor":null}'')','exact nonnegative');
  perform pg_temp.reject('select public.admin_save_policies(''{"withdrawal_processing_fee_minor":1.5}'')','exact nonnegative');
  perform public.admin_save_policies('{"min_payout_minor":1000,"max_payout_minor":10000,"withdrawal_processing_fee_minor":100}');
  w:=pg_temp.withdrawal_wedding(999,null,false,'paystack');
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,898)',w),'drain the full');
  p:=pg_temp.withdrawal(w,899);
  if public.simple_payout_available(w)<>0 then raise exception 'Full remainder was not reserved including fee'; end if;
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select public.simple_payout_action(%L,extensions.gen_random_uuid(),''processing'',null,0,null,true,true,true)',p),'actual expected fee');
  -- Changing policy never adds a new fee or changes the accepted minimum exception.
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":250,"min_payout_minor":2000}');
  perform public.simple_payout_action(p,extensions.gen_random_uuid(),'processing',null,null,null,true,true,true);
  if (select fee_minor from public.simple_payout_claims where payout_id=p) is not null
    or (select processing_fee_minor from public.simple_payout_requests where id=p)<>100 then raise exception 'Provider cost faked or customer fee repriced'; end if;
  key:=extensions.gen_random_uuid();
  perform public.simple_payout_action(p,key,'paid',null,null,'CUSTOMER-FEE1',false,false,true);
  perform public.simple_payout_action(p,key,'paid',null,null,'CUSTOMER-FEE1',false,false,true);
  if public.simple_payout_available(w)<>0 then raise exception 'Paid/replay double charged'; end if;
  if (public.simple_payout_balance_details(w)->>'withdrawal_processing_revenue_minor')::bigint<>100 or
    (public.simple_payout_balance_details(w)->>'withdrawal_processing_reserved_minor')::bigint<>0 then
    raise exception 'Customer processing revenue and reserved fees were not separated'; end if;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) select 'paystack','refund',extensions.gen_random_uuid()::text,id,w,100,'KES','pending',100
    from public.contributions where wedding_id=w;
  set constraints all immediate;
  if public.simple_payout_balance_raw(w)<>-100 or not exists(select 1 from public.simple_payout_deficits where wedding_id=w)
    or public.simple_payout_state(p)<>'paid' then raise exception 'Actual refund erased or Paid claim released'; end if;
  perform public.simple_payout_action(p,key,'paid',null,null,'CUSTOMER-FEE1',false,false,true);
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":100,"min_payout_minor":1000}');
  w:=pg_temp.withdrawal_wedding(1000);
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,899)',w),'drain the full');
  p:=pg_temp.withdrawal(w,900); -- Gross >= min, received < min: only a complete drain.
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":600}');
  w:=pg_temp.withdrawal_wedding(1500);
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,899)',w),'drain the full');
  p:=pg_temp.withdrawal(w,900); -- Gross > min but fee puts received amount below it.
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":100}');
  w:=pg_temp.withdrawal_wedding(20000);
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,10001)',w),'configured maximum');
  w:=pg_temp.withdrawal_wedding(1101); p:=pg_temp.withdrawal(w,1000);
  if public.simple_payout_available(w)<>1 then raise exception 'Normal threshold debit wrong'; end if;
  w:=pg_temp.withdrawal_wedding(100);
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,1)',w),'plus processing fee');
  w:=pg_temp.withdrawal_wedding(10000,null,false,'paystack'); known:=pg_temp.withdrawal_wedding(10000,500,false,'paystack');
  held:=pg_temp.withdrawal_wedding(10000,null,true);
  if public.simple_payout_available(w)<>10000 or public.simple_payout_available(known)<>10000 or public.simple_payout_available(held)<>0 then
    raise exception 'Known/unknown provider cost changed entitlement or bypassed time hold'; end if;
  select id,encode(extensions.digest(to_jsonb(c)::text,'sha256'),'hex') into source,fingerprint from public.contributions c where wedding_id=w;
  key:=extensions.gen_random_uuid();
  select withdrawal_policy_revision into revision from public.platform_policies where id=true;
  p:=public.simple_payout_submit(key,w,1000,1,true,100,revision);
  perform pg_temp.reject(format('select public.simple_payout_submit(%L,%L,1000,1,true)',key,w),'Request retry changed');
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"min_payout_minor":2000}'); -- Same transaction and fee: revision still changes.
  perform pg_temp.actor('client');
  if p is distinct from public.simple_payout_submit(key,w,1000,1,true,100,revision) then raise exception 'Replay repriced an existing request'; end if;
  perform pg_temp.reject(format('select public.simple_payout_submit(extensions.gen_random_uuid(),%L,2000,1,true,100,%s)',w,revision),'quote changed');
  if fingerprint is distinct from (select encode(extensions.digest(to_jsonb(c)::text,'sha256'),'hex') from public.contributions c where id=source) then
    raise exception 'Fee policy mutated actual provider costs/payment history'; end if;
  insert into public.payment_adjustments(provider,adjustment_kind,provider_adjustment_id,contribution_id,wedding_id,
    amount_minor,currency,status,hold_minor) values('paystack','refund',extensions.gen_random_uuid()::text,source,w,200,'KES','pending',200);
  if public.simple_payout_available(w)<>8700 then raise exception 'True refund obligation ignored'; end if;
  perform pg_temp.actor('owner');
  perform public.admin_save_policies('{"withdrawal_processing_fee_minor":0,"min_payout_minor":1000}');
  w:=pg_temp.withdrawal_wedding(999);
  perform pg_temp.reject(format('select pg_temp.withdrawal(%L,998)',w),'drain the full');
  p:=pg_temp.withdrawal(w,999);
  if public.simple_payout_available(w)<>0 then raise exception 'Zero-fee full remainder failed'; end if;
  -- New reservations remain visible to the old manual/B2C shared accounting gate.
  perform pg_temp.actor('owner');
  perform pg_temp.policy('{"daily_minor":20000}');
  p:=pg_temp.withdrawal((select id from mr_ids where key='wedding'),10000);
  perform pg_temp.actor('maker');
  perform pg_temp.reject('select pg_temp.request(extensions.gen_random_uuid(),false,6000,100)','another payout path');
end $$;
set constraints all immediate;
alter table public.contributions enable trigger guard_payment_environment;
alter table public.contributions enable trigger guard_live_payment_context;
alter table public.contributions enable trigger guard_paystack_context;
do $$ begin if public.live_payouts_enabled() then raise exception 'Automatic gate changed'; end if; end $$;
