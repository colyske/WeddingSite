begin;
do $$
declare owner_id uuid:=extensions.gen_random_uuid(); staff_id uuid:=extensions.gen_random_uuid();
  wid uuid:=extensions.gen_random_uuid();
begin
  if public.b2c_destination_ownership_verified(wid) then raise exception 'Ownership prerequisite must hard deny'; end if;
  if has_function_privilege('authenticated','public.b2c_reserve_reviewed_internal(uuid,uuid,uuid,text,text,text,boolean)','execute')
    or has_function_privilege('service_role','public.b2c_reserve_reviewed_internal(uuid,uuid,uuid,text,text,text,boolean)','execute') then
    raise exception 'Ownership prerequisite cannot be bypassed with internal reservation RPC'; end if;
  insert into auth.users(id,email,email_confirmed_at) values(owner_id,'colyske@gmail.com',now());
  perform public.bootstrap_protected_owner(owner_id);
  insert into auth.users(id) values(staff_id);
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform public.assign_platform_role(staff_id,'superadmin');
  begin
    perform public.staff_confirm_b2c_account_review(wid,'Synthetic account review');
    raise exception 'Owner must not confirm their own account review';
  exception when raise_exception then
    if sqlerrm not like 'B2C: A different SuperAdmin%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  begin
    perform public.b2c_reserve(extensions.gen_random_uuid(),extensions.gen_random_uuid(),extensions.gen_random_uuid(),
      repeat('a',64),'123456','BusinessPayment');
    raise exception 'Missing ownership process must prevent even reservation';
  exception when raise_exception then
    if sqlerrm not like 'B2C: Verified destination-ownership%' then raise; end if;
  end;
end $$;
rollback;
