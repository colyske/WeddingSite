-- Standalone isolated local/CI fixture. Every change rolls back; no provider calls.
begin;
create temporary table recipient_test_values (name text primary key, id uuid not null);
grant select,insert,update on recipient_test_values to authenticated;
create function pg_temp.assert_recipient(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Facilitator recipient regression: %',label; end if;
end $$;
grant execute on function pg_temp.assert_recipient(boolean,text) to authenticated;

-- Models a trusted payout function: authenticated callers cannot execute either
-- internal function directly, and the original actor JWT is preserved.
create function pg_temp.trusted_recipient_details(p_user uuid,p_revision uuid) returns jsonb
language sql security definer set search_path='' as $$
  select public.facilitator_payout_recipient_details(p_user,p_revision)
$$;
grant execute on function pg_temp.trusted_recipient_details(uuid,uuid) to authenticated;

do $$
declare k text; u uuid;
begin
  foreach k in array array['owner','superadmin','admin','facilitator','other'] loop
    u:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at)
      values(u,case when k='owner' then (select owner_email from public.protected_platform_owner where singleton)
        else k||'@recipient.example.test' end,now());
    insert into recipient_test_values values(k,u);
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
    foreach t in array array['facilitator_recipient_versions','facilitator_recipient_evidence',
      'facilitator_recipient_checks','facilitator_recipient_audit'] loop
      perform pg_temp.assert_recipient(not has_table_privilege(role_name,'public.'||t,'select')
        and not has_table_privilege(role_name,'public.'||t,'insert'),
        'private table access denied: '||role_name||'/'||t);
    end loop;
    foreach sig in array array['facilitator_payout_recipient_ready(uuid,uuid)',
      'facilitator_payout_recipient_details(uuid,uuid)'] loop
      perform pg_temp.assert_recipient(not has_function_privilege(role_name,'public.'||sig,'execute'),
        'internal function access denied: '||role_name||'/'||sig);
    end loop;
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare
  person uuid:=(select id from recipient_test_values where name='facilitator');
  owner_id uuid:=(select id from recipient_test_values where name='owner');
  checker_id uuid:=(select id from recipient_test_values where name='superadmin');
  other_id uuid:=(select id from recipient_test_values where name='other');
  admin_id uuid:=(select id from recipient_test_values where name='admin');
  first_revision uuid; second_revision uuid; evidence_id uuid;
  detail jsonb; same jsonb; code text; blocked boolean;
begin
  perform set_config('request.jwt.claim.sub',person::text,true);
  blocked:=false;
  begin perform public.facilitator_recipient_submit(extensions.gen_random_uuid(),'Fixture Facilitator',
    '254700000003',true,'facilitator-mpesa-recipient-v1');
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'unregistered account cannot register recipient');
  code:=public.referral_set_consent(true,'client-referrals-v1')->>'code';
  blocked:=false;
  begin perform public.facilitator_recipient_submit(extensions.gen_random_uuid(),'Fixture Facilitator',
    '254700000003',false,'facilitator-mpesa-recipient-v1');
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'recipient consent required');
  same:=public.facilitator_recipient_submit('550e8400-e29b-41d4-a716-446655440001','Fixture Facilitator',
    '254700000003',true,'facilitator-mpesa-recipient-v1');
  first_revision:=(same->>'revision')::uuid;
  insert into recipient_test_values values('first_revision',first_revision);
  perform pg_temp.assert_recipient(same->>'status'='pending','registration is not implicit verification');
  same:=public.facilitator_recipient_submit('550e8400-e29b-41d4-a716-446655440001','Fixture Facilitator',
    '254700000003',true,'facilitator-mpesa-recipient-v1');
  perform pg_temp.assert_recipient((same->>'revision')::uuid=first_revision and (same->>'idempotent')::boolean,
    'registration retry is idempotent');
  detail:=public.facilitator_recipient_mine()->'recipient';
  perform pg_temp.assert_recipient(detail->>'full_name'='Fixture Facilitator' and detail->>'phone'='254700000003',
    'recipient can see their private details');
  blocked:=false;
  begin perform public.facilitator_recipient_workspace();
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'facilitator cannot access workspace');
  blocked:=false;
  begin perform pg_temp.trusted_recipient_details(person,first_revision);
  exception when insufficient_privilege then blocked:=true; end;
  perform pg_temp.assert_recipient(not blocked,'trusted caller can request own snapshot');
  perform pg_temp.assert_recipient(pg_temp.trusted_recipient_details(person,first_revision) is null,
    'unverified recipient cannot be used');

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  evidence_id:=public.facilitator_recipient_evidence_add(first_revision,extensions.gen_random_uuid(),repeat('a',64),true);
  blocked:=false;
  begin perform public.facilitator_recipient_verify(first_revision,evidence_id,false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'submitter cannot self-check without owner solo');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  blocked:=false;
  begin perform public.facilitator_recipient_verify(first_revision,evidence_id,false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'admin review denied');
  perform set_config('request.jwt.claim.sub',checker_id::text,true);
  blocked:=false;
  begin perform public.facilitator_recipient_verify(first_revision,evidence_id,true,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'superadmin cannot select owner solo');
  perform public.facilitator_recipient_verify(first_revision,evidence_id,false,true);
  perform public.facilitator_recipient_verify(first_revision,evidence_id,false,true);
  perform set_config('request.jwt.claim.sub',person::text,true);
  detail:=pg_temp.trusted_recipient_details(person,first_revision);
  perform pg_temp.assert_recipient(detail->>'expected_name'='Fixture Facilitator' and detail->>'phone'='254700000003',
    'facilitator receives their verified snapshot through trusted caller');
  perform public.referral_set_consent(false,'client-referrals-v1');
  perform pg_temp.assert_recipient(not (public.referral_validate_code(code)->>'valid')::boolean,
    'withdrawn referral code no longer validates');
  detail:=pg_temp.trusted_recipient_details(person,first_revision);
  perform pg_temp.assert_recipient(detail->>'phone'='254700000003'
    and public.facilitator_recipient_mine()->'recipient'->>'status'='verified',
    'withdrawing referral opt-in preserves verified recipient');
  perform set_config('request.jwt.claim.sub',other_id::text,true);
  blocked:=false;
  begin perform public.referral_capture(code);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'withdrawn referral code cannot be captured');
  blocked:=false;
  begin perform pg_temp.trusted_recipient_details(person,first_revision);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'other user cannot reveal private recipient through trusted caller');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  detail:=pg_temp.trusted_recipient_details(person,first_revision);
  perform pg_temp.assert_recipient(detail->>'expected_name'='Fixture Facilitator','leadership may reveal recipient');
  perform public.facilitator_recipient_workspace();

  perform set_config('request.jwt.claim.sub',person::text,true);
  same:=public.facilitator_recipient_submit('550e8400-e29b-41d4-a716-446655440002','Fixture Facilitator Updated',
    '254700000004',true,'facilitator-mpesa-recipient-v1');
  second_revision:=(same->>'revision')::uuid;
  insert into recipient_test_values values('second_revision',second_revision);
  perform pg_temp.assert_recipient(pg_temp.trusted_recipient_details(person,first_revision) is null,
    'new revision invalidates the previously checked destination');
  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  blocked:=false;
  begin perform public.facilitator_recipient_verify(first_revision,evidence_id,false,true);
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'stale revision cannot be verified');
  evidence_id:=public.facilitator_recipient_evidence_add(second_revision,extensions.gen_random_uuid(),repeat('b',64),true);
  perform public.facilitator_recipient_verify(second_revision,evidence_id,true,true);
  detail:=pg_temp.trusted_recipient_details(person,second_revision);
  perform pg_temp.assert_recipient(detail->>'phone'='254700000004','explicit Owner-solo evidence review');
  perform set_config('request.jwt.claim.sub',person::text,true);
  blocked:=false;
  begin perform count(*) from public.facilitator_recipient_versions;
  exception when insufficient_privilege then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'raw private recipient table is not directly readable');
end $$;

reset role;
do $$
declare person uuid:=(select id from recipient_test_values where name='facilitator');
  owner_id uuid:=(select id from recipient_test_values where name='owner');
  first_revision uuid:=(select id from recipient_test_values where name='first_revision');
  second_revision uuid:=(select id from recipient_test_values where name='second_revision');
  blocked boolean;
begin
  perform pg_temp.assert_recipient(public.facilitator_payout_recipient_ready(person,second_revision),
    'withdrawn account retains verified current recipient');
  perform pg_temp.assert_recipient(not public.facilitator_payout_recipient_ready(person,first_revision),
    'superseded revision not ready');
  perform pg_temp.assert_recipient(exists(select 1 from public.facilitator_recipient_audit
    where actor_id=person and revision_id=first_revision and action='self_reveal')
    and exists(select 1 from public.facilitator_recipient_audit
      where actor_id=person and revision_id=first_revision and action='payout_snapshot')
    and exists(select 1 from public.facilitator_recipient_audit
      where actor_id=owner_id and revision_id=first_revision and action='payout_snapshot')
    and exists(select 1 from public.facilitator_recipient_audit
      where actor_id=owner_id and revision_id=first_revision and action='owner_reveal'),
    'private reveals are audited');
  perform pg_temp.assert_recipient(exists(select 1 from public.facilitator_recipient_audit
    where actor_id=owner_id and revision_id=second_revision and action='verified')
    and exists(select 1 from public.facilitator_recipient_checks
      where revision_id=second_revision and checked_by=owner_id and owner_solo),
    'explicit solo verification is audited without storing PII');
  blocked:=false;
  begin update public.facilitator_recipient_versions set full_name='Changed' where revision_id=first_revision;
  exception when raise_exception then blocked:=true; end;
  perform pg_temp.assert_recipient(blocked,'recipient snapshots are immutable');
end $$;
rollback;
