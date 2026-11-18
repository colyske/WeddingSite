-- Synthetic signed-observation fixtures; no provider calls and no retained data.
begin;
create function pg_temp.assert_inbox(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Adjustment inbox regression: %',label; end if; end $$;
grant execute on function pg_temp.assert_inbox(boolean,text) to service_role;

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
reset role;
select pg_temp.assert_inbox((select count(*)=1 and min(outcome)='unmatched'
  from public.provider_adjustment_events where provider_event_id='evt_inbox_fixture'),
  'exactly one original unmatched provider observation');
select pg_temp.assert_inbox(not public.verified_adjustment_inbox_clear_for_payout(),
  'an unresolved conflict blocks future facilitator payout readiness');
select pg_temp.assert_inbox((select count(*)=1 and min(conflict_kind)='changed_delivery'
  and min(adjustment_id)='refund_fixture' and min(payload_sha256)=repeat('b',64)
  from public.verified_adjustment_inbox_conflicts),
  'conflicting normalized evidence remains available for investigation');
rollback;
