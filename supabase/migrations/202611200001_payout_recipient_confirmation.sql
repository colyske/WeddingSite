-- Private immutable payout evidence; never copy identity into events or receipts.
create table public.simple_payout_recipients (
  payout_id uuid primary key references public.simple_payout_requests(id),
  expected_name text not null check(length(btrim(expected_name)) between 2 and 120),
  phone text not null check(phone ~ '^(254[17][0-9]{8}|0[17][0-9]{8})$'),
  kyc_hash text not null,
  source text not null check(source in ('request_snapshot','unchanged_legacy_kyc')),
  captured_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['simple_payout_recipients'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger simple_payout_immutable before update or delete on public.%I
      for each row execute function public.manual_payout_immutable()',t);
  end loop;
end $$;

-- A legacy row is resolvable only from exact original full-row hash evidence.
-- No migration backfill and no substitution from edited KYC.
create function public.simple_payout_recipient(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('expected_name',s.expected_name,'phone',s.phone,'source',s.source)
      from public.simple_payout_recipients s where s.payout_id=p_id),
    (select jsonb_build_object(
      'expected_name',case r.partner_slot when 1 then k.partner1_legal_name else k.partner2_legal_name end,
      'phone',regexp_replace(case r.partner_slot when 1 then k.partner1_phone else k.partner2_phone end,'[^0-9]','','g'),
      'source','unchanged_legacy_kyc')
    from public.simple_payout_requests r join public.wedding_kyc k on k.wedding_id=r.wedding_id
    where r.id=p_id and r.kyc_hash=public.simple_payout_kyc_hash(r.wedding_id)
      and public.kyc_is_complete(r.wedding_id)
      and length(btrim(case r.partner_slot when 1 then k.partner1_legal_name else k.partner2_legal_name end)) between 2 and 120
      and regexp_replace(case r.partner_slot when 1 then k.partner1_phone else k.partner2_phone end,'[^0-9]','','g')
        ~ '^(254[17][0-9]{8}|0[17][0-9]{8})$'))
$$;
create function public.simple_payout_capture_recipient() returns trigger
language plpgsql security definer set search_path='' as $$
declare recipient jsonb;
begin
  perform 1 from public.wedding_kyc where wedding_id=new.wedding_id for share;
  select jsonb_build_object(
    'expected_name',case new.partner_slot when 1 then k.partner1_legal_name else k.partner2_legal_name end,
    'phone',regexp_replace(case new.partner_slot when 1 then k.partner1_phone else k.partner2_phone end,'[^0-9]','','g'))
    into recipient from public.wedding_kyc k where k.wedding_id=new.wedding_id
      and new.kyc_hash=public.simple_payout_kyc_hash(new.wedding_id) and public.kyc_is_complete(new.wedding_id);
  if recipient is null or coalesce(length(btrim(recipient->>'expected_name')),0) not between 2 and 120
    or coalesce(recipient->>'phone','') !~ '^(254[17][0-9]{8}|0[17][0-9]{8})$' then
    raise exception 'SIMPLE_PAYOUT: Original recipient cannot be established. Do not send.'; end if;
  insert into public.simple_payout_recipients(payout_id,expected_name,phone,kyc_hash,source)
    values(new.id,recipient->>'expected_name',recipient->>'phone',new.kyc_hash,'request_snapshot');
  return new;
end $$;
create trigger simple_payout_capture_recipient after insert on public.simple_payout_requests
  for each row execute function public.simple_payout_capture_recipient();

-- New clients bind consent to the displayed recipient version, without sending PII.
create function public.simple_payout_submit(p_key uuid,p_wedding uuid,p_amount bigint,p_partner integer,p_confirmed boolean,
  p_processing_fee bigint,p_policy_revision bigint,p_recipient_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior public.simple_payout_requests;
begin
  perform public.simple_payout_lock(p_wedding);
  if auth.uid() is null or not exists(select 1 from public.weddings where id=p_wedding and client_owner_id=auth.uid()) then
    raise exception 'SIMPLE_PAYOUT: Wedding owner access required.'; end if;
  select * into prior from public.simple_payout_requests where request_key=p_key;
  if p_recipient_hash is null or p_recipient_hash is distinct from
    case when prior.id is not null then prior.kyc_hash else public.simple_payout_kyc_hash(p_wedding) end then
    raise exception 'SIMPLE_PAYOUT: Recipient changed. Refresh and explicitly reconfirm the expected name and phone.'; end if;
  return public.simple_payout_submit(p_key,p_wedding,p_amount,p_partner,p_confirmed,p_processing_fee,p_policy_revision);
end $$;

do $$ declare definition text; updated text; begin
  definition:=pg_get_functiondef('public.simple_payout_action(uuid,uuid,text,text,bigint,text,boolean,boolean,boolean)'::regprocedure);
  updated:=replace(definition,'p_action not in (''reviewed'',''processing'') and p_recipient_confirmed',
    'p_action not in (''reviewed'',''processing'',''paid'') and p_recipient_confirmed');
  updated:=replace(updated,'select * into c from public.simple_payout_claims where payout_id=p_id;',
    'if p_action=''paid'' and not p_recipient_confirmed then
      raise exception ''SIMPLE_PAYOUT: Explicitly confirm the actual transaction recipient name matches the expected name. Otherwise Hold; do not resend and request reversal through the official provider.''; end if;
    select * into c from public.simple_payout_claims where payout_id=p_id;');
  updated:=replace(updated,'if p_action=''reviewed'' then',
    'if p_action in (''reviewed'',''processing'',''paid'') then
      if public.simple_payout_recipient(p_id) is null then
        raise exception ''SIMPLE_PAYOUT: Original recipient cannot be established. Do not send or mark Paid. Keep any claim/reservation on Hold; do not resend. Use official provider support for a completed transfer.''; end if;
      if exists(select 1 from public.simple_payout_events where payout_id=p_id and state=''hold'' and reason=''outcome_uncertain'') then
        raise exception ''SIMPLE_PAYOUT: Uncertain recipient/outcome remains on Hold. Do not resend or mark Paid. Request reversal through the official provider; reservation and claim remain retained.''; end if;
      insert into public.simple_payout_recipients(payout_id,expected_name,phone,kyc_hash,source)
        select p_id,j->>''expected_name'',j->>''phone'',r.kyc_hash,''unchanged_legacy_kyc''
        from public.simple_payout_recipient(p_id) j on conflict do nothing;
    end if;
    if p_action=''reviewed'' then');
  if updated=definition or position('Explicitly confirm the actual transaction recipient' in updated)=0
    or position('Uncertain recipient/outcome remains' in updated)=0 then raise exception 'Unexpected recipient action predecessor'; end if;
  execute updated;
  definition:=pg_get_functiondef('public.simple_payout_status(uuid)'::regprocedure);
  updated:=replace(definition,'''recipients'',jsonb_build_array(',
    '''recipient_hash'',public.simple_payout_kyc_hash(w.id),
    ''recipients'',jsonb_build_array(');
  updated:=replace(updated,'''slot'',1,''label'',','''slot'',1,''expected_name'',k.partner1_legal_name,''phone'',k.partner1_phone,''label'',');
  updated:=replace(updated,'''slot'',2,''label'',','''slot'',2,''expected_name'',k.partner2_legal_name,''phone'',k.partner2_phone,''label'',');
  updated:=replace(updated,'select r.id,r.processing_fee_minor',
    'select r.id,public.simple_payout_recipient(r.id) recipient,
      exists(select 1 from public.simple_payout_events where payout_id=r.id and state=''hold'' and reason=''outcome_uncertain'') recipient_outcome_held,
      r.processing_fee_minor');
  if updated=definition or position('recipient_outcome_held' in updated)=0 then raise exception 'Unexpected recipient status predecessor'; end if;
  execute updated;
end $$;
do $$ declare f record; begin
  for f in select oid,proname,pronargs from pg_proc where pronamespace='public'::regnamespace and proname in
    ('simple_payout_recipient','simple_payout_capture_recipient','simple_payout_submit') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.oid::regprocedure);
    if f.proname='simple_payout_submit' and f.pronargs=8 then
      execute format('grant execute on function %s to authenticated',f.oid::regprocedure); end if;
  end loop;
end $$;
