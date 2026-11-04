-- Appended inside the existing isolated readiness fixture; all rows roll back.
create temporary table fee_test_ids(key text primary key,id uuid);
create function pg_temp.fee_payment(p_mode text default 'valid') returns uuid language plpgsql as $$
declare result uuid:=extensions.gen_random_uuid(); begin
  insert into public.contributions(id,wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,platform_fee_minor,net_paid_minor,
    currency,payment_status,verified_provider_payment,provider_fee_pending,provider_fee_minor,payment_environment,
    provider_name,paid_at,funds_available_at,provider_reference,settlement_route)
    values(result,(select id from mr_ids where key='wedding'),'Isolated fee evidence',2000,2000,100,1900,'KES',
      'paid',p_mode<>'unverified',true,null,case when p_mode='test' then 'test' else 'live' end,
      case when p_mode='other_provider' then 'paystack' else 'daraja' end,now(),now()+interval '3 days',result::text,
      case when p_mode='direct' then 'paystack_direct' else 'platform_wallet' end);
  return result;
end $$;
alter table public.contributions disable trigger guard_payment_environment;
alter table public.contributions disable trigger guard_live_payment_context;
alter table public.contributions disable trigger guard_paystack_context;
do $$ declare c uuid; k uuid:=extensions.gen_random_uuid(); a uuid; before_row jsonb; before_balance bigint; mode text; info jsonb;
begin
  c:=pg_temp.fee_payment();
  select to_jsonb(x)-array['provider_fee_minor','provider_fee_pending'] into before_row from public.contributions x where id=c;
  before_balance:=public.simple_payout_available((select id from mr_ids where key='wedding'));
  perform pg_temp.actor('maker');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,100,''transaction'',''FEE-TEST1'',false,true)',k,c),'Protected Owner');
  perform pg_temp.reject('select public.owner_payment_fee_workspace()','Protected Owner');
  perform pg_temp.actor('client');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,100,''transaction'',''FEE-TEST1'',false,true)',k,c),'Protected Owner');
  perform pg_temp.actor('admin');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,100,''transaction'',''FEE-TEST1'',false,true)',k,c),'Protected Owner');
  perform pg_temp.actor('owner');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,0,''transaction'',''FEE-TEST1'',false,true)',k,c),'Zero requires');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,1901,''transaction'',''FEE-TEST1'',false,true)',k,c),'fee cannot exceed');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,100,''transaction'',''254700000001'',false,true)',k,c),'non-sensitive');
  a:=public.owner_record_payment_fee(k,c,100,'transaction','FEE-TEST1',false,true);
  if a is distinct from public.owner_record_payment_fee(k,c,100,'transaction','FEE-TEST1',false,true) then raise exception 'Fee replay duplicated'; end if;
  perform pg_temp.reject(format('select public.owner_record_payment_fee(%L,%L,101,''transaction'',''FEE-TEST1'',false,true)',k,c),'Retry changed');
  perform pg_temp.reject(format('select public.owner_record_payment_fee(extensions.gen_random_uuid(),%L,101,''transaction'',''FEE-TEST2'',false,true)',c),'Known fees cannot');
  if before_row is distinct from (select to_jsonb(x)-array['provider_fee_minor','provider_fee_pending'] from public.contributions x where id=c)
    or not exists(select 1 from public.contributions where id=c and provider_fee_minor=100 and not provider_fee_pending)
    or public.simple_payout_available((select id from mr_ids where key='wedding'))<>before_balance then
    raise exception 'Fee attestation changed history or bypassed stored time hold'; end if;
  if not exists(select 1 from public.owner_payment_fee_attestations where id=a and actor_id=auth.uid() and fee_minor=100)
    or not exists(select 1 from public.audit_events where record_id=c::text and action='payment_fee_operator_attested' and actor_id=auth.uid()) then
    raise exception 'Missing immutable fee actor/audit'; end if;
  perform pg_temp.reject(format('update public.owner_payment_fee_attestations set fee_minor=0 where id=%L',a),'append-only');
  foreach mode in array array['test','unverified','other_provider','direct'] loop
    c:=pg_temp.fee_payment(mode);
    perform pg_temp.reject(format('select public.owner_record_payment_fee(extensions.gen_random_uuid(),%L,100,''statement'',''STMT-TEST1'',false,true)',c),'verified live KES');
  end loop;
  c:=pg_temp.fee_payment();
  -- Synthetic old paid time ensures only the unknown-fee exclusion is removed.
  update public.contributions set funds_available_at=now()-interval '1 day' where id=c;
  before_balance:=public.simple_payout_available((select id from mr_ids where key='wedding'));
  perform public.owner_record_payment_fee(extensions.gen_random_uuid(),c,0,'statement','STMT-ZERO1',true,true);
  if public.simple_payout_available((select id from mr_ids where key='wedding'))<>before_balance+1900 then
    raise exception 'Explicit actual zero was not applied exactly'; end if;
  info:=public.owner_payment_fee_workspace();
  if info::text like '%254700000001%' or info::text like '%partner1%' or info::text like '%provider_reference%' then
    raise exception 'Fee selectors exposed private recipient/provider context'; end if;
  insert into fee_test_ids values('known',c);
end $$;
set constraints all immediate;
alter table public.contributions enable trigger guard_payment_environment;
alter table public.contributions enable trigger guard_live_payment_context;
alter table public.contributions enable trigger guard_paystack_context;
set local role authenticated;
select pg_temp.actor('maker');
select pg_temp.reject('select public.owner_payment_fee_workspace()','Protected Owner');
select pg_temp.reject('select * from public.owner_payment_fee_attestations','permission denied');
reset role;
set local role service_role;
select pg_temp.reject('select public.owner_record_payment_fee(extensions.gen_random_uuid(),extensions.gen_random_uuid(),100,''statement'',''STMT-TEST1'',false,true)','permission denied');
reset role;
do $$ begin if public.live_payouts_enabled() then raise exception 'B2C gate changed'; end if; end $$;
