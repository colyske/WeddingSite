-- The public wrappers remain unavailable while the manual model is hard off.
-- They make no provider calls and do not authorize any external transfer.
create function public.facilitator_manual_workspace() returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare item record; sources jsonb:='[]'::jsonb; requests jsonb; truncated boolean:=false;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payouts are not available.';
  end if;
  if auth.uid() is null then raise exception 'FACILITATOR_MANUAL_AUTH: Sign in required.'; end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for update;
  for item in
    select f.id from public.referral_contribution_policy p
    join public.referral_attributions a on a.wedding_id=p.wedding_id and a.referrer_id=auth.uid()
    join lateral (select * from public.referral_funding_reviews where contribution_id=p.contribution_id
      order by recorded_at desc,id desc limit 1) f on true
    join public.referral_funding_review_checks ch on ch.review_id=f.id
    where f.currency='KES' order by f.contribution_id
    limit 101
  loop
    if jsonb_array_length(sources)>=100 then
      truncated:=true;
      exit;
    end if;
    begin
      sources:=sources||jsonb_build_array(public.facilitator_manual_source_quote_internal(item.id,'KES'));
    exception when raise_exception then
      if sqlerrm not like 'FACILITATOR_MANUAL_HOLD:%' then raise; end if;
      sources:=sources||jsonb_build_array(jsonb_build_object('review_id',item.id,'currency','KES',
        'held',true,'reason',substring(sqlerrm from length('FACILITATOR_MANUAL_HOLD:')+1)));
    end;
  end loop;
  select coalesce(jsonb_agg(public.facilitator_manual_status_internal(r.id) order by r.created_at desc),'[]'::jsonb)
    into requests from public.facilitator_manual_requests r where r.user_id=auth.uid();
  return jsonb_build_object('sources',sources,'sources_truncated',truncated,'requests',requests);
end $$;

create function public.facilitator_manual_submit(p_key uuid,p_recipient uuid,p_review uuid,p_amount bigint,p_confirmed boolean)
returns uuid language plpgsql security definer set search_path='' set row_security=off as $$
begin
  return public.facilitator_manual_request_internal(p_key,p_recipient,'KES',p_amount,
    jsonb_build_array(jsonb_build_object('review',p_review,'amount',p_amount::text)),p_confirmed);
end $$;

create function public.facilitator_manual_staff_workspace() returns jsonb
language plpgsql volatile security definer set search_path='' set row_security=off as $$
declare rows jsonb;
begin
  if not public.facilitator_manual_enabled() then
    raise exception 'FACILITATOR_MANUAL_DISABLED: Manual payouts are not available.';
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'FACILITATOR_MANUAL_CONFLICT: READ COMMITTED is required.';
  end if;
  perform pg_advisory_xact_lock(71110001);
  perform pg_advisory_xact_lock(71110002);
  perform 1 from public.profiles where id=auth.uid() for share;
  perform public.require_staff('admin');
  select coalesce(jsonb_agg(public.facilitator_manual_status_internal(r.id)
    || jsonb_build_object('created_at',r.created_at,'sender_id',c.sender_id,'incidents',
      (select coalesce(jsonb_agg(jsonb_build_object('id',i.id::text,
        'reviewed',exists(select 1 from public.facilitator_manual_incident_reviews x where x.incident_id=i.id),
        'evidence',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'submitted_by',e.submitted_by,
          'external_reference',e.external_reference,'sha256',e.sha256)
          order by e.submitted_at),'[]'::jsonb) from public.facilitator_manual_incident_evidence e where e.incident_id=i.id))
        order by i.id),'[]'::jsonb) from public.facilitator_manual_incidents i where i.request_id=r.id))
    order by r.created_at desc),'[]'::jsonb) into rows
    from public.facilitator_manual_requests r
    left join public.facilitator_manual_claims c on c.request_id=r.id;
  return rows;
end $$;

create function public.facilitator_manual_staff_action(p_request uuid,p_key uuid,p_action text,p_reason text,
  p_fee bigint,p_reference text,p_owner_solo boolean,p_confirmed boolean) returns jsonb
language sql volatile security definer set search_path='' set row_security=off as $$
  select public.facilitator_manual_action_internal(p_request,p_key,p_action,p_reason,p_fee,p_reference,p_owner_solo,p_confirmed)
$$;

create function public.facilitator_manual_sender_snapshot(p_request uuid) returns jsonb
language sql volatile security definer set search_path='' set row_security=off as $$
  select public.facilitator_manual_claim_snapshot_internal(p_request)
$$;

create function public.facilitator_manual_sender_current(p_request uuid) returns jsonb
language sql volatile security definer set search_path='' set row_security=off as $$
  select public.facilitator_manual_sender_current_internal(p_request)
$$;

create function public.facilitator_manual_incident_evidence_add(
  p_incident bigint,p_key uuid,p_reference uuid,p_sha256 text,p_confirmed boolean) returns uuid
language sql volatile security definer set search_path='' set row_security=off as $$
  select public.facilitator_manual_incident_evidence_internal(p_incident,p_key,p_reference,p_sha256,p_confirmed)
$$;

create function public.facilitator_manual_incident_review(
  p_incident bigint,p_evidence uuid,p_owner_solo boolean,p_confirmed boolean) returns boolean
language sql volatile security definer set search_path='' set row_security=off as $$
  select public.facilitator_manual_incident_review_internal(p_incident,p_evidence,p_owner_solo,p_confirmed)
$$;

revoke all on function public.facilitator_manual_workspace(),
  public.facilitator_manual_submit(uuid,uuid,uuid,bigint,boolean),
  public.facilitator_manual_staff_workspace(),
  public.facilitator_manual_staff_action(uuid,uuid,text,text,bigint,text,boolean,boolean),
  public.facilitator_manual_sender_snapshot(uuid),public.facilitator_manual_sender_current(uuid),
  public.facilitator_manual_incident_evidence_add(bigint,uuid,uuid,text,boolean),
  public.facilitator_manual_incident_review(bigint,uuid,boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.facilitator_manual_workspace(),
  public.facilitator_manual_submit(uuid,uuid,uuid,bigint,boolean),
  public.facilitator_manual_staff_workspace(),
  public.facilitator_manual_staff_action(uuid,uuid,text,text,bigint,text,boolean,boolean),
  public.facilitator_manual_sender_snapshot(uuid),public.facilitator_manual_sender_current(uuid),
  public.facilitator_manual_incident_evidence_add(bigint,uuid,uuid,text,boolean),
  public.facilitator_manual_incident_review(bigint,uuid,boolean,boolean) to authenticated;
