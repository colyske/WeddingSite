-- Isolated local CI only; every fixture and side effect is rolled back.
begin;
create temporary table actors(kind text, id uuid);
grant select on actors to authenticated;
do $$
declare oid uuid := extensions.gen_random_uuid(); sid uuid := extensions.gen_random_uuid();
  aid uuid := extensions.gen_random_uuid(); cid uuid := extensions.gen_random_uuid(); wid uuid := extensions.gen_random_uuid();
begin
  insert into auth.users(id, email, email_confirmed_at) values(oid, 'colyske@gmail.com', now());
  perform public.bootstrap_protected_owner(oid);
  insert into auth.users(id) values(sid),(aid),(cid);
  update public.profiles set platform_role='superadmin' where id=sid;
  update public.profiles set platform_role='admin' where id=aid;
  insert into actors values('owner',oid),('superadmin',sid),('admin',aid),('client',cid),('wedding',wid);
  insert into public.weddings(id,client_owner_id,couple_names,currency,wedding_date)
    values(wid,cid,'Local boundary sample','KES',current_date+30);
  insert into public.wedding_memberships(wedding_id,user_id,role) values(wid,cid,'client');
  insert into public.contributions(wedding_id,stream_name,pledged_amount_minor,paid_amount_minor,
    platform_fee_minor,net_paid_minor,provider_fee_minor,provider_fee_pending,currency,payment_status,
    verified_provider_payment,funds_available_at)
    values(wid,'Simulated matured funds',100000,100000,8000,92000,3000,false,'KES','paid',true,now()-interval '10 days');
  insert into public.audit_events(wedding_id,source,action,table_name) values(wid,'user','local_boundary_fixture','weddings');
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare actor record; signature text; blocked boolean; count_rows integer; cid uuid; wid uuid;
begin
  select id into cid from actors where kind='client';
  select id into wid from actors where kind='wedding';
  for actor in select * from actors where kind in ('client','admin','superadmin','owner') loop
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    foreach signature in array array['admin_overview()', 'admin_settlement_overview()', 'admin_audit(1)',
      'admin_ledger(1)', 'admin_payouts()', 'admin_get_policies()', 'admin_get_refund_policy()',
      'admin_get_payment_controls()', 'admin_policy_history(1)'] loop
      blocked := false;
      begin execute 'select public.' || signature;
      exception when raise_exception then blocked := true; end;
      if blocked is distinct from (actor.kind in ('client','admin')) then
        raise exception 'Unexpected RPC authorization: % / %', actor.kind, signature;
      end if;
    end loop;
    blocked := false;
    begin perform public.admin_save_policies('{"publication_fee_minor":2500}');
    exception when raise_exception then blocked := true; end;
    if blocked is distinct from (actor.kind <> 'owner') then raise exception 'Owner-only fee policy regression'; end if;
    blocked := false;
    begin perform public.admin_set_refund_policy('manual_review',true);
    exception when raise_exception then blocked := true; end;
    if blocked is distinct from (actor.kind <> 'owner') then raise exception 'Owner-only refund policy regression'; end if;
    blocked := false;
    begin perform public.admin_set_payment_controls(array['paystack','daraja'],true);
    exception when raise_exception then blocked := true; end;
    if blocked is distinct from (actor.kind in ('client','admin')) then raise exception 'Provider controls boundary regression'; end if;
    if actor.kind = 'admin' then
      if exists(select 1 from public.admin_list_users() where platform_role not in ('client','admin')) then
        raise exception 'Support role list must not expose leadership';
      end if;
      if exists(select 1 from public.contributions) or exists(select 1 from public.platform_policies)
        or exists(select 1 from public.audit_events) then
        raise exception 'Direct RLS must not expose organization finance/policy/audit to regular Admin';
      end if;
      perform public.admin_list_weddings();
      perform public.admin_wedding_metrics(wid);
      perform public.admin_operations_queue();
    end if;
    update public.platform_policies set publication_fee_minor=publication_fee_minor+1;
    get diagnostics count_rows = row_count;
    if count_rows <> case when actor.kind='owner' then 1 else 0 end then
      raise exception 'Direct financial-policy UPDATE bypass';
    end if;
    if actor.kind in ('client','admin') then
      blocked := false;
      begin perform public.admin_set_role(cid,'admin');
      exception when raise_exception then blocked := true; end;
      if not blocked then raise exception 'Support/client role mutation must fail'; end if;
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub',(select id::text from actors where kind='superadmin'),true);
  perform public.admin_set_role(cid,'admin');
  perform public.admin_set_role(cid,'client');
  blocked := false;
  begin perform public.admin_set_role(cid,'superadmin');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'SuperAdmin must not promote a peer'; end if;
  blocked := false;
  begin perform public.assign_platform_role((select id from actors where kind='owner'),'client');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'SuperAdmin must not demote protected Owner'; end if;
  perform set_config('request.jwt.claim.sub',(select id::text from actors where kind='owner'),true);
  blocked := false;
  begin perform public.assign_platform_role(cid,'owner');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Owner identity cannot be assigned to another user'; end if;
  blocked := false;
  begin perform public.assign_platform_role(auth.uid(),'client');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Even Owner cannot self-demote'; end if;
  perform set_config('request.jwt.claim.sub',cid::text,true);
  if (select available_minor from public.withdrawable_balance(wid,'KES')) <> 0
    or (select settling_minor from public.withdrawable_balance(wid,'KES')) <> 0 then
    raise exception 'Matured test funds must never be withdrawable or settling real funds';
  end if;
end $$;
reset role;

do $$
declare wid uuid := (select id from actors where kind='wedding'); cid uuid := (select id from actors where kind='client');
  blocked boolean;
begin
  blocked := false;
  begin update public.contributions set payment_environment='live' where wedding_id=wid;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Relabelling test records as live must fail'; end if;
  blocked := false;
  begin insert into public.payout_records(wedding_id,amount_minor,currency,requested_by)
    values(wid,1000,'KES',cid);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Direct payout INSERT must reject simulated funds'; end if;
  blocked := false;
  begin update public.weddings set allow_in_kind_sponsorship=true where id=wid;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Old editor cannot enable in-kind solicitation'; end if;
  blocked := false;
  begin insert into public.sponsors(wedding_id,company_name,amount_minor,in_kind)
    values(wid,'Local in-kind sample',0,true);
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Direct in-kind sponsor insert must fail'; end if;
  blocked := false;
  begin insert into public.sponsor_enquiries(wedding_id,company_name,contact_name,contact_email,offer)
    values(wid,'Local sample','Sample','sample@example.com','Sample offer');
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Old guest tab must not create free/in-kind enquiries'; end if;
end $$;
rollback;
