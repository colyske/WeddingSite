-- Isolated manual-evidence prerequisites. No payment/provider operations.
begin;
create temporary table facilitator_funding_test_actors(kind text primary key, id uuid not null);
grant select on facilitator_funding_test_actors to authenticated;
create function pg_temp.assert_funding(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Facilitator funding regression: %',label; end if;
end $$;
grant execute on function pg_temp.assert_funding(boolean,text) to authenticated;

do $$
declare k text; u uuid;
begin
  foreach k in array array['owner','superadmin','admin','user'] loop
    u:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at)
      values(u,case when k='owner' then
        (select owner_email from public.protected_platform_owner where singleton)
        else k||'@example.test' end,now());
    insert into facilitator_funding_test_actors values(k,u);
    if k='owner' then perform public.bootstrap_protected_owner(u);
    elsif k in ('superadmin','admin') then
      update public.profiles set platform_role=k::public.platform_role where id=u;
    end if;
  end loop;
end $$;

do $$
declare role_name text; t text; sig text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach t in array array['facilitator_funding_attestations','facilitator_funding_attestation_checks'] loop
      perform pg_temp.assert_funding(not has_table_privilege(role_name,'public.'||t,'select')
        and not has_table_privilege(role_name,'public.'||t,'insert'),role_name||' cannot read or write '||t);
    end loop;
  end loop;
  foreach role_name in array array['anon','service_role'] loop
    foreach sig in array array[
      'facilitator_funding_attestation_create(uuid,text,uuid,timestamptz,timestamptz,timestamptz,bigint,bigint,bigint,bigint,uuid,text,boolean,boolean)',
      'facilitator_funding_attestation_check(uuid,boolean,boolean)',
      'facilitator_funding_attestations_list()'] loop
      perform pg_temp.assert_funding(not has_function_privilege(role_name,'public.'||sig,'execute'),
        role_name||' cannot execute '||sig);
    end loop;
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare key_id uuid:=extensions.gen_random_uuid(); scope_id uuid:=extensions.gen_random_uuid();
  evidence_id uuid:=extensions.gen_random_uuid(); created uuid; repeated uuid;
  start_at timestamptz:=now()-interval '2 days'; observed timestamptz:=now()-interval '1 hour';
  expiry timestamptz:=now()+interval '1 day'; blocked boolean; actor record; listing jsonb;
begin
  for actor in select * from facilitator_funding_test_actors loop
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    blocked:=false;
    begin
      perform public.facilitator_funding_attestations_list();
    exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_funding(blocked=(actor.kind not in ('owner','superadmin')),
      'list access '||actor.kind);
    if actor.kind<>'owner' then
      blocked:=false;
      begin
        perform public.facilitator_funding_attestation_create(key_id,'KES',scope_id,start_at,observed,expiry,
          10000,500,200,300,evidence_id,repeat('a',64),true,true);
      exception when raise_exception then blocked:=true; end;
      perform pg_temp.assert_funding(blocked,'create denied '||actor.kind);
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub',(select id::text from facilitator_funding_test_actors where kind='owner'),true);
  blocked:=false;
  begin
    perform public.facilitator_funding_attestation_create(key_id,'KES',scope_id,start_at,observed,expiry,
      10000,500,200,300,evidence_id,repeat('a',64),false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'exclusive custody assertion required');
  blocked:=false;
  begin
    perform public.facilitator_funding_attestation_create(key_id,'KES',scope_id,start_at,observed,now()+interval '8 days',
      10000,500,200,300,evidence_id,repeat('a',64),true,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'freshness bounded');
  created:=public.facilitator_funding_attestation_create(key_id,'KES',scope_id,start_at,observed,expiry,
    10000,500,200,300,evidence_id,repeat('a',64),true,true);
  repeated:=public.facilitator_funding_attestation_create(key_id,'KES',scope_id,start_at,observed,expiry,
    10000,500,200,300,evidence_id,repeat('a',64),true,true);
  perform pg_temp.assert_funding(created=repeated,'identical retry');
  blocked:=false;
  begin
    perform public.facilitator_funding_attestation_create(key_id,'USD',scope_id,start_at,observed,expiry,
      10000,500,200,300,evidence_id,repeat('a',64),true,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'changed retry denied');
  blocked:=false;
  begin perform public.facilitator_funding_attestation_check(created,false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'self check requires explicit solo');
  perform set_config('request.jwt.claim.sub',(select id::text from facilitator_funding_test_actors where kind='admin'),true);
  blocked:=false;
  begin perform public.facilitator_funding_attestation_check(created,false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'admin review denied');
  perform set_config('request.jwt.claim.sub',(select id::text from facilitator_funding_test_actors where kind='superadmin'),true);
  blocked:=false;
  begin perform public.facilitator_funding_attestation_check(created,true,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'only owner may select solo');
  perform pg_temp.assert_funding(public.facilitator_funding_attestation_check(created,false,true),'leader review');
  perform pg_temp.assert_funding(public.facilitator_funding_attestation_check(created,false,true),'review replay');
  listing:=public.facilitator_funding_attestations_list();
  perform pg_temp.assert_funding(listing->>'available_minor'='0' and listing->>'payouts_enabled'='false'
    and listing->>'manual_assertions_only'='true','review does not enable payout');
  perform set_config('request.jwt.claim.sub','',true);
  blocked:=false;
  begin perform public.facilitator_funding_attestations_list();
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'anonymous actor denied');
end $$;
reset role;

do $$
declare a public.facilitator_funding_attestations; blocked boolean;
begin
  select * into strict a from public.facilitator_funding_attestations;
  blocked:=false;
  begin update public.facilitator_funding_attestations set cash_minor=1 where id=a.id;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'attestation immutable');
  blocked:=false;
  begin delete from public.facilitator_funding_attestation_checks where attestation_id=a.id;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'review immutable');
end $$;

-- A historical observation can expire between creation and review.
insert into public.facilitator_funding_attestations(request_key,currency,custody_scope_reference,
  period_start,as_of,expires_at,cash_minor,unpaid_costs_minor,holds_minor,other_commitments_minor,
  exclusive_platform_funded_asserted,evidence_reference,evidence_sha256,recorded_by)
values(extensions.gen_random_uuid(),'KES',extensions.gen_random_uuid(),
  now()-interval '4 days',now()-interval '3 days',now()-interval '1 day',1,0,0,0,
  true,extensions.gen_random_uuid(),repeat('b',64),
  (select id from facilitator_funding_test_actors where kind='owner'));
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from facilitator_funding_test_actors where kind='owner'),true);
do $$
declare blocked boolean; stale_id uuid;
begin
  select (x->>'id')::uuid into stale_id from jsonb_array_elements(
    public.facilitator_funding_attestations_list()->'records') x where (x->>'stale')::boolean;
  perform pg_temp.assert_funding(stale_id is not null,'stale inventory exposed as stale');
  blocked:=false;
  begin perform public.facilitator_funding_attestation_check(stale_id,true,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_funding(blocked,'stale inventory cannot receive new review');
end $$;
reset role;
rollback;
