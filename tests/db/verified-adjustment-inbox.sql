-- Synthetic signed-observation fixtures; no provider calls and no retained data.
begin;
create temporary table inbox_actors(kind text primary key,id uuid not null);
grant select on inbox_actors to authenticated;
create function pg_temp.assert_inbox(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Adjustment inbox regression: %',label; end if; end $$;
grant execute on function pg_temp.assert_inbox(boolean,text) to service_role,authenticated;
do $$
declare k text; u uuid;
begin
  foreach k in array array['owner','superadmin','admin','user'] loop
    u:=extensions.gen_random_uuid();
    insert into auth.users(id,email,email_confirmed_at) values(u,
      case when k='owner' then (select owner_email from public.protected_platform_owner where singleton)
        else k||'@adjustment-inbox.example.test' end,now());
    insert into inbox_actors values(k,u);
    if k='owner' then perform public.bootstrap_protected_owner(u);
    elsif k in ('superadmin','admin') then
      update public.profiles set platform_role=k::public.platform_role where id=u;
    end if;
  end loop;
end $$;

do $$
declare role_name text; t text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach t in array array['verified_adjustment_inbox','verified_adjustment_inbox_conflicts',
      'verified_adjustment_inbox_processed','verified_adjustment_inbox_attempts'] loop
      perform pg_temp.assert_inbox(not has_table_privilege(role_name,'public.'||t,'select')
        and not has_table_privilege(role_name,'public.'||t,'insert'),role_name||' cannot access '||t);
    end loop;
  end loop;
  perform pg_temp.assert_inbox(not has_function_privilege('authenticated',
    'public.stage_verified_adjustment(text,text,text,text,text,bigint,text,text,timestamptz,text)','execute'),
    'users cannot stage verified observations');
  perform pg_temp.assert_inbox(not has_function_privilege('service_role',
    'public.verified_adjustment_inbox_clear_for_payout()','execute'),
    'payout readiness remains internal only');
end $$;

savepoint late_legacy_fixture;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare id uuid;
begin
  id:=(public.stage_verified_adjustment('paystack',repeat('c',64),'refund.pending',
    'legacy-late-refund','legacy-late-payment',100,'KES','refund_pending',null,repeat('c',64))->>'id')::uuid;
  perform pg_temp.assert_inbox((public.process_verified_adjustment(id)->>'processed')::boolean,
    'first legacy comparison fixture processed');
  perform public.record_provider_adjustment('paystack','legacy-lifecycle-fixture','refund.processed',
    'legacy-late-refund','legacy-late-payment',100,'KES','refund_processed',null);
end $$;
reset role;
select pg_temp.assert_inbox(public.verified_adjustment_inbox_clear_for_payout(),
  'compatible legacy lifecycle does not block readiness');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.record_provider_adjustment('paystack','legacy-conflict-fixture','refund.processed',
  'legacy-late-refund','legacy-late-payment',101,'KES','refund_processed',null);
reset role;
select pg_temp.assert_inbox(not public.verified_adjustment_inbox_clear_for_payout(),
  'late incompatible legacy observation blocks readiness after inbox processing');
rollback to savepoint late_legacy_fixture;

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare a jsonb; replay jsonb; id uuid; result jsonb; queue jsonb;
begin
  a:=public.stage_verified_adjustment('stripe','evt_inbox_fixture','refund.created','refund_fixture',
    'missing_payment_fixture',100,'KES','refund_pending',null,repeat('a',64));
  id:=(a->>'id')::uuid;
  replay:=public.stage_verified_adjustment('stripe','evt_inbox_fixture','refund.created','refund_fixture',
    'missing_payment_fixture',100,'KES','refund_pending',null,repeat('a',64));
  perform pg_temp.assert_inbox(id=(replay->>'id')::uuid and not (replay->>'conflict')::boolean,
    'identical observation replay');
  queue:=public.pending_verified_adjustments();
  perform pg_temp.assert_inbox(queue->'ids' @> to_jsonb(array[id]) and (queue->>'conflicts')::integer=0,
    'verified observation remains pending before processing');
  perform public.note_verified_adjustment_failure(id);
  perform pg_temp.assert_inbox(public.pending_verified_adjustments()->'ids' @> to_jsonb(array[id]),
    'failed attempt retains pending observation');
  result:=public.process_verified_adjustment(id);
  perform pg_temp.assert_inbox((result->>'processed')::boolean,'observation processed');
  perform pg_temp.assert_inbox((public.process_verified_adjustment(id)->>'replayed')::boolean,
    'processing replay is idempotent');
  perform pg_temp.assert_inbox(not (public.pending_verified_adjustments()->'ids' @> to_jsonb(array[id])),
    'processed observation removed from pending queue');
  replay:=public.stage_verified_adjustment('stripe','evt_inbox_fixture','refund.created','refund_fixture',
    'missing_payment_fixture',100,'KES','refund_pending',null,repeat('b',64));
  perform pg_temp.assert_inbox((replay->>'conflict')::boolean,'different payload creates permanent conflict');
  perform pg_temp.assert_inbox((public.process_verified_adjustment(id)->>'conflict')::boolean,
    'a late conflict is not silently treated as success');
  perform pg_temp.assert_inbox((public.pending_verified_adjustments()->>'conflicts')::integer=1,
    'conflicts are surfaced to worker');
end $$;
do $$
declare first_id uuid; second_id uuid; conflict_id uuid; result jsonb;
begin
  first_id:=(public.stage_verified_adjustment('paystack',repeat('1',64),'refund.pending',
    'paystack-refund','paystack-payment',100,'KES','refund_pending',null,repeat('1',64))->>'id')::uuid;
  perform pg_temp.assert_inbox((public.process_verified_adjustment(first_id)->>'processed')::boolean,
    'first Paystack observation recorded');
  second_id:=(public.stage_verified_adjustment('paystack',repeat('2',64),'refund.processed',
    'paystack-refund','paystack-payment',100,'KES','refund_processed',null,repeat('2',64))->>'id')::uuid;
  perform pg_temp.assert_inbox((public.process_verified_adjustment(second_id)->>'processed')::boolean,
    'legitimate Paystack lifecycle update is not a conflict');
  conflict_id:=(public.stage_verified_adjustment('paystack',repeat('3',64),'refund.processed',
    'paystack-refund','paystack-payment',101,'KES','refund_processed',null,repeat('3',64))->>'id')::uuid;
  result:=public.process_verified_adjustment(conflict_id);
  perform pg_temp.assert_inbox((result->>'conflict')::boolean and not (result->>'processed')::boolean,
    'different amount for the same Paystack adjustment is held');
end $$;
reset role;
select pg_temp.assert_inbox((select count(*)=1 and min(outcome)='unmatched'
  from public.provider_adjustment_events where provider_event_id='evt_inbox_fixture'),
  'exactly one original unmatched provider observation');
select pg_temp.assert_inbox(not public.verified_adjustment_inbox_clear_for_payout(),
  'an unresolved conflict blocks future facilitator payout readiness');
select pg_temp.assert_inbox((select count(*)=1 and min(conflict_kind)='changed_delivery'
  and min(adjustment_id)='refund_fixture' and min(payload_sha256)=repeat('b',64)
  from public.verified_adjustment_inbox_conflicts where conflict_kind='changed_delivery'),
  'conflicting normalized evidence remains available for investigation');
select pg_temp.assert_inbox(exists(select 1 from public.verified_adjustment_inbox_conflicts
  where conflict_kind='adjustment_identity_mismatch' and amount_minor=100),
  'Paystack conflicting identity preserves prior evidence');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
do $$
declare actor record; blocked boolean;
begin
  for actor in select * from inbox_actors loop
    perform set_config('request.jwt.claim.sub',actor.id::text,true);
    blocked:=false;
    begin
      perform public.admin_verified_adjustment_conflicts();
    exception when raise_exception then blocked:=true; end;
    perform pg_temp.assert_inbox(blocked=(actor.kind not in ('owner','superadmin')),
      'conflict review permission for '||actor.kind);
  end loop;
end $$;
reset role;
select pg_temp.assert_inbox((select count(*)=2 from public.audit_events
  where action='verified_adjustment_conflicts_read'
    and actor_id in (select id from inbox_actors where kind in ('owner','superadmin'))),
  'successful leadership reads are audited');
rollback;
